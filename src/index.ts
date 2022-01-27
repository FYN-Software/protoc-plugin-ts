import { Options, parseInput } from './option.js';
import { FileDescriptorProto, ServiceDescriptorProto } from './compiler/descriptor.js';
import { createEnum, createMessage, createNamespace } from './descriptor.js';
import { preprocess, resetDependencyMap, setIdentifierForDependency } from './type.js';
import {
    factory,
    createPrinter,
    NewLineKind,
    NodeFlags,
    SyntaxKind,
    ClassDeclaration,
    Identifier,
    ImportDeclaration,
    InterfaceDeclaration,
    Statement,
} from 'typescript';
import { readFileSync } from 'fs';
import { CodeGeneratorRequest, CodeGeneratorResponse, Version } from './compiler/plugin.js';
import { dirname, relative } from 'path';

interface Rpc
{
    createServiceClient?(
        rootDescriptor: FileDescriptorProto,
        serviceDescriptor: ServiceDescriptorProto,
        grpcIdentifier: Identifier,
        options: Options,
    ): ClassDeclaration;
    createUnimplementedServer?(
        rootDescriptor: FileDescriptorProto,
        serviceDescriptor: ServiceDescriptorProto,
        grpcIdentifier: Identifier,
    ): ClassDeclaration;
    createGrpcInterfaceType?(grpcIdentifier: Identifier): InterfaceDeclaration[];
    wrapInNamespace?(rootDescriptor: FileDescriptorProto): boolean;
}

function createImport(identifier: Identifier, moduleSpecifier: string): ImportDeclaration
{
    return factory.createImportDeclaration(
        undefined,
        undefined,
        factory.createImportClause(
            false,
            factory.createNamespaceImport(identifier) as any,
            undefined,
        ),
        factory.createStringLiteral(moduleSpecifier),
    );
}

function createComment(fileDescriptor: FileDescriptorProto, { major = 0, minor = 0, patch = 0 }: Version): Statement
{
    return factory.createJSDocComment(
        `Generated by @fyn-software/protoc-plugin-ts. DO NOT EDIT!\n` +
        `compiler version: ${major}.${minor}.${patch}\n` +
        `source: ${fileDescriptor.name}\n` +
        `git: https://github.com/fyn-software/protoc-plugin-ts\n`,
    ) as Statement;
}

function replaceExtension(filename: string, extension: string = '.ts'): string
{
    return filename.replace(/\.[^/.]+$/, extension);
}

// Grab input in form of grpc request
const request = CodeGeneratorRequest.deserialize(new Uint8Array(readFileSync(0)));

async function main()
{
    // Prepare static data
    const pbIdentifier = factory.createUniqueName('pb');
    const grpcIdentifier = factory.createUniqueName('grpc');
    const printer = createPrinter({
        newLine: NewLineKind.LineFeed,
        omitTrailingSemicolon: true,
    });
    const options = parseInput(request.parameter);
    const {
        createGrpcInterfaceType,
        createUnimplementedServer,
        createServiceClient,
        wrapInNamespace,
    }: Rpc = await import(`./style/${options.style}/rpc.js`);

    for (const protoFile of request.proto_file)
    {
        preprocess(protoFile, protoFile.name, `.${protoFile.package ?? ''}`);
    }

    // Create typescript files based on each given proto file
    const response = new CodeGeneratorResponse({
        file: request.proto_file.map(file => {
            // Create all messages recursively
            const statements: Statement[] = [
                // Process enums
                ...file.enum_type.map(enumDescriptor => createEnum(enumDescriptor)),

                // Process messages
                ...file.message_type.flatMap(message => createMessage(file, message, pbIdentifier)),

                // Create interfaces
                ...(createGrpcInterfaceType?.(grpcIdentifier) ?? []),

                // Create services and clients
                ...file.service.flatMap(service => [
                    createUnimplementedServer?.(file, service, grpcIdentifier),
                    createServiceClient?.(file, service, grpcIdentifier, options),
                ].filter(c => c !== undefined) as ClassDeclaration[]),
            ];

            resetDependencyMap();

            return new CodeGeneratorResponse.File({
                name: replaceExtension(file.name),
                content: printer.printFile(factory.createSourceFile(
                    [
                        // Create top "content is generated" comment
                        createComment(file, request.compiler_version),

                        // Create proto imports
                        ...file.dependency.map(dependency => {
                            const identifier = factory.createUniqueName(`dependency`);

                            setIdentifierForDependency(dependency, identifier);

                            return createImport(
                                identifier,
                                `./${relative(dirname(file.name), replaceExtension(dependency, ''))}`,
                            );
                        }),

                        // Create default imports
                        createImport(pbIdentifier, 'google-protobuf'),
                        createImport(grpcIdentifier, options.grpc_package),

                        // Add statements
                        ...(wrapInNamespace?.(file) ?? false
                                ? [ createNamespace(file.package, statements) ]
                                : statements
                        ),
                    ],
                    factory.createToken(SyntaxKind.EndOfFileToken),
                    NodeFlags.None,
                )),
            });
        }),
    });

    process.stdout.write(response.serialize());
}

main();
