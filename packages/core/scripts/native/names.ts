/**
 * Names and literals of the generated Swift and Kotlin sources.
 *
 * Every name in a generated file comes from a name in the OpenAPI document or the contract (a
 * schema, a property, an enum member) through one of these functions, so the same input always
 * gives the same identifier and a name a language cannot take is escaped in one place.
 */

/** The words of a wire name: split at everything that is not an ASCII letter or digit. */
function words(name: string): string[] {
  return name.split(/[^A-Za-z0-9]+/).filter((word) => word !== '')
}

function upperFirst(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}

function lowerFirst(word: string): string {
  return word.charAt(0).toLowerCase() + word.slice(1)
}

/**
 * A wire name as a camelCase identifier, before any escaping.
 *
 * A name with no separator is kept as it is (`clientDataJSON`), apart from its first letter.
 * One that would start with a digit gets a leading underscore, and one with no letter or digit
 * at all is `empty`.
 *
 * @param name - The name on the wire: a property, an enum member, an operation id.
 * @returns The camelCase form.
 *
 * @example
 * ```ts
 * camelCase('auth.invalid_credentials') // 'authInvalidCredentials'
 * camelCase('2fa') // '_2fa'
 * ```
 */
export function camelCase(name: string): string {
  const [first, ...rest] = words(name)
  if (first === undefined) {
    return 'empty'
  }
  const joined = lowerFirst(first) + rest.map(upperFirst).join('')
  return /^[0-9]/.test(joined) ? `_${joined}` : joined
}

/**
 * A wire name as a PascalCase identifier, before any escaping.
 *
 * @param name - The name on the wire.
 * @returns The PascalCase form: `_` in front of a leading digit, `Empty` for a name with no
 *   letter or digit.
 *
 * @example
 * ```ts
 * pascalCase('needs_first_factor') // 'NeedsFirstFactor'
 * ```
 */
export function pascalCase(name: string): string {
  const joined = words(name).map(upperFirst).join('')
  if (joined === '') {
    return 'Empty'
  }
  return /^[0-9]/.test(joined) ? `_${joined}` : joined
}

/**
 * Type names a generated declaration must not take, in either language: the standard types the
 * generated code itself names, and the support types the generator writes.
 */
const RESERVED_TYPE_NAMES: ReadonlySet<string> = new Set([
  'Any',
  'Array',
  'Bool',
  'Boolean',
  'Character',
  'Codable',
  'CodingKey',
  'CodingKeys',
  'Companion',
  'Data',
  'Date',
  'Decodable',
  'Decoder',
  'Dictionary',
  'Double',
  'Encodable',
  'Encoder',
  'Equatable',
  'Error',
  'Exception',
  'Hashable',
  'Hasher',
  'Int',
  'Json',
  'JsonElement',
  'JsonObject',
  'JsonPrimitive',
  'KSerializer',
  'List',
  'Long',
  'Map',
  'Never',
  'Nothing',
  'Optional',
  'Protocol',
  'Result',
  'Self',
  'Sendable',
  'Serializable',
  'Set',
  'String',
  'Throwable',
  'Type',
  'URL',
  'UUID',
  'Unit',
  'Unknown',
  'Void',
])

/**
 * The name of a generated type, the same in Swift and in Kotlin.
 *
 * @param name - A schema's name in the document, or a name built from one.
 * @returns The PascalCase type name; `Tula` is put in front of one that a standard type, or a
 *   type the generated code names, already has.
 *
 * @example
 * ```ts
 * typeName('FlowStep') // 'FlowStep'
 * typeName('Error') // 'TulaError'
 * ```
 */
export function typeName(name: string): string {
  const pascal = pascalCase(name)
  return RESERVED_TYPE_NAMES.has(pascal) || pascal.startsWith('_') ? `Tula${pascal}` : pascal
}

/** Swift's reserved words: a declaration, a statement or an expression keyword. */
const SWIFT_KEYWORDS: ReadonlySet<string> = new Set([
  'Any',
  'Protocol',
  'Self',
  'Type',
  'as',
  'associatedtype',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'continue',
  'default',
  'defer',
  'deinit',
  'do',
  'else',
  'enum',
  'extension',
  'fallthrough',
  'false',
  'fileprivate',
  'for',
  'func',
  'guard',
  'if',
  'import',
  'in',
  'init',
  'inout',
  'internal',
  'is',
  'let',
  'nil',
  'open',
  'operator',
  'precedencegroup',
  'private',
  'protocol',
  'public',
  'repeat',
  'rethrows',
  'return',
  'self',
  'static',
  'struct',
  'subscript',
  'super',
  'switch',
  'throw',
  'throws',
  'true',
  'try',
  'typealias',
  'var',
  'where',
  'while',
])

/**
 * Swift names that stay special inside backticks: `self` and the metatype members cannot be
 * declared as a member whatever is put round them.
 */
const SWIFT_UNESCAPABLE: ReadonlySet<string> = new Set(['self', 'Self', 'Type', 'Protocol', 'init'])

/** Kotlin's hard keywords. Soft and modifier keywords are valid identifiers. */
const KOTLIN_KEYWORDS: ReadonlySet<string> = new Set([
  'as',
  'break',
  'class',
  'continue',
  'do',
  'else',
  'false',
  'for',
  'fun',
  'if',
  'in',
  'interface',
  'is',
  'null',
  'object',
  'package',
  'return',
  'super',
  'this',
  'throw',
  'true',
  'try',
  'typealias',
  'typeof',
  'val',
  'var',
  'when',
  'while',
])

function plainIdentifier(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_]/g, '_')
  if (cleaned === '' || cleaned === '_') {
    return 'empty'
  }
  return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned
}

