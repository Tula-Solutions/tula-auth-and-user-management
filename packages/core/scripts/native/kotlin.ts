/**
 * Writes the model as Kotlin for `kotlinx.serialization` (its JSON format) and nothing else.
 *
 * The generated types assume the `Json` instance the support file declares (`TulaJson`:
 * unknown keys ignored, every other setting the library's default). An enum and a union that
 * can grow have a serializer of their own in the generated file, so that what an unknown
 * member does is written there and not left to a setting.
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
  kotlinIdentifier,
  kotlinString,
  memberNames,
  pascalCase,
} from './names'

/** The package of every generated Kotlin file. */
export const KOTLIN_PACKAGE = 'dev.tula.auth.generated'

/** Names a sealed class of this generator already uses for something else. */
const NESTED_NAMES: ReadonlySet<string> = new Set(['Companion', 'Unknown'])

/** What a generated file may name, with where it comes from. Imported only when it is used. */
const IMPORTS: readonly (readonly [string, string])[] = [
  ['EncodeDefault', 'kotlinx.serialization.EncodeDefault'],
  ['ExperimentalSerializationApi', 'kotlinx.serialization.ExperimentalSerializationApi'],
  ['KSerializer', 'kotlinx.serialization.KSerializer'],
  ['SerialName', 'kotlinx.serialization.SerialName'],
  ['Serializable', 'kotlinx.serialization.Serializable'],
  ['SerializationException', 'kotlinx.serialization.SerializationException'],
  ['PrimitiveKind', 'kotlinx.serialization.descriptors.PrimitiveKind'],
  ['PrimitiveSerialDescriptor', 'kotlinx.serialization.descriptors.PrimitiveSerialDescriptor'],
  ['SerialDescriptor', 'kotlinx.serialization.descriptors.SerialDescriptor'],
  ['buildClassSerialDescriptor', 'kotlinx.serialization.descriptors.buildClassSerialDescriptor'],
  ['Decoder', 'kotlinx.serialization.encoding.Decoder'],
  ['Encoder', 'kotlinx.serialization.encoding.Encoder'],
  ['Json', 'kotlinx.serialization.json.Json'],
  ['JsonDecoder', 'kotlinx.serialization.json.JsonDecoder'],
  ['JsonElement', 'kotlinx.serialization.json.JsonElement'],
  ['JsonEncoder', 'kotlinx.serialization.json.JsonEncoder'],
  ['JsonObject', 'kotlinx.serialization.json.JsonObject'],
  ['JsonPrimitive', 'kotlinx.serialization.json.JsonPrimitive'],
]

function file(body: string): string {
  const text = body.trimEnd()
  // `@EncodeDefault` is the one experimental declaration the generated code uses: the opt-in
  // is written in the file that needs it and nowhere else.
  const optIn = /@EncodeDefault\b/.test(text)
    ? '@file:OptIn(ExperimentalSerializationApi::class)\n\n'
    : ''
  // The opt-in names a class too, so it is part of what the imports are worked out from.
  const imports = IMPORTS.filter(([name]) => new RegExp(`\\b${name}\\b`).test(optIn + text))
    .map(([, path]) => `import ${path}`)
    .sort()
  return [
    `${GENERATED_HEADER}\n`,
    `${optIn}package ${KOTLIN_PACKAGE}\n`,
    ...(imports.length > 0 ? [`${imports.join('\n')}\n`] : []),
    `${text}\n`,
  ].join('\n')
}

function doc(text: string | undefined, indent = ''): string {
  return text === undefined || commentText(text) === ''
    ? ''
    : `${indent}/** ${commentText(text)} */\n`
}

