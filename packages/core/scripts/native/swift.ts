/**
 * Writes the model as Swift: `Codable` types from Foundation and nothing else.
 *
 * Every type spells out its own `init(from:)` and `encode(to:)` instead of leaving them to the
 * compiler, so that what a missing key, a `null` and an unknown member do is written in the
 * generated file and does not depend on a decoder's settings.
 */
import { type ErrorDefinitions, type ThemeSource, themeValues } from './constants'
import type {
  NativeAlias,
  NativeDeclaration,
  NativeEnum,
  NativeModel,
  NativeProperty,
  NativeStruct,
  NativeType,
  NativeUnion,
} from './model'
import {
  camelCase,
  commentText,
  GENERATED_HEADER,
  memberNames,
  swiftIdentifier,
  swiftString,
} from './names'

/** Case names an enum of this generator already uses, or that read as something else. */
const ENUM_MEMBERS: ReadonlySet<string> = new Set([
  'allKnown',
  'description',
  'hash',
  'hashValue',
  'none',
  'rawValue',
  'some',
  'unknown',
])

const CONFORMANCES = 'Codable, Hashable, Sendable'

/**
 * Names a property of a generated struct cannot have: every `Hashable` type already has a
 * `hashValue` of another type. There is no other spelling to give the property that would
 * not surprise whoever reads the document, so the generation stops.
 */
const REFUSED_PROPERTIES: ReadonlySet<string> = new Set(['hashValue'])