/**
 * An identifier as Swift source may write it.
 *
 * @param name - The identifier wanted, already in the case it should have.
 * @returns The identifier: in backticks when it is a reserved word, with a trailing underscore
 *   when backticks would not help (`self`, `init`, `Type`), with `_` in front of a leading
 *   digit and in place of any character an identifier cannot hold.
 *
 * @example
 * ```ts
 * swiftIdentifier('default') // '`default`'
 * swiftIdentifier('self') // 'self_'
 * ```
 */
export function swiftIdentifier(name: string): string {
  const plain = plainIdentifier(name)
  if (SWIFT_UNESCAPABLE.has(plain)) {
    return `${plain}_`
  }
  return SWIFT_KEYWORDS.has(plain) ? `\`${plain}\`` : plain
}

/**
 * An identifier as Kotlin source may write it.
 *
 * @param name - The identifier wanted, already in the case it should have.
 * @returns The identifier: in backticks when it is a hard keyword, with `_` in front of a
 *   leading digit and in place of any character an identifier cannot hold.
 *
 * @example
 * ```ts
 * kotlinIdentifier('object') // '`object`'
 * ```
 */
export function kotlinIdentifier(name: string): string {
  const plain = plainIdentifier(name)
  return KOTLIN_KEYWORDS.has(plain) ? `\`${plain}\`` : plain
}

function codePoints(value: string): number[] {
  return [...value].map((character) => character.codePointAt(0) as number)
}

/**
 * A string as a Swift string literal.
 *
 * @param value - The text.
 * @returns The literal, quotes included. Everything outside printable ASCII is written as a
 *   `\u{...}` escape, so the generated file holds no character that cannot be seen.
 *
 * @example
 * ```ts
 * swiftString('say "hi"') // '"say \\"hi\\""'
 * ```
 */
export function swiftString(value: string): string {
  const body = codePoints(value)
    .map((point) => {
      const character = String.fromCodePoint(point)
      if (character === '\\' || character === '"') {
        return `\\${character}`
      }
      return point >= 0x20 && point < 0x7f ? character : `\\u{${point.toString(16)}}`
    })
    .join('')
  return `"${body}"`
}

/**
 * A string as a Kotlin string literal.
 *
 * @param value - The text.
 * @returns The literal, quotes included. `$` is escaped (it would start a template), and
 *   everything outside printable ASCII is written as `\uXXXX` escapes of its UTF-16 units.
 *
 * @example
 * ```ts
 * kotlinString('costs $5') // '"costs \\$5"'
 * ```
 */
export function kotlinString(value: string): string {
  let body = ''
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    const character = value.charAt(index)
    if (character === '\\' || character === '"' || character === '$') {
      body += `\\${character}`
    } else if (unit >= 0x20 && unit < 0x7f) {
      body += character
    } else {
      body += `\\u${unit.toString(16).padStart(4, '0')}`
    }
  }
  return `"${body}"`
}

/**
 * Text that is safe inside a `///` or a `/** ... *\/` comment of a generated file.
 *
 * @param text - A description from the document or the contract.
 * @returns The text on one line, with nothing that could end the comment and nothing a reader
 *   cannot see: a typographic quote becomes the plain one, any other character outside
 *   printable ASCII is written as `U+XXXX` (a text-direction control in a description must
 *   not reorder what a reviewer sees of a generated source).
 */
export function commentText(text: string): string {
  let plain = ''
  for (const character of text.replace(/\s+/g, ' ')) {
    const point = character.codePointAt(0) as number
    if (point >= 0x20 && point <= 0x7e) {
      plain += character
    } else if (point === 0x2018 || point === 0x2019) {
      plain += "'"
    } else if (point === 0x201c || point === 0x201d) {
      plain += '"'
    } else {
      plain += `U+${point.toString(16).toUpperCase().padStart(4, '0')}`
    }
  }
  return plain.replace(/\*\//g, '* /').replace(/\/\*/g, '/ *').trim()
}

/**
 * Identifiers for the members of one declaration: an enum's cases, an object's properties.
 *
 * @param wireNames - The names on the wire, in the order they are declared.
 * @param identifier - Turns a wire name into the identifier wanted (case and escaping).
 * @param taken - Identifiers the declaration already uses for something else (`unknown`,
 *   `rawValue`): a member that would get one is given the suffix `Value`.
 * @returns One identifier per name, in the same order.
 * @throws Error when two names would get the same identifier: the generator never renames
 *   one of two members by position.
 *
 * @example
 * ```ts
 * memberNames(['a_b', 'unknown'], camelCase, new Set(['unknown'])) // ['aB', 'unknownValue']
 * ```
 */
export function memberNames(
  wireNames: readonly string[],
  identifier: (wireName: string) => string,
  taken: ReadonlySet<string> = new Set()
): string[] {
  const seen = new Map<string, string>()
  return wireNames.map((wireName) => {
    const wanted = identifier(wireName)
    const plain = wanted.replace(/`/g, '')
    const name = taken.has(plain) ? `${plain}Value` : wanted
    const earlier = seen.get(name)
    if (earlier !== undefined) {
      throw new Error(`"${earlier}" and "${wireName}" would both be named ${name}`)
    }
    seen.set(name, wireName)
    return name
  })
}

/**
 * The first three lines of every generated file. The third is there because a generated
 * struct or data class prints every property it has, and some of them are refresh tokens,
 * passwords and attempt secrets: the header is the one place every reader of a file passes.
 */
export const GENERATED_HEADER = [
  '// Generated by `bun run native:generate` from packages/contract/openapi.json and @tula-tech/contract.',
  '// Do not edit: change the API or the contract, run `bun run contract:generate`, then regenerate this file.',
  '// A value of these types may hold tokens, passwords and attempt secrets: never log, print or interpolate one.',
].join('\n')