/** An identifier without the backticks that escape it. */
function plain(identifier: string): string {
  return identifier.replace(/`/g, '')
}

/** Types of the language that a generated class names in its own body. */
const BUILT_IN_TYPES = ['Any', 'Boolean', 'Double', 'Int', 'List', 'Long', 'Map', 'String', 'Unit']

/**
 * Refuse a nested declaration that would hide a type its class names. Inside `sealed class
 * Step`, a nested `Complete` is what `Complete` means: `data class Complete(val value:
 * Complete)` would hold itself, and an `object String` would change every `String` below it.
 *
 * @param owner - The enum or the union.
 * @param kind - What the nested declarations are, for the message.
 * @param nested - Their names.
 * @param named - The generated types the class names besides itself.
 * @throws Error for the first name that is the owner's, one of `named`, a built-in type or a
 *   type of the serialization library.
 */
function refuseHidden(
  owner: string,
  kind: 'member' | 'variant',
  nested: readonly string[],
  named: readonly string[] = []
): void {
  const hidden = new Set([owner, ...named, ...BUILT_IN_TYPES, ...IMPORTS.map(([name]) => name)])
  const name = nested.map(plain).find((one) => hidden.has(one))
  if (name !== undefined) {
    throw new Error(`${owner}: the ${kind} ${name} would hide the type ${name}`)
  }
}

function kotlinProperty(wireName: string): string {
  return kotlinIdentifier(camelCase(wireName))
}

function kotlinNested(wireName: string): string {
  return kotlinIdentifier(pascalCase(wireName))
}

/**
 * The Kotlin spelling of a type.
 *
 * @param type - The type.
 * @returns Its source text.
 */
export function kotlinType(type: NativeType): string {
  switch (type.kind) {
    case 'string':
      return 'String'
    case 'integer':
      return 'Long'
    case 'number':
      return 'Double'
    case 'boolean':
      return 'Boolean'
    case 'json':
      return 'JsonElement'
    case 'named':
      return type.name
    case 'array':
      return `List<${kotlinType(type.items)}>`
    case 'map':
      return `Map<String, ${kotlinType(type.values)}>`
    case 'nullable':
      return `${kotlinType(type.of)}?`
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
  return lines.length === 0 ? '' : doc(lines.join(' '), '    ')
}

function struct(declaration: NativeStruct): string {
  const names = memberNames(
    declaration.properties.map((property) => property.wireName),
    kotlinProperty
  )
  if (names.length === 0) {
    // A data class needs a property; an object with none is still a value like any other.
    return [
      `${doc(declaration.description)}@Serializable`,
      `class ${declaration.name} {`,
      `    override fun equals(other: Any?): Boolean = other is ${declaration.name}`,
      '',
      '    override fun hashCode(): Int = 0',
      '',
      `    override fun toString(): String = ${kotlinString(`${declaration.name}()`)}`,
      '}',
    ].join('\n')
  }
  const parameters = declaration.properties.map((property, index) => {
    const name = names[index] as string
    const type = kotlinType(property.type)
    const serialName =
      name.replace(/`/g, '') === property.wireName
        ? ''
        : `    @SerialName(${kotlinString(property.wireName)})\n`
    // With the library's defaults a property that has a default is left out when it holds
    // it, and one without a default is always written and must be there to be read. So: a
    // required key has no default (and is nullable where the document says so), an optional
    // one defaults to null, and a `const` keeps its value as a default that is always written.
    if (!property.required) {
      return `${propertyDoc(property)}${serialName}    val ${name}: ${type}? = null,`
    }
    if (property.nullable) {
      return `${propertyDoc(property)}${serialName}    val ${name}: ${type}?,`
    }
    if (property.constant !== undefined) {
      const literal =
        typeof property.constant === 'string'
          ? kotlinString(property.constant)
          : `${property.constant}`
      return `${propertyDoc(property)}${serialName}    @EncodeDefault\n    val ${name}: ${type} = ${literal},`
    }
    return `${propertyDoc(property)}${serialName}    val ${name}: ${type},`
  })
  return [
    `${doc(declaration.description)}@Serializable`,
    `data class ${declaration.name}(`,
    ...parameters,
    ')',
  ].join('\n')
}

function openEnum(declaration: NativeEnum): string {
  const names = memberNames(declaration.values, kotlinNested, NESTED_NAMES)
  const name = declaration.name
  refuseHidden(name, 'member', names)
  return [
    `${doc(declaration.description)}@Serializable(with = ${name}Serializer::class)`,
    `sealed class ${name} {`,
    '    /** The value as the API writes it. */',
    '    abstract val rawValue: String',
    '',
    '    override fun toString(): String = rawValue',
    '',
    ...declaration.values.flatMap((value, index) => [
      `    object ${names[index]} : ${name}() {`,
      `        override val rawValue: String = ${kotlinString(value)}`,
      '    }',
      '',
    ]),
    '    /** A value this version does not know, as the API wrote it. Made by [of] only. */',
    `    class Unknown internal constructor(override val rawValue: String) : ${name}() {`,
    '        override fun equals(other: Any?): Boolean = other is Unknown && other.rawValue == rawValue',
    '',
    '        override fun hashCode(): Int = rawValue.hashCode()',
    '    }',
    '',
    '    companion object {',
    // Lazy on purpose: a companion is initialized with its class, which is the superclass of
    // the objects below it. A plain list read while one of them is being loaded would hold
    // a null in its place.
    '        /** Every value this version knows. */',
    `        val known: List<${name}> by lazy {`,
    '            listOf(',
    ...names.map((member) => `                ${member},`),
    '            )',
    '        }',
    '',
    '        /** The value for a string of the API: [Unknown] for one this version does not know. */',
    `        fun of(rawValue: String): ${name} = when (rawValue) {`,
    ...declaration.values.map(
      (value, index) => `            ${kotlinString(value)} -> ${names[index]}`
    ),
    '            else -> Unknown(rawValue)',
    '        }',
    '    }',
    '}',
    '',
    `/** Reads and writes [${name}] as its string, whatever the string is. */`,
    `object ${name}Serializer : KSerializer<${name}> {`,
    '    override val descriptor: SerialDescriptor =',
    `        PrimitiveSerialDescriptor(${kotlinString(`${KOTLIN_PACKAGE}.${name}`)}, PrimitiveKind.STRING)`,
    '',
    `    override fun deserialize(decoder: Decoder): ${name} = ${name}.of(decoder.decodeString())`,
    '',
    `    override fun serialize(encoder: Encoder, value: ${name}) {`,
    '        encoder.encodeString(value.rawValue)',
    '    }',
    '}',
  ].join('\n')
}

