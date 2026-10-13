import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { ERROR_DEFINITIONS } from '@tula-tech/contract/error-codes'
import { DEFAULT_THEME, THEME_TOKENS } from '@tula-tech/contract/theme'
import type { OpenApiDocument } from '../openapi-types'
import { fixture, SAMPLE_SCHEMAS } from './fixture'
import {
  KOTLIN_DIRECTORY,
  KOTLIN_MODULE,
  type NativeSources,
  nativeDrift,
  renderNativeFiles,
  SWIFT_DIRECTORY,
  SWIFT_TARGET,
} from './index'
import { GENERATED_HEADER } from './names'

const document = (await Bun.file(
  join(import.meta.dir, '../../../contract/openapi.json')
).json()) as OpenApiDocument

const real: NativeSources = {
  document,
  errorDefinitions: ERROR_DEFINITIONS,
  theme: { theme: DEFAULT_THEME, tokens: THEME_TOKENS },
}
const files = renderNativeFiles(real)

/** The text of one generated file of the real document. */
function file(path: string): string {
  const text = files[path]
  if (text === undefined) {
    throw new Error(`no generated file ${path}`)
  }
  return text
}

const swift = (name: string) => file(`${SWIFT_DIRECTORY}/${name}.swift`)
const kotlin = (name: string) => file(`${KOTLIN_DIRECTORY}/${name}.kt`)

/** The declaration that starts with `start`, up to the next line that closes one. */
function declaration(text: string, start: string): string {
  const from = text.indexOf(start)
  if (from < 0) {
    throw new Error(`no declaration starts with: ${start}`)
  }
  return text.slice(from, text.indexOf('\n}\n', from) + 3)
}

describe('where the generated files go', () => {
  test('two directories that hold nothing else, one per language', () => {
    expect(SWIFT_TARGET).toBe('TulaAuth')
    expect(SWIFT_DIRECTORY).toBe('native/swift/Sources/TulaAuth/Generated')
    expect(KOTLIN_MODULE).toBe('tula-auth')
    expect(KOTLIN_DIRECTORY).toBe(
      'native/android/tula-auth/src/main/kotlin/dev/tula/auth/generated'
    )
  })

  test('the same five files for each language, in order of path', () => {
    expect(Object.keys(files)).toEqual([
      `${KOTLIN_DIRECTORY}/ErrorCodes.kt`,
      `${KOTLIN_DIRECTORY}/Operations.kt`,
      `${KOTLIN_DIRECTORY}/Schemas.kt`,
      `${KOTLIN_DIRECTORY}/Support.kt`,
      `${KOTLIN_DIRECTORY}/Theme.kt`,
      `${SWIFT_DIRECTORY}/ErrorCodes.swift`,
      `${SWIFT_DIRECTORY}/Operations.swift`,
      `${SWIFT_DIRECTORY}/Schemas.swift`,
      `${SWIFT_DIRECTORY}/Support.swift`,
      `${SWIFT_DIRECTORY}/Theme.swift`,
    ])
  })

  test('every file says, at its top, that a value of its types is never logged or printed', () => {
    // A generated struct or data class prints every property it has (`\(value)`, `toString()`),
    // and some of those are refresh tokens, passwords and attempt secrets. The sentence is in
    // the header because that is the one place every reader of every file passes.
    const sentence =
      '// A value of these types may hold tokens, passwords and attempt secrets: never log, print or interpolate one.'
    for (const path of [`${SWIFT_DIRECTORY}/Schemas.swift`, `${KOTLIN_DIRECTORY}/Schemas.kt`]) {
      expect({ path, line: file(path).split('\n')[2] }).toEqual({ path, line: sentence })
    }
    for (const [path, text] of Object.entries(files)) {
      expect({ path, line: text.split('\n')[2] }).toEqual({ path, line: sentence })
    }
  })

  test('every file starts with the header and ends with one line break', () => {
    expect(GENERATED_HEADER).toContain('bun run native:generate')
    expect(GENERATED_HEADER).toContain('Do not edit')
    for (const [path, text] of Object.entries(files)) {
      expect({ path, header: text.startsWith(`${GENERATED_HEADER}\n`) }).toEqual({
        path,
        header: true,
      })
      expect({ path, end: /[^\n]\n$/.test(text) }).toEqual({ path, end: true })
    }
  })

  test('a file holds no tab, no trailing space, no carriage return and nothing but ASCII', () => {
    for (const [path, text] of Object.entries(files)) {
      // Whatever the document or the contract holds, a character outside ASCII is written
      // as an escape: nothing a reader cannot see can be in a generated source.
      const odd = text.split('\n').filter((line) => /\t|\r| $|[^\x20-\x7e]/.test(line))
      expect({ path, odd }).toEqual({ path, odd: [] })
    }
  })
})

