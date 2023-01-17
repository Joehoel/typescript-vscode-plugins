import { GetConfig } from './types'
import { findChildContainingExactPosition } from './utils'
import { join } from 'path-browserify'

export default (proxy: ts.LanguageService, info: ts.server.PluginCreateInfo, c: GetConfig) => {
    proxy.getDefinitionAndBoundSpan = (fileName, position) => {
        const prior = info.languageService.getDefinitionAndBoundSpan(fileName, position)
        if (!prior) {
            const program = info.languageService.getProgram()!
            const sourceFile = program.getSourceFile(fileName)!
            const node = findChildContainingExactPosition(sourceFile, position)
            if (node && ts.isStringLiteral(node)) {
                const textSpanStart = node.pos + node.getLeadingTriviaWidth() + 1 // + 1 for quote
                const textSpan = {
                    start: textSpanStart,
                    length: node.end - textSpanStart - 1,
                }
                if (c('enableFileDefinitions') && ['./', '../'].some(str => node.text.startsWith(str))) {
                    const file = join(fileName, '..', node.text)
                    if (info.languageServiceHost.fileExists?.(file)) {
                        return {
                            textSpan,
                            definitions: [
                                {
                                    containerKind: undefined as any,
                                    containerName: '',
                                    name: '',
                                    fileName: file,
                                    textSpan: { start: 0, length: 0 },
                                    kind: ts.ScriptElementKind.moduleElement,
                                    contextSpan: { start: 0, length: 0 },
                                },
                            ],
                        }
                    }
                }

                // thoughts about type definition: no impl here, will be simpler to do this in core
                if (ts.isCallExpression(node.parent)) {
                    const parameterIndex = node.parent.arguments.indexOf(node)
                    const typeChecker = program.getTypeChecker()
                    const type = typeChecker.getContextualType(node.parent.expression) ?? typeChecker.getTypeAtLocation(node.parent.expression)
                    // todo handle union
                    if (type) {
                        const getDefinitionsFromKeyofType = (object: ts.Type) => {
                            const origin = object['origin'] as ts.Type | undefined
                            // handle union of type?
                            if (!origin?.isIndexType() || !(origin.type.flags & ts.TypeFlags.Object)) return
                            const properties = origin.type.getProperties()
                            const interestedMember = properties?.find(property => property.name === node.text)
                            if (interestedMember) {
                                const definitions = (interestedMember.getDeclarations() ?? []).map((declaration: ts.Node) => {
                                    const fileName = declaration.getSourceFile().fileName
                                    if (ts.isPropertySignature(declaration)) declaration = declaration.name
                                    const start = declaration.pos + declaration.getLeadingTriviaWidth()
                                    return {
                                        containerKind: undefined as any,
                                        containerName: '',
                                        name: '',
                                        fileName,
                                        textSpan: { start: start, length: declaration.end - start },
                                        kind: ts.ScriptElementKind.memberVariableElement,
                                        contextSpan: { start: 0, length: 0 },
                                    }
                                })
                                return {
                                    textSpan,
                                    definitions,
                                }
                            }
                            return
                        }
                        // todo handle unions and string literal
                        const sig = type.getCallSignatures()[0]
                        const param = sig?.getParameters()[parameterIndex]
                        const argType = param && typeChecker.getTypeOfSymbolAtLocation(param, node)
                        if (argType) {
                            const definitions = getDefinitionsFromKeyofType(argType)
                            if (definitions) {
                                return definitions
                            }

                            if (argType.flags & ts.TypeFlags.TypeParameter) {
                                const param = argType as ts.TypeParameter
                                const constraint = param.getConstraint()
                                if (constraint) {
                                    return getDefinitionsFromKeyofType(constraint)
                                }
                            }
                        }
                    }
                }
            }
            return
        }

        if (__WEB__) {
            // let extension handle it
            // TODO failedAliasResolution
            prior.definitions = prior.definitions?.filter(def => {
                return !def.unverified || def.fileName === fileName
            })
        }

        // used after check
        const firstDef = prior.definitions![0]!
        if (
            c('changeDtsFileDefinitionToJs') &&
            prior.definitions?.length === 1 &&
            // default, namespace import or import path click
            firstDef.containerName === '' &&
            firstDef.name.slice(1, -1) === firstDef.fileName.slice(0, -'.d.ts'.length) &&
            firstDef.fileName.endsWith('.d.ts')
        ) {
            const jsFileName = `${firstDef.fileName.slice(0, -'.d.ts'.length)}.js`
            const isJsFileExist = info.languageServiceHost.fileExists?.(jsFileName)
            if (isJsFileExist) prior.definitions = [{ ...firstDef, fileName: jsFileName }]
        }
        if (c('miscDefinitionImprovement') && prior.definitions?.length === 2) {
            prior.definitions = prior.definitions.filter(({ fileName, containerName }) => {
                const isFcDef = fileName.endsWith('node_modules/@types/react/index.d.ts') && containerName === 'FunctionComponent'
                return !isFcDef
            })
            // 11
        }

        if (
            c('removeModuleFileDefinitions') &&
            prior.definitions?.length === 1 &&
            firstDef.kind === ts.ScriptElementKind.moduleElement &&
            firstDef.name.slice(1, -1).startsWith('*.')
        ) {
            return
        }

        return prior
    }
}