function closedEnum(declaration: NativeEnum): string {
  const names = memberNames(declaration.values, kotlinNested, NESTED_NAMES)
  refuseHidden(declaration.name, 'member', names)
  return [
    `${doc(declaration.description)}@Serializable`,
    `enum class ${declaration.name}(val rawValue: String) {`,
    ...declaration.values.flatMap((value, index) => [
      `    @SerialName(${kotlinString(value)})`,
      `    ${names[index]}(${kotlinString(value)}),`,
    ]),
    '}',
  ].join('\n')
}

function union(declaration: NativeUnion): string {
  const name = declaration.name
  const names = memberNames(
    declaration.variants.map((variant) => variant.tag),
    kotlinNested,
    NESTED_NAMES
  )
  const tag = kotlinProperty(declaration.discriminator)
  // A variant is `data class X(val value: T)` with the tag as a property beside `value`, and
  // the unknown one is `Unknown(<tag>: String, raw: JsonObject)`.
  if (plain(tag) === 'value' || plain(tag) === 'raw') {
    throw new Error(`${name}: a discriminator cannot be named ${plain(tag)}`)
  }
  refuseHidden(
    name,
    'variant',
    names,
    declaration.variants.map((variant) => variant.type)
  )
  const wire = kotlinString(declaration.discriminator)
  // The discriminator is a string of the document: in a comment only through `commentText`.
  const said = commentText(declaration.discriminator)
  const lines = [
    `${doc(declaration.description)}@Serializable(with = ${name}Serializer::class)`,
    `sealed class ${name} {`,
    `    /** The value of \`${said}\` on the wire. */`,
    `    abstract val ${tag}: String`,
    '',
  ]
  declaration.variants.forEach((variant, index) => {
    lines.push(`    data class ${names[index]}(val value: ${variant.type}) : ${name}() {`)
    lines.push(`        override val ${tag}: String get() = value.${tag}`)
    lines.push('    }')
    lines.push('')
  })
  if (declaration.open) {
    lines.push(
      `    /** A \`${said}\` this version does not know, with the object as the API wrote it. */`
    )
    lines.push(
      `    data class Unknown(override val ${tag}: String, val raw: JsonObject) : ${name}()`
    )
  } else {
    lines.pop()
  }
  lines.push('}')
  lines.push('')
  lines.push(`/** Reads and writes [${name}] by its \`${said}\`. JSON only. */`)
  lines.push(`object ${name}Serializer : KSerializer<${name}> {`)
  lines.push('    override val descriptor: SerialDescriptor =')
  lines.push(`        buildClassSerialDescriptor(${kotlinString(`${KOTLIN_PACKAGE}.${name}`)})`)
  lines.push('')
  lines.push(`    override fun deserialize(decoder: Decoder): ${name} {`)
  lines.push('        val input = decoder as? JsonDecoder')
  lines.push(
    `            ?: throw SerializationException(${kotlinString(`${name} is read from JSON only`)})`
  )
  lines.push('        val element = input.decodeJsonElement() as? JsonObject')
  lines.push(
    `            ?: throw SerializationException(${kotlinString(`${name} is not an object`)})`
  )
  lines.push(
    `        val tag = (element[${wire}] as? JsonPrimitive)?.takeIf { it.isString }?.content`
  )
  lines.push(
    `            ?: throw SerializationException(${kotlinString(`${name} has no ${declaration.discriminator}`)})`
  )
  lines.push('        return when (tag) {')
  declaration.variants.forEach((variant, index) => {
    lines.push(
      `            ${kotlinString(variant.tag)} -> ${name}.${names[index]}(input.json.decodeFromJsonElement(${variant.type}.serializer(), element))`
    )
  })
  lines.push(
    declaration.open
      ? `            else -> ${name}.Unknown(tag, element)`
      : `            else -> throw SerializationException(${kotlinString(`${name} has no such ${declaration.discriminator}`)})`
  )
  lines.push('        }')
  lines.push('    }')
  lines.push('')
  lines.push(`    override fun serialize(encoder: Encoder, value: ${name}) {`)
  lines.push('        val output = encoder as? JsonEncoder')
  lines.push(
    `            ?: throw SerializationException(${kotlinString(`${name} is written as JSON only`)})`
  )
  lines.push('        val element: JsonElement = when (value) {')
  declaration.variants.forEach((variant, index) => {
    lines.push(
      `            is ${name}.${names[index]} -> output.json.encodeToJsonElement(${variant.type}.serializer(), value.value)`
    )
  })
  if (declaration.open) {
    lines.push(`            is ${name}.Unknown -> value.raw`)
  }
  lines.push('        }')
  lines.push('        output.encodeJsonElement(element)')
  lines.push('    }')
  lines.push('}')
  return lines.join('\n')
}