/** An identifier without the backticks that escape it. */
function plain(identifier: string): string {
  return identifier.replace(/`/g, '')
}

function file(body: string): string {
  return `${GENERATED_HEADER}\n\nimport Foundation\n\n${body.trimEnd()}\n`
}

function doc(text: string | undefined, indent = ''): string {
  return text === undefined || commentText(text) === '' ? '' : `${indent}/// ${commentText(text)}\n`
}

function swiftCase(wireName: string): string {
  return swiftIdentifier(camelCase(wireName))
}

/**
 * The Swift spelling of a type.
 *
 * @param type - The type.
 * @returns Its source text.
 */
export function swiftType(type: NativeType): string {
  switch (type.kind) {
    case 'string':
      return 'String'
    case 'integer':
      return 'Int'
    case 'number':
      return 'Double'
    case 'boolean':
      return 'Bool'
    case 'json':
      return 'TulaJSONValue'
    case 'named':
      return type.name
    case 'array':
      return `[${swiftType(type.items)}]`
    case 'map':
      return `[String: ${swiftType(type.values)}]`
    case 'nullable':
      return `${swiftType(type.of)}?`
  }
}

function propertyDoc(property: NativeProperty): string {
  const lines = [
    property.description,
    property.format === undefined ? undefined : `Format: \`${property.format}\`.`,
    property.constant === undefined
      ? undefined
      : `Always \`${JSON.stringify(property.constant)}\` today.`,
  ].filter((line) => line !== undefined)
  return lines.map((line) => doc(line, '    ')).join('')
}

function constantLiteral(constant: string | boolean): string {
  return typeof constant === 'string' ? swiftString(constant) : `${constant}`
}

function struct(declaration: NativeStruct): string {
  const names = memberNames(
    declaration.properties.map((property) => property.wireName),
    swiftCase
  )
  const refused = names.map(plain).find((name) => REFUSED_PROPERTIES.has(name))
  if (refused !== undefined) {
    throw new Error(`${declaration.name}: a property cannot be named ${refused}`)
  }
  const head = `${doc(declaration.description)}public struct ${declaration.name}: ${CONFORMANCES} {`
  if (names.length === 0) {
    return [
      head,
      '    public init() {}',
      '',
      '    public init(from decoder: Decoder) throws {',
      '        _ = try decoder.container(keyedBy: TulaCodingKey.self)',
      '    }',
      '',
      '    public func encode(to encoder: Encoder) throws {',
      '        _ = encoder.container(keyedBy: TulaCodingKey.self)',
      '    }',
      '}',
    ].join('\n')
  }
  const fields = declaration.properties.map((property, index) => {
    const name = names[index] as string
    // A property that may be left out and one that may be null are both an Optional: Swift
    // has one "no value". They differ in what is read and written (see below).
    const optional = !property.required || property.nullable
    const type = swiftType(property.type)
    const fallback =
      property.required && !property.nullable && property.constant !== undefined
        ? ` = ${constantLiteral(property.constant)}`
        : property.required
          ? ''
          : ' = nil'
    return { property, name, type, optional, fallback, plain: name.replace(/`/g, '') }
  })
  const lines = [head]
  for (const field of fields) {
    lines.push(
      `${propertyDoc(field.property)}    public var ${field.name}: ${field.type}${field.optional ? '?' : ''}`
    )
  }
  lines.push('')
  lines.push('    public init(')
  lines.push(
    fields
      .map(
        (field) =>
          `        ${field.name}: ${field.type}${field.optional ? '?' : ''}${field.fallback}`
      )
      .join(',\n')
  )
  lines.push('    ) {')
  for (const field of fields) {
    lines.push(`        self.${field.name} = ${field.name}`)
  }
  lines.push('    }')
  lines.push('')
  lines.push('    private enum CodingKeys: String, CodingKey {')
  for (const field of fields) {
    lines.push(
      field.plain === field.property.wireName
        ? `        case ${field.name}`
        : `        case ${field.name} = ${swiftString(field.property.wireName)}`
    )
  }
  lines.push('    }')
  lines.push('')
  lines.push('    public init(from decoder: Decoder) throws {')
  lines.push('        let container = try decoder.container(keyedBy: CodingKeys.self)')
  for (const field of fields) {
    // A key the document requires is an error when it is missing, also where its value may
    // be null; one it does not require is absent when missing or null.
    const read = !field.property.required
      ? `decodeIfPresent(${field.type}.self`
      : field.property.nullable
        ? `decode(${field.type}?.self`
        : `decode(${field.type}.self`
    lines.push(`        self.${field.name} = try container.${read}, forKey: .${field.name})`)
  }
  lines.push('    }')
  lines.push('')
  lines.push('    public func encode(to encoder: Encoder) throws {')
  lines.push('        var container = encoder.container(keyedBy: CodingKeys.self)')
  for (const field of fields) {
    // A required key is always written, as null when it has no value; an optional one is
    // left out.
    const write = field.property.required ? 'encode' : 'encodeIfPresent'
    lines.push(`        try container.${write}(self.${field.name}, forKey: .${field.name})`)
  }
  lines.push('    }')
  lines.push('}')
  return lines.join('\n')
}

function openEnum(declaration: NativeEnum): string {
  const names = memberNames(declaration.values, swiftCase, ENUM_MEMBERS)
  const lines = [
    `${doc(declaration.description)}public enum ${declaration.name}: ${CONFORMANCES} {`,
    ...names.map((name) => `    case ${name}`),
    '    /// A value this version does not know, as the API wrote it.',
    '    case unknown(String)',
    '',
    '    /// Every value this version knows.',
    `    public static let allKnown: [${declaration.name}] = [`,
    ...names.map((name) => `        .${name},`),
    '    ]',
    '',
    '    /// The value for a string of the API: `unknown` for one this version does not know.',
    '    public init(rawValue: String) {',
    '        switch rawValue {',
    ...declaration.values.map(
      (value, index) => `        case ${swiftString(value)}: self = .${names[index]}`
    ),
    '        default: self = .unknown(rawValue)',
    '        }',
    '    }',
    '',
    '    /// The value as the API writes it.',
    '    public var rawValue: String {',
    '        switch self {',
    ...declaration.values.map(
      (value, index) => `        case .${names[index]}: return ${swiftString(value)}`
    ),
    '        case .unknown(let value): return value',
    '        }',
    '    }',
    '',
    '    public init(from decoder: Decoder) throws {',
    '        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))',
    '    }',
    '',
    '    public func encode(to encoder: Encoder) throws {',
    '        var container = encoder.singleValueContainer()',
    '        try container.encode(self.rawValue)',
    '    }',
    '',
    '    public static func == (lhs: Self, rhs: Self) -> Bool {',
    '        lhs.rawValue == rhs.rawValue',
    '    }',
    '',
    '    public func hash(into hasher: inout Hasher) {',
    '        hasher.combine(self.rawValue)',
    '    }',
    '}',
  ]
  return lines.join('\n')
}

function closedEnum(declaration: NativeEnum): string {
  const names = memberNames(declaration.values, swiftCase, ENUM_MEMBERS)
  return [
    `${doc(declaration.description)}public enum ${declaration.name}: String, ${CONFORMANCES}, CaseIterable {`,
    ...declaration.values.map((value, index) => {
      const name = names[index] as string
      return name.replace(/`/g, '') === value
        ? `    case ${name}`
        : `    case ${name} = ${swiftString(value)}`
    }),
    '}',
  ].join('\n')
}

function union(declaration: NativeUnion): string {
  const tags = declaration.variants.map((variant) => variant.tag)
  const names = memberNames(tags, swiftCase, ENUM_MEMBERS)
  const tag = swiftIdentifier(camelCase(declaration.discriminator))
  // The unknown case is `unknown(<tag>: String, raw: TulaJSONValue)`, and the tag is also a
  // property of the enum beside its cases.
  if (plain(tag) === 'raw') {
    throw new Error(`${declaration.name}: a discriminator cannot be named raw`)
  }
  if (names.map(plain).includes(plain(tag))) {
    throw new Error(
      `${declaration.name}: its discriminator and a case would both be named ${plain(tag)}`
    )
  }
  // The discriminator is a string of the document: in a comment only through `commentText`.
  const wire = commentText(declaration.discriminator)
  const key = `TulaCodingKey(stringValue: ${swiftString(declaration.discriminator)})`
  const lines = [
    `${doc(declaration.description)}public enum ${declaration.name}: ${CONFORMANCES} {`,
    ...declaration.variants.map((variant, index) => `    case ${names[index]}(${variant.type})`),
  ]
  if (declaration.open) {
    lines.push(
      `    /// A \`${wire}\` this version does not know, with the object as the API wrote it.`
    )
    lines.push(`    case unknown(${tag}: String, raw: TulaJSONValue)`)
  }
  lines.push('')
  lines.push(`    /// The value of \`${wire}\` on the wire.`)
  lines.push(`    public var ${tag}: String {`)
  lines.push('        switch self {')
  for (const name of names) {
    lines.push(`        case .${name}(let value): return value.${tag}`)
  }
  if (declaration.open) {
    lines.push('        case .unknown(let value, _): return value')
  }
  lines.push('        }')
  lines.push('    }')
  lines.push('')
  lines.push('    public init(from decoder: Decoder) throws {')
  lines.push('        let container = try decoder.container(keyedBy: TulaCodingKey.self)')
  lines.push(`        let tag = try container.decode(String.self, forKey: ${key})`)
  lines.push('        switch tag {')
  declaration.variants.forEach((variant, index) => {
    lines.push(
      `        case ${swiftString(variant.tag)}: self = .${names[index]}(try ${variant.type}(from: decoder))`
    )
  })
  if (declaration.open) {
    lines.push(
      `        default: self = .unknown(${tag}: tag, raw: try TulaJSONValue(from: decoder))`
    )
  } else {
    lines.push('        default:')
    lines.push('            throw DecodingError.dataCorruptedError(')
    lines.push(`                forKey: ${key},`)
    lines.push('                in: container,')
    lines.push(
      `                debugDescription: ${swiftString(`${declaration.name} has no such ${declaration.discriminator}`)}`
    )
    lines.push('            )')
  }
  lines.push('        }')
  lines.push('    }')
  lines.push('')
  lines.push('    public func encode(to encoder: Encoder) throws {')
  lines.push('        switch self {')
  for (const name of names) {
    lines.push(`        case .${name}(let value): try value.encode(to: encoder)`)
  }
  if (declaration.open) {
    lines.push('        case .unknown(_, let raw): try raw.encode(to: encoder)')
  }
  lines.push('        }')
  lines.push('    }')
  lines.push('}')
  return lines.join('\n')
}

function alias(declaration: NativeAlias): string {
  return `${doc(declaration.description)}public typealias ${declaration.name} = ${swiftType(declaration.type)}`
}

function declarationText(declaration: NativeDeclaration): string {
  switch (declaration.kind) {
    case 'struct':
      return struct(declaration)
    case 'enum':
      return declaration.open ? openEnum(declaration) : closedEnum(declaration)
    case 'union':
      return union(declaration)
    case 'alias':
      return alias(declaration)
  }
}

/**
 * The Swift file of the request and response types.
 *
 * @param model - The model of the client API.
 * @returns The source text of `Schemas.swift`.
 */
export function renderSwiftSchemas(model: NativeModel): string {
  return file(model.declarations.map(declarationText).join('\n\n'))
}

/**
 * The Swift file of the error codes: the open `ErrorCode` type, and for every code the HTTP
 * status and default message the contract gives it.
 *
 * @param definitions - The contract's `ERROR_DEFINITIONS`.
 * @returns The source text of `ErrorCodes.swift`.
 */
export function renderSwiftErrorCodes(definitions: ErrorDefinitions): string {
  const codes = Object.keys(definitions)
  const names = memberNames(codes, swiftCase, ENUM_MEMBERS)
  const code = openEnum({
    kind: 'enum',
    name: 'ErrorCode',
    description:
      'A machine-readable error code of the API (`area.reason`). The list only grows: a code this version does not know is `unknown`.',
    values: codes,
    open: true,
  })
  const constants = codes.map((value, index) => {
    const definition = definitions[value] as ErrorDefinitions[string]
    return [
      `    /// \`${commentText(value)}\``,
      `    public static let ${names[index]} = TulaErrorDefinition(code: .${names[index]}, status: ${definition.status}, message: ${swiftString(definition.message)})`,
    ].join('\n')
  })
  return file(
    [
      code,
      '',
      '/// What the contract says about one error code.',
      `public struct TulaErrorDefinition: Hashable, Sendable {`,
      '    /// The code.',
      '    public let code: ErrorCode',
      '    /// The HTTP status the API answers with for this code.',
      '    public let status: Int',
      '    /// The default (English) message; an app may translate by `code`.',
      '    public let message: String',
      '}',
      '',
      '/// Every error code of the contract with its status and default message.',
      'public enum TulaErrorDefinitions {',
      constants.join('\n\n'),
      '',
      '    /// Every definition, in the order of the contract.',
      '    public static let all: [TulaErrorDefinition] = [',
      ...names.map((name) => `        ${name},`),
      '    ]',
      '}',
    ].join('\n')
  )
}

/**
 * The Swift file of the operation table: method, path and whether a session is needed. Data
 * only: nothing in it makes a request.
 *
 * @param model - The model of the client API.
 * @returns The source text of `Operations.swift`.
 */
export function renderSwiftOperations(model: NativeModel): string {
  const names = memberNames(
    model.operations.map((operation) => operation.id),
    swiftCase,
    new Set(['all'])
  )
  const constants = model.operations.map((operation, index) => {
    const types = [
      operation.body ? `Body: \`${swiftType(operation.body)}\`.` : 'No body.',
      operation.response ? `Answers \`${swiftType(operation.response)}\`.` : 'Answers no body.',
    ].join(' ')
    return [
      doc(`${operation.summary} (\`${operation.method} ${operation.path}\`). ${types}`, '    ') +
        `    public static let ${names[index]} = TulaOperation(id: ${swiftString(operation.id)}, method: ${swiftString(operation.method)}, path: ${swiftString(operation.path)}, requiresSession: ${operation.session})`,
    ].join('\n')
  })
  return file(
    [
      '/// How one operation of the client API is called.',
      'public struct TulaOperation: Hashable, Sendable {',
      '    /// The id of the operation in the OpenAPI document.',
      '    public let id: String',
      '    /// The HTTP method.',
      '    public let method: String',
      '    /// The path, with `{name}` placeholders for its path parameters.',
      '    public let path: String',
      '    /// Whether the operation needs the access token of the signed-in user.',
      '    public let requiresSession: Bool',
      '}',
      '',
      '/// Every operation of the client API (`/v1/client/*`).',
      'public enum TulaOperations {',
      constants.join('\n\n'),
      '',
      '    /// Every operation, by id.',
      '    public static let all: [TulaOperation] = [',
      ...names.map((name) => `        ${name},`),
      '    ]',
      '}',
    ].join('\n')
  )
}

/**
 * The Swift file of the theme: the contract's default values, light and dark, as the strings
 * the contract holds. Turning one into a colour or a length is the SDK's to write, after it
 * has put a value an app supplied through the theme grammar.
 *
 * @param source - The contract's default theme and its token table.
 * @returns The source text of `Theme.swift`.
 * @throws Error for a default value the contract's `isValidThemeValue` refuses.
 */
export function renderSwiftTheme(source: ThemeSource): string {
  const values = themeValues(source)
  const schemeNames = memberNames(
    values.scheme.map((token) => token.key),
    swiftCase
  )
  const sharedNames = memberNames(
    values.shared.map((token) => token.key),
    swiftCase,
    new Set(['light', 'dark', 'defaults'])
  )
  const scheme = (which: 'light' | 'dark') =>
    [
      '        TulaThemeScheme(',
      values.scheme
        .map((token, index) => `            ${schemeNames[index]}: ${swiftString(token[which])}`)
        .join(',\n'),
      '        )',
    ].join('\n')
  const memberwise = (fields: { name: string; type: string }[]) => [
    '    public init(',
    fields.map((field) => `        ${field.name}: ${field.type}`).join(',\n'),
    '    ) {',
    ...fields.map((field) => `        self.${field.name} = ${field.name}`),
    '    }',
  ]
  const themeFields = [
    { name: 'light', type: 'TulaThemeScheme' },
    { name: 'dark', type: 'TulaThemeScheme' },
    ...sharedNames.map((name) => ({ name, type: 'String' })),
  ]
  return file(
    [
      '/// The tokens that differ between light and dark, as the contract writes them.',
      'public struct TulaThemeScheme: Hashable, Sendable {',
      ...values.scheme.map(
        (token, index) =>
          `${doc(`${token.description} (${token.type})`, '    ')}    public var ${schemeNames[index]}: String`
      ),
      '',
      ...memberwise(schemeNames.map((name) => ({ name, type: 'String' }))),
      '}',
      '',
      '/// A complete theme: one scheme for light, one for dark, and the tokens both share.',
      'public struct TulaTheme: Hashable, Sendable {',
      '    /// The light scheme.',
      '    public var light: TulaThemeScheme',
      '    /// The dark scheme.',
      '    public var dark: TulaThemeScheme',
      ...values.shared.map(
        (token, index) =>
          `${doc(`${token.description} (${token.type})`, '    ')}    public var ${sharedNames[index]}: String`
      ),
      '',
      ...memberwise(themeFields),
      '',
      '    /// The default theme of the contract.',
      '    public static let defaults = TulaTheme(',
      `        light:\n${scheme('light')},`,
      `        dark:\n${scheme('dark')},`,
      values.shared
        .map((token, index) => `        ${sharedNames[index]}: ${swiftString(token.value)}`)
        .join(',\n'),
      '    )',
      '}',
      '',
      '/// One token of the theme: its key, whether it has a value per scheme, and its kind of value.',
      'public struct TulaThemeToken: Hashable, Sendable {',
      '    /// The key of the token: a property of `TulaThemeScheme` or of `TulaTheme`.',
      '    public let key: String',
      '    /// `scheme` (a value per colour scheme) or `shared` (one value for both).',
      '    public let scope: String',
      '    /// The kind of value: `color`, `shadow`, `length` or `fontFamily`.',
      '    public let type: String',
      '',
      '    /// Every token, in the order of the contract.',
      '    public static let all: [TulaThemeToken] = [',
      ...values.scheme.map(
        (token) =>
          `        TulaThemeToken(key: ${swiftString(token.key)}, scope: "scheme", type: ${swiftString(token.type)}),`
      ),
      ...values.shared.map(
        (token) =>
          `        TulaThemeToken(key: ${swiftString(token.key)}, scope: "shared", type: ${swiftString(token.type)}),`
      ),
      '    ]',
      '}',
    ].join('\n')
  )
}

/**
 * The Swift file of the two types the generated code leans on: a coding key by name, and a
 * JSON value for what the document leaves open.
 *
 * @returns The source text of `Support.swift`.
 */
export function renderSwiftSupport(): string {
  return file(`/// A coding key by its name, for an object whose keys are not known when this file is written.
public struct TulaCodingKey: CodingKey, Hashable, Sendable {
    public var stringValue: String
    public var intValue: Int? { nil }

    public init(stringValue: String) {
        self.stringValue = stringValue
    }

    public init?(intValue: Int) {
        return nil
    }
}

/// Any JSON value: what the API document leaves open, and the whole of an object whose kind
/// this version does not know. A number is a \`Double\`, so an integer beyond 2^53 is not exact.
public enum TulaJSONValue: ${CONFORMANCES} {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([TulaJSONValue])
    case object([String: TulaJSONValue])

    public init(from decoder: Decoder) throws {
        if let keyed = try? decoder.container(keyedBy: TulaCodingKey.self) {
            var object: [String: TulaJSONValue] = [:]
            for key in keyed.allKeys {
                object[key.stringValue] = try keyed.decode(TulaJSONValue.self, forKey: key)
            }
            self = .object(object)
            return
        }
        if var unkeyed = try? decoder.unkeyedContainer() {
            var array: [TulaJSONValue] = []
            while !unkeyed.isAtEnd {
                array.append(try unkeyed.decode(TulaJSONValue.self))
            }
            self = .array(array)
            return
        }
        let single = try decoder.singleValueContainer()
        if single.decodeNil() {
            self = .null
        } else if let value = try? single.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? single.decode(Double.self) {
            self = .number(value)
        } else {
            self = .string(try single.decode(String.self))
        }
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .null:
            var container = encoder.singleValueContainer()
            try container.encodeNil()
        case .bool(let value):
            var container = encoder.singleValueContainer()
            try container.encode(value)
        case .number(let value):
            var container = encoder.singleValueContainer()
            try container.encode(value)
        case .string(let value):
            var container = encoder.singleValueContainer()
            try container.encode(value)
        case .array(let values):
            var container = encoder.unkeyedContainer()
            for value in values {
                try container.encode(value)
            }
        case .object(let values):
            var container = encoder.container(keyedBy: TulaCodingKey.self)
            for (key, value) in values {
                try container.encode(value, forKey: TulaCodingKey(stringValue: key))
            }
        }
    }
}`)
}