describe('the output is a function of its sources', () => {
  test('rendering twice gives the same bytes', () => {
    expect(renderNativeFiles(real)).toEqual(files)
  })

  test('the order of the components and of the paths in the document changes nothing', () => {
    const reversed = <T>(record: Record<string, T>) =>
      Object.fromEntries(Object.entries(record).reverse())
    const shuffled: OpenApiDocument = {
      ...document,
      paths: reversed(document.paths ?? {}),
      components: { ...document.components, schemas: reversed(document.components?.schemas ?? {}) },
    }
    expect(renderNativeFiles({ ...real, document: shuffled })).toEqual(files)
  })

  test('the sources are not changed by rendering', () => {
    const before = JSON.stringify(document)
    renderNativeFiles(real)
    expect(JSON.stringify(document)).toBe(before)
  })
})

describe('what the real document gives', () => {
  test('the flow step union, with a case per status and one for a status nobody knows yet', () => {
    const statuses = [
      'needs_identifier',
      'needs_password',
      'needs_first_factor',
      'needs_email_verification',
      'needs_new_password',
      'needs_second_factor',
      'needs_factor_enrolment',
      'complete',
    ]
    const swiftStep = declaration(swift('Schemas'), 'public enum FlowStep:')
    const kotlinStep = declaration(kotlin('Schemas'), 'object FlowStepSerializer')
    for (const status of statuses) {
      expect(swiftStep).toContain(`        case "${status}": self = .`)
      expect(kotlinStep).toContain(`            "${status}" -> FlowStep.`)
    }
    expect(swiftStep.match(/^ {8}case "/gm)?.length).toBe(statuses.length)
    expect(swiftStep).toContain('    case unknown(status: String, raw: TulaJSONValue)')
    expect(swiftStep).toContain(
      '        default: self = .unknown(status: tag, raw: try TulaJSONValue(from: decoder))'
    )
    expect(kotlinStep).toContain('            else -> FlowStep.Unknown(tag, element)')
    expect(kotlin('Schemas')).toContain(
      '    data class Unknown(override val status: String, val raw: JsonObject) : FlowStep()'
    )
  })

  test('an enum a response carries is open in both languages', () => {
    expect(declaration(swift('Schemas'), 'public enum FlowKind:')).toContain(
      '    case unknown(String)'
    )
    expect(declaration(kotlin('Schemas'), 'sealed class FlowKind')).toContain(
      '    class Unknown internal constructor(override val rawValue: String) : FlowKind() {'
    )
  })

  test('an enum only a request carries is closed in both languages', () => {
    expect(swift('Schemas')).toContain(
      'public enum IdTokenProvider: String, Codable, Hashable, Sendable, CaseIterable {'
    )
    expect(kotlin('Schemas')).toContain('enum class IdTokenProvider(val rawValue: String) {')
  })

  test('only what a client operation reaches: nothing of the admin or the instance API', () => {
    const operations = swift('Operations')
    const paths = [...operations.matchAll(/path: "([^"]+)"/g)].map(([, path]) => path as string)
    expect(paths.length).toBeGreaterThan(50)
    expect(paths.filter((path) => !path.startsWith('/v1/client/'))).toEqual([])
    for (const text of [swift('Schemas'), kotlin('Schemas')]) {
      // Components the document has that only an administrator's routes use.
      expect(document.components?.schemas).toHaveProperty('WebhookEndpoint')
      expect(document.components?.schemas).toHaveProperty('EnvironmentSettingsInput')
      expect(text).not.toMatch(/\b(WebhookEndpoint|EnvironmentSettingsInput|ApiKey)\b/)
    }
  })

  test('both languages declare the same names', () => {
    const swiftNames = [
      ...swift('Schemas').matchAll(/^public (?:struct|enum|typealias) (\w+)/gm),
    ].map(([, name]) => name)
    const kotlinNames = [
      ...kotlin('Schemas').matchAll(
        /^(?:data class|class|sealed class|enum class|typealias) (\w+)/gm
      ),
    ].map(([, name]) => name)
    expect(swiftNames.length).toBeGreaterThan(50)
    expect(kotlinNames).toEqual(swiftNames)
    expect(new Set(swiftNames).size).toBe(swiftNames.length)
    // The error codes have a file of their own, written from the contract.
    expect(swiftNames).not.toContain('ErrorCode')
  })

  test('every error code of the contract is a constant, with its status', () => {
    const codes = Object.keys(ERROR_DEFINITIONS)
    expect(codes.length).toBeGreaterThan(50)
    for (const code of codes) {
      expect(swift('ErrorCodes')).toContain(`        case "${code}": self = .`)
      expect(kotlin('ErrorCodes')).toContain(`            "${code}" -> `)
    }
    expect(swift('ErrorCodes').match(/^ {8}case "/gm)?.length).toBe(codes.length)
    const { status } = ERROR_DEFINITIONS['auth.invalid_credentials']
    expect(swift('ErrorCodes')).toContain(
      `TulaErrorDefinition(code: .authInvalidCredentials, status: ${status}, message: `
    )
    expect(kotlin('ErrorCodes')).toContain(
      `TulaErrorDefinition(ErrorCode.AuthInvalidCredentials, ${status}, `
    )
  })

  test('no behaviour: nothing that makes a request, keeps a session or runs a flow', () => {
    const behaviour =
      /URLSession|URLRequest|Keychain|UserDefaults|\bawait\b|\basync\b|\bsuspend\b|HttpClient|okhttp|ktor|SharedPreferences|java\.net/
    for (const [path, text] of Object.entries(files)) {
      expect({ path, found: behaviour.exec(text)?.[0] ?? null }).toEqual({ path, found: null })
    }
  })
})

describe('what stops a generation', () => {
  test('error codes in the document that are not the contract’s', () => {
    const { 'auth.invalid_credentials': _left, ...fewer } = ERROR_DEFINITIONS
    const refusal =
      "the document's ErrorCode is not the contract's list of error codes: run `bun run contract:generate`"
    expect(() => renderNativeFiles({ ...real, errorDefinitions: fewer })).toThrow(refusal)
    const more = { ...ERROR_DEFINITIONS, 'new.code': { status: 400, message: 'New.' } }
    expect(() => renderNativeFiles({ ...real, errorDefinitions: more })).toThrow(refusal)
  })

  test('a default theme value the grammar refuses, in either language', () => {
    const theme = { ...DEFAULT_THEME, radius: 'url(x)' }
    expect(() => renderNativeFiles({ ...real, theme: { theme, tokens: THEME_TOKENS } })).toThrow(
      'theme token "radius" (shared) has no value that passes its grammar'
    )
  })

  test('a shape the generator does not map', () => {
    const odd = fixture({ ...SAMPLE_SCHEMAS, Colour: { not: { type: 'string' } } })
    expect(() => renderNativeFiles({ ...real, document: odd })).toThrow(
      'unsupported JSON Schema keyword "not"'
    )
  })
})

describe('nativeDrift', () => {
  test('nothing when the tree is what the generator writes', () => {
    expect(nativeDrift(files, { ...files })).toEqual([])
    expect(nativeDrift({}, {})).toEqual([])
  })

  test('a file that is missing, one that is out of date and one nobody generates', () => {
    expect(
      nativeDrift(
        { 'a/Missing.swift': 'x', 'a/Old.swift': 'new', 'a/Same.swift': 'same' },
        { 'a/Old.swift': 'old', 'a/Same.swift': 'same', 'a/Hand.swift': 'by hand' }
      )
    ).toEqual([
      'a/Hand.swift is not a generated file',
      'a/Missing.swift is missing',
      'a/Old.swift is out of date',
    ])
  })

  test('one byte is a difference: a line ending, a space at the end', () => {
    expect(nativeDrift({ 'a/X.kt': 'a\n' }, { 'a/X.kt': 'a\r\n' })).toEqual([
      'a/X.kt is out of date',
    ])
    expect(nativeDrift({ 'a/X.kt': 'a\n' }, { 'a/X.kt': 'a \n' })).toEqual([
      'a/X.kt is out of date',
    ])
  })

  test('a directory or a link is never a generated file, also under a generated name', () => {
    expect(nativeDrift({ 'a/X.kt': 'a\n' }, { 'a/X.kt': null, 'a/Extra': null })).toEqual([
      'a/Extra is not a generated file',
      'a/X.kt is not a file',
    ])
  })

  test('an empty file on disk is out of date, not missing', () => {
    expect(nativeDrift({ 'a/X.kt': 'a\n' }, { 'a/X.kt': '' })).toEqual(['a/X.kt is out of date'])
  })

  test('a path that is the name of something every object has is still a path', () => {
    expect(nativeDrift({ toString: 'x' }, {})).toEqual(['toString is missing'])
    expect(nativeDrift({}, { constructor: 'x' })).toEqual(['constructor is not a generated file'])
  })
})