function alias(declaration: NativeAlias): string {
  return `${doc(declaration.description)}typealias ${declaration.name} = ${kotlinType(declaration.type)}`
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
 * The Kotlin file of the request and response types.
 *
 * @param model - The model of the client API.
 * @returns The source text of `Schemas.kt`.
 */
export function renderKotlinSchemas(model: NativeModel): string {
  return file(model.declarations.map(declarationText).join('\n\n'))
}

/**
 * The Kotlin file of the error codes: the open `ErrorCode` type, and for every code the HTTP
 * status and default message the contract gives it.
 *
 * @param definitions - The contract's `ERROR_DEFINITIONS`.
 * @returns The source text of `ErrorCodes.kt`.
 */
export function renderKotlinErrorCodes(definitions: ErrorDefinitions): string {
  const codes = Object.keys(definitions)
  const members = memberNames(codes, kotlinNested, NESTED_NAMES)
  const names = memberNames(codes, kotlinProperty, new Set(['all']))
  const code = openEnum({
    kind: 'enum',
    name: 'ErrorCode',
    description:
      'A machine-readable error code of the API (`area.reason`). The list only grows: a code this version does not know is [Unknown].',
    values: codes,
    open: true,
  })
  return file(
    [
      code,
      '',
      '/** What the contract says about one error code. */',
      'data class TulaErrorDefinition(',
      '    /** The code. */',
      '    val code: ErrorCode,',
      '    /** The HTTP status the API answers with for this code. */',
      '    val status: Int,',
      '    /** The default (English) message; an app may translate by [code]. */',
      '    val message: String,',
      ')',
      '',
      '/** Every error code of the contract with its status and default message. */',
      'object TulaErrorDefinitions {',
      ...codes.flatMap((value, index) => {
        const definition = definitions[value] as ErrorDefinitions[string]
        return [
          `    /** \`${commentText(value)}\` */`,
          `    val ${names[index]}: TulaErrorDefinition = TulaErrorDefinition(ErrorCode.${members[index]}, ${definition.status}, ${kotlinString(definition.message)})`,
          '',
        ]
      }),
      '    /** Every definition, in the order of the contract. */',
      '    val all: List<TulaErrorDefinition> = listOf(',
      ...names.map((name) => `        ${name},`),
      '    )',
      '}',
    ].join('\n')
  )
}

/**
 * The Kotlin file of the operation table: method, path and whether a session is needed. Data
 * only: nothing in it makes a request.
 *
 * @param model - The model of the client API.
 * @returns The source text of `Operations.kt`.
 */
export function renderKotlinOperations(model: NativeModel): string {
  const names = memberNames(
    model.operations.map((operation) => operation.id),
    kotlinProperty,
    new Set(['all'])
  )
  return file(
    [
      '/** How one operation of the client API is called. */',
      'data class TulaOperation(',
      '    /** The id of the operation in the OpenAPI document. */',
      '    val id: String,',
      '    /** The HTTP method. */',
      '    val method: String,',
      '    /** The path, with `{name}` placeholders for its path parameters. */',
      '    val path: String,',
      '    /** Whether the operation needs the access token of the signed-in user. */',
      '    val requiresSession: Boolean,',
      ')',
      '',
      '/** Every operation of the client API (`/v1/client/`). */',
      'object TulaOperations {',
      ...model.operations.flatMap((operation, index) => {
        const types = [
          operation.body ? `Body: [${kotlinType(operation.body)}].` : 'No body.',
          operation.response ? `Answers [${kotlinType(operation.response)}].` : 'Answers no body.',
        ].join(' ')
        return [
          doc(
            `${operation.summary} (\`${operation.method} ${operation.path}\`). ${types}`,
            '    '
          ).trimEnd(),
          `    val ${names[index]}: TulaOperation = TulaOperation(${kotlinString(operation.id)}, ${kotlinString(operation.method)}, ${kotlinString(operation.path)}, ${operation.session})`,
          '',
        ]
      }),
      '    /** Every operation, by id. */',
      '    val all: List<TulaOperation> = listOf(',
      ...names.map((name) => `        ${name},`),
      '    )',
      '}',
    ].join('\n')
  )
}

/**
 * The Kotlin file of the theme: the contract's default values, light and dark, as the strings
 * the contract holds. Turning one into a colour or a dimension is the SDK's to write, after it
 * has put a value an app supplied through the theme grammar.
 *
 * @param source - The contract's default theme and its token table.
 * @returns The source text of `Theme.kt`.
 * @throws Error for a default value the contract's `isValidThemeValue` refuses.
 */
export function renderKotlinTheme(source: ThemeSource): string {
  const values = themeValues(source)
  const schemeNames = memberNames(
    values.scheme.map((token) => token.key),
    kotlinProperty
  )
  const sharedNames = memberNames(
    values.shared.map((token) => token.key),
    kotlinProperty,
    new Set(['light', 'dark'])
  )
  const scheme = (which: 'light' | 'dark') => [
    `        ${which} = TulaThemeScheme(`,
    ...values.scheme.map(
      (token, index) => `            ${schemeNames[index]} = ${kotlinString(token[which])},`
    ),
    '        ),',
  ]
  return file(
    [
      '/** The tokens that differ between light and dark, as the contract writes them. */',
      'data class TulaThemeScheme(',
      ...values.scheme.map(
        (token, index) =>
          `${doc(`${token.description} (${token.type})`, '    ')}    val ${schemeNames[index]}: String,`
      ),
      ')',
      '',
      '/** A complete theme: one scheme for light, one for dark, and the tokens both share. */',
      'data class TulaTheme(',
      '    /** The light scheme. */',
      '    val light: TulaThemeScheme,',
      '    /** The dark scheme. */',
      '    val dark: TulaThemeScheme,',
      ...values.shared.map(
        (token, index) =>
          `${doc(`${token.description} (${token.type})`, '    ')}    val ${sharedNames[index]}: String,`
      ),
      ')',
      '',
      '/** One token of the theme: its key, whether it has a value per scheme, and its kind of value. */',
      'data class TulaThemeToken(',
      '    /** The key of the token: a property of [TulaThemeScheme] or of [TulaTheme]. */',
      '    val key: String,',
      '    /** `scheme` (a value per colour scheme) or `shared` (one value for both). */',
      '    val scope: String,',
      '    /** The kind of value: `color`, `shadow`, `length` or `fontFamily`. */',
      '    val type: String,',
      ')',
      '',
      '/** The theme of the contract: its default values and its tokens. */',
      'object TulaThemeDefaults {',
      '    /** The default theme of the contract. */',
      '    val theme: TulaTheme = TulaTheme(',
      ...scheme('light'),
      ...scheme('dark'),
      ...values.shared.map(
        (token, index) => `        ${sharedNames[index]} = ${kotlinString(token.value)},`
      ),
      '    )',
      '',
      '    /** Every token, in the order of the contract. */',
      '    val tokens: List<TulaThemeToken> = listOf(',
      ...values.scheme.map(
        (token) =>
          `        TulaThemeToken(${kotlinString(token.key)}, "scheme", ${kotlinString(token.type)}),`
      ),
      ...values.shared.map(
        (token) =>
          `        TulaThemeToken(${kotlinString(token.key)}, "shared", ${kotlinString(token.type)}),`
      ),
      '    )',
      '}',
    ].join('\n')
  )
}

/**
 * The Kotlin file of the one thing the generated types assume: the `Json` instance to read
 * and write them with.
 *
 * @returns The source text of `Support.kt`.
 */
export function renderKotlinSupport(): string {
  return file(
    [
      '/**',
      ' * The JSON format the generated types are read and written with. A key this version does',
      ' * not know is ignored; everything else is the default of the library: a property left out',
      ' * of a request is not written, and one the API always sends must be there.',
      ' */',
      'val TulaJson: Json = Json {',
      '    ignoreUnknownKeys = true',
      '}',
    ].join('\n')
  )
}
