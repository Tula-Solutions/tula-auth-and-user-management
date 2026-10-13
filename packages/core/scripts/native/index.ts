/**
 * The generated sources of the native SDKs: Swift and Kotlin types of the client API, the
 * contract's error codes and its default theme (ADR 0050).
 *
 * Types and constants only. Nothing here writes a request, a session, a store or a flow: what
 * has behaviour is written by hand in each SDK.
 */
import type { OpenApiDocument } from '../openapi-types'
import type { ErrorDefinitions, ThemeSource } from './constants'
import {
  KOTLIN_PACKAGE,
  renderKotlinErrorCodes,
  renderKotlinOperations,
  renderKotlinSchemas,
  renderKotlinSupport,
  renderKotlinTheme,
} from './kotlin'
import { buildModel } from './model'
import {
  renderSwiftErrorCodes,
  renderSwiftOperations,
  renderSwiftSchemas,
  renderSwiftSupport,
  renderSwiftTheme,
} from './swift'

/** The Swift target the generated sources belong to. */
export const SWIFT_TARGET = 'TulaAuth'

/** Where the generated Swift sources are, from the repository's root. Holds nothing else. */
export const SWIFT_DIRECTORY = `native/swift/Sources/${SWIFT_TARGET}/Generated`

/** The Kotlin module the generated sources belong to. */
export const KOTLIN_MODULE = 'tula-auth'

/** Where the generated Kotlin sources are, from the repository's root. Holds nothing else. */
export const KOTLIN_DIRECTORY = `native/android/${KOTLIN_MODULE}/src/main/kotlin/${KOTLIN_PACKAGE.replaceAll('.', '/')}`

/** What the generated sources are written from. */
export interface NativeSources {
  /** The OpenAPI document (`packages/contract/openapi.json`). */
  readonly document: OpenApiDocument
  /** The contract's `ERROR_DEFINITIONS`. */
  readonly errorDefinitions: ErrorDefinitions
  /** The contract's `DEFAULT_THEME` and `THEME_TOKENS`. */
  readonly theme: ThemeSource
}

/**
 * Every generated file of the native SDKs, as text.
 *
 * A pure function: the same sources give the same files, byte for byte. Declarations are in
 * order of name and operations in order of id; the members of one declaration keep the order
 * the document or the contract gives them.
 *
 * @param sources - The OpenAPI document and the contract's error codes and theme.
 * @returns The files' texts by their path from the repository's root, in order of path.
 * @throws Error when the document uses a shape the generator does not map, when two
 *   declarations or two members would get the same name, when the document's error codes are
 *   not the contract's, or when a default theme value does not pass the theme grammar.
 *
 * @example
 * ```ts
 * const files = renderNativeFiles({
 *   document: await Bun.file('packages/contract/openapi.json').json(),
 *   errorDefinitions: ERROR_DEFINITIONS,
 *   theme: { theme: DEFAULT_THEME, tokens: THEME_TOKENS },
 * })
 * ```
 */
export function renderNativeFiles(sources: NativeSources): Record<string, string> {
  const model = buildModel(sources.document, Object.keys(sources.errorDefinitions))
  const files: [string, string][] = [
    [`${SWIFT_DIRECTORY}/ErrorCodes.swift`, renderSwiftErrorCodes(sources.errorDefinitions)],
    [`${SWIFT_DIRECTORY}/Operations.swift`, renderSwiftOperations(model)],
    [`${SWIFT_DIRECTORY}/Schemas.swift`, renderSwiftSchemas(model)],
    [`${SWIFT_DIRECTORY}/Support.swift`, renderSwiftSupport()],
    [`${SWIFT_DIRECTORY}/Theme.swift`, renderSwiftTheme(sources.theme)],
    [`${KOTLIN_DIRECTORY}/ErrorCodes.kt`, renderKotlinErrorCodes(sources.errorDefinitions)],
    [`${KOTLIN_DIRECTORY}/Operations.kt`, renderKotlinOperations(model)],
    [`${KOTLIN_DIRECTORY}/Schemas.kt`, renderKotlinSchemas(model)],
    [`${KOTLIN_DIRECTORY}/Support.kt`, renderKotlinSupport()],
    [`${KOTLIN_DIRECTORY}/Theme.kt`, renderKotlinTheme(sources.theme)],
  ]
  return Object.fromEntries(files.sort(([a], [b]) => (a < b ? -1 : 1)))
}

/**
 * What differs between the generated files and a directory tree: a file that is missing or
 * out of date, and anything in a generated directory that the generator does not write.
 *
 * @param files - The generated files, by path.
 * @param existing - What is on disk in the generated directories, by path: a file's text, or
 *   `null` for what is not a regular file (a directory, a symbolic link).
 * @returns One line per difference, empty when the tree is up to date.
 *
 * @example
 * ```ts
 * nativeDrift({ 'a/X.swift': 'new' }, { 'a/X.swift': 'old' }) // ['a/X.swift is out of date']
 * ```
 */
export function nativeDrift(
  files: Readonly<Record<string, string>>,
  existing: Readonly<Record<string, string | null>>
): string[] {
  const problems: string[] = []
  for (const [path, text] of Object.entries(files)) {
    if (!Object.hasOwn(existing, path)) {
      problems.push(`${path} is missing`)
    } else if (existing[path] === null) {
      problems.push(`${path} is not a file`)
    } else if (existing[path] !== text) {
      problems.push(`${path} is out of date`)
    }
  }
  for (const path of Object.keys(existing)) {
    if (!Object.hasOwn(files, path)) {
      problems.push(`${path} is not a generated file`)
    }
  }
  return problems.sort()
}
