/**
 * The client half of the OpenAPI document as declarations a native language can write down.
 *
 * Swift and Kotlin have no structural types, so every object, enum and union of the document
 * becomes a named declaration here, once, and the two renderers write the same model. Nothing
 * in this module knows either language.
 *
 * As in the TypeScript generator, a shape this module does not map fails the generation
 * instead of being guessed at.
 */
import {
  CLIENT_PATH_PREFIX,
  type OpenApiDocument,
  operationsUnder,
  reachableSchemas,
  refName,
  type SchemaNode,
} from '../openapi-types'
import { pascalCase, typeName } from './names'

/** The type of a value. */
export type NativeType =
  | { readonly kind: 'string' | 'integer' | 'number' | 'boolean' | 'json' }
  | { readonly kind: 'named'; readonly name: string }
  | { readonly kind: 'array'; readonly items: NativeType }
  | { readonly kind: 'map'; readonly values: NativeType }
  | { readonly kind: 'nullable'; readonly of: NativeType }

/** One property of an object. */
export interface NativeProperty {
  /** The key on the wire. */
  readonly wireName: string
  /** The value's type, without the `null` a nullable property also takes. */
  readonly type: NativeType
  /** Whether the key is always there. */
  readonly required: boolean
  /** Whether the value may be `null`. */
  readonly nullable: boolean
  /** The one value the document allows today, for a `const`. */
  readonly constant?: string | boolean
  /** The schema's `description`. */
  readonly description?: string
  /** The schema's `format`: documentation only, never a type. */
  readonly format?: string
}

/** An object with named properties. */
export interface NativeStruct {
  readonly kind: 'struct'
  readonly name: string
  readonly description?: string
  readonly properties: readonly NativeProperty[]
}

/** A string with a list of members. */
export interface NativeEnum {
  readonly kind: 'enum'
  readonly name: string
  readonly description?: string
  readonly values: readonly string[]
  /** Whether a member this list does not have decodes to an "unknown" case. */
  readonly open: boolean
}

/** A union of objects told apart by one property that is a different `const` in each. */
export interface NativeUnion {
  readonly kind: 'union'
  readonly name: string
  readonly description?: string
  /** The wire name of the property that tells the variants apart. */
  readonly discriminator: string
  readonly variants: readonly { readonly tag: string; readonly type: string }[]
  /** Whether a tag this list does not have decodes to an "unknown" case. */
  readonly open: boolean
}

/** A name for a type that needs no declaration of its own: a map, an array, a primitive. */
export interface NativeAlias {
  readonly kind: 'alias'
  readonly name: string
  readonly description?: string
  readonly type: NativeType
}

/** Anything the schemas file declares. */
export type NativeDeclaration = NativeStruct | NativeEnum | NativeUnion | NativeAlias

/** How one operation is called, and the types of what it sends and answers. */
export interface NativeOperation {
  readonly id: string
  readonly method: string
  readonly path: string
  readonly summary: string
  /** Whether the operation needs the signed-in user's access token. */
  readonly session: boolean
  readonly body?: NativeType
  readonly response?: NativeType
}

/** Everything the renderers write from the document. */
export interface NativeModel {
  /** Sorted by name. */
  readonly declarations: readonly NativeDeclaration[]
  /** Sorted by operation id. */
  readonly operations: readonly NativeOperation[]
}

/**
 * The component that is the error code. Its declaration is written from the contract's own
 * table (`@tula-tech/contract/error-codes`), not from the document, so the document's copy is only
 * held equal to it.
 */
export const ERROR_CODE_SCHEMA = 'ErrorCode'

/** Keywords that change a value's shape and that this generator does not map. */
const UNSUPPORTED = ['not', 'prefixItems', 'patternProperties', 'if', 'then', 'else']

const JSON_TYPE: NativeType = { kind: 'json' }

// A map, not an object: the key is a string of the document, and an object would answer
// for `constructor` and `toString` too.
const SCALARS: ReadonlyMap<string, NativeType> = new Map([
  ['string', { kind: 'string' }],
  ['integer', { kind: 'integer' }],
  ['number', { kind: 'number' }],
  ['boolean', { kind: 'boolean' }],
])

/**
 * The types the generator writes that are not made from a schema: the support types, the
 * error codes (written from the contract) and what the theme and the operations files
 * declare, in either language. A declaration made from the document cannot take one.
 */
export const SUPPORT_TYPE_NAMES: ReadonlySet<string> = new Set([
  'ErrorCode',
  'ErrorCodeSerializer',
  'TulaCodingKey',
  'TulaErrorDefinition',
  'TulaErrorDefinitions',
  'TulaJSONValue',
  'TulaJson',
  'TulaOperation',
  'TulaOperations',
  'TulaTheme',
  'TulaThemeDefaults',
  'TulaThemeScheme',
  'TulaThemeToken',
])

/**
 * The name of the serializer the Kotlin renderer writes beside an enum or a union. It is
 * kept for every one of them, also for a closed enum, which has none today: an enum that a
 * response starts to carry becomes open, and must not find its serializer's name taken.
 *
 * @param name - The name of the enum or the union.
 * @returns The serializer's name.
 */
export function serializerName(name: string): string {
  return `${name}Serializer`
}

interface Context {
  readonly document: OpenApiDocument
  /** The declarations made so far, by name. */
  readonly declarations: Map<string, NativeDeclaration>
  /** Whether what is being converted can be read from a response. */
  readonly open: boolean
}

function nullable(type: NativeType): NativeType {
  return type.kind === 'nullable' ? type : { kind: 'nullable', of: type }
}

function isNull(node: SchemaNode): boolean {
  return node.type === 'null' || ('const' in node && node.const === null)
}

function isEmptySchema(node: unknown): boolean {
  return node === true || (typeof node === 'object' && node !== null && !Object.keys(node).length)
}

function declare(context: Context, declaration: NativeDeclaration): NativeType {
  if (context.declarations.has(declaration.name) || SUPPORT_TYPE_NAMES.has(declaration.name)) {
    throw new Error(`two declarations would be named "${declaration.name}"`)
  }
  context.declarations.set(declaration.name, declaration)
  return { kind: 'named', name: declaration.name }
}

function resolve(context: Context, node: SchemaNode): SchemaNode {
  let current = node
  // A reference to a reference is followed; a cycle of them would be a broken document.
  for (let hops = 0; current.$ref !== undefined; hops += 1) {
    const name = refName(current.$ref)
    const schemas = context.document.components.schemas
    const target = Object.hasOwn(schemas, name) ? schemas[name] : undefined
    if (!target || hops > 32) {
      throw new Error(`schema "${current.$ref}" cannot be resolved`)
    }
    current = target
  }
  return current
}

/**
 * The members of an `allOf` as one object: every member's properties and required keys.
 *
 * Only objects can be put together this way. A property two members both declare must be
 * declared the same way in both, or there is no one type to give it.
 */
function mergeAllOf(context: Context, node: SchemaNode): SchemaNode {
  // A map: a property may be called `constructor`, `toString` or `__proto__`, and an object
  // would find the first two already there and lose the third.
  const properties = new Map<string, SchemaNode>()
  const required = new Set<string>()
  const { allOf, ...own } = node as SchemaNode & { allOf: SchemaNode[] }
  const members = Object.keys(own).some((key) => key === 'properties' || key === 'type')
    ? [...allOf, own]
    : allOf
  for (const member of members) {
    const resolved = resolve(context, member)
    const merged = 'allOf' in resolved ? mergeAllOf(context, resolved) : resolved
    if (merged.type !== 'object' || merged.additionalProperties) {
      throw new Error('unsupported "allOf": every member must be a plain object')
    }
    for (const [name, property] of Object.entries(merged.properties ?? {})) {
      const earlier = properties.get(name)
      if (earlier !== undefined && JSON.stringify(earlier) !== JSON.stringify(property)) {
        throw new Error(`unsupported "allOf": "${name}" is declared in two different ways`)
      }
      properties.set(name, property)
    }
    for (const name of merged.required ?? []) {
      required.add(name)
    }
  }
  return {
    type: 'object',
    // `fromEntries` defines each key, `__proto__` included, as a property of its own.
    properties: Object.fromEntries(properties),
    required: [...required],
    ...(node.description === undefined ? {} : { description: node.description }),
  }
}

/** The property that is a different string `const` in every alternative, if there is one. */
function discriminatorOf(alternatives: SchemaNode[]): string | undefined {
  const [first, ...rest] = alternatives
  const candidates = Object.entries(first?.properties ?? {})
    .filter(([, property]) => typeof property.const === 'string')
    .map(([name]) => name)
  return candidates.find((name) => {
    const tags = alternatives.map((alternative) =>
      alternative.type === 'object' && (alternative.required ?? []).includes(name)
        ? alternative.properties?.[name]?.const
        : undefined
    )
    return (
      rest.length > 0 &&
      tags.every((tag) => typeof tag === 'string') &&
      new Set(tags).size === tags.length
    )
  })
}

function unionType(
  context: Context,
  node: SchemaNode,
  alternatives: SchemaNode[],
  hint: string
): NativeType {
  const resolved = alternatives.map((alternative) => resolve(context, alternative))
  const discriminator = discriminatorOf(resolved)
  if (discriminator === undefined) {
    // No native type says "one of these" without a tag to choose by. Scalars can still be
    // carried as a JSON value; anything else would be a guess.
    if (
      resolved.every(
        (alternative) =>
          typeof alternative.type === 'string' && SCALARS.has(alternative.type) && !alternative.enum
      )
    ) {
      return JSON_TYPE
    }
    throw new Error(`unsupported union at "${hint}": its alternatives have no discriminator`)
  }
  const variants = alternatives.map((alternative, index) => {
    const tag = (resolved[index] as SchemaNode).properties?.[discriminator]?.const as string
    const variant = alternative.$ref
      ? convert(context, alternative, hint)
      : convert(context, alternative, `${hint}${pascalCase(tag)}`)
    if (variant.kind !== 'named') {
      throw new Error(`unsupported union at "${hint}": a variant is not an object`)
    }
    return { tag, type: variant.name }
  })
  return declare(context, {
    kind: 'union',
    name: typeName(hint),
    discriminator,
    variants,
    open: context.open,
    ...(node.description === undefined ? {} : { description: node.description }),
  })
}

function enumType(context: Context, node: SchemaNode, hint: string): NativeType {
  const members = (node.enum ?? []).filter((member) => member !== null)
  // Null is allowed either as a member or by the type beside the list.
  const hasNull =
    members.length !== (node.enum ?? []).length ||
    (Array.isArray(node.type) && node.type.includes('null'))
  let type: NativeType
  if (members.length > 0 && members.every((member) => typeof member === 'string')) {
    type = declare(context, {
      kind: 'enum',
      name: typeName(hint),
      values: members as string[],
      open: context.open,
      ...(node.description === undefined ? {} : { description: node.description }),
    })
  } else if (members.every((member) => typeof member === 'boolean')) {
    type = { kind: 'boolean' }
  } else if (members.every((member) => typeof member === 'number')) {
    type = { kind: members.every((member) => Number.isInteger(member)) ? 'integer' : 'number' }
  } else {
    throw new Error(`unsupported enum at "${hint}": its members are of different types`)
  }
  return hasNull ? nullable(type) : type
}

function propertyOf(
  context: Context,
  wireName: string,
  node: SchemaNode,
  required: boolean,
  hint: string
): NativeProperty {
  const converted = convert(context, node, hint)
  const constant =
    typeof node.const === 'string' || typeof node.const === 'boolean' ? node.const : undefined
  return {
    wireName,
    type: converted.kind === 'nullable' ? converted.of : converted,
    required,
    nullable: converted.kind === 'nullable',
    ...(constant === undefined ? {} : { constant }),
    ...(node.description === undefined ? {} : { description: node.description }),
    ...(typeof node.format === 'string' ? { format: node.format } : {}),
  }
}

function objectType(context: Context, node: SchemaNode, hint: string): NativeType {
  const names = Object.keys(node.properties ?? {})
  const extra = node.additionalProperties
  if (names.length === 0 && extra !== undefined && extra !== false) {
    return {
      kind: 'map',
      values: isEmptySchema(extra)
        ? JSON_TYPE
        : convert(context, extra as SchemaNode, `${hint}Value`),
    }
  }
  if (extra && !isEmptySchema(extra)) {
    throw new Error(`unsupported object at "${hint}": named properties beside typed extra ones`)
  }
  const required = new Set(node.required ?? [])
  const name = typeName(hint)
  // Declared before its properties are converted, so that a property's own declarations
  // cannot take the name; the properties are filled in below.
  const properties: NativeProperty[] = []
  const type = declare(context, {
    kind: 'struct',
    name,
    properties,
    ...(node.description === undefined ? {} : { description: node.description }),
  })
  for (const wireName of names) {
    properties.push(
      propertyOf(
        context,
        wireName,
        Object.getOwnPropertyDescriptor(node.properties, wireName)?.value as SchemaNode,
        required.has(wireName),
        `${hint}${pascalCase(wireName)}`
      )
    )
  }
  return type
}

/**
 * The type of one schema node, declaring whatever it needs a name for.
 *
 * @param context - The document and the declarations made so far.
 * @param node - The JSON Schema node.
 * @param hint - The name a declaration made for this node takes.
 * @returns The node's type.
 * @throws Error for a keyword or a shape outside the supported subset.
 */
function convert(context: Context, node: SchemaNode, hint: string): NativeType {
  const unsupported = UNSUPPORTED.find((keyword) => keyword in node)
  if (unsupported) {
    throw new Error(`unsupported JSON Schema keyword "${unsupported}"`)
  }
  if (node.$ref) {
    return { kind: 'named', name: typeName(refName(node.$ref)) }
  }
  if ('allOf' in node) {
    return convert(context, mergeAllOf(context, node), hint)
  }
  if ('const' in node && node.const !== undefined) {
    if (node.const === null) {
      return nullable(JSON_TYPE)
    }
    if (typeof node.const === 'number') {
      return { kind: Number.isInteger(node.const) ? 'integer' : 'number' }
    }
    return { kind: typeof node.const === 'string' ? 'string' : 'boolean' }
  }
  if (node.enum) {
    return enumType(context, node, hint)
  }
  const alternatives = node.anyOf ?? node.oneOf
  if (alternatives) {
    const rest = alternatives.filter((alternative) => !isNull(alternative))
    const only = rest[0]
    const type =
      rest.length === 1 && only
        ? convert(context, only, hint)
        : unionType(context, node, rest, hint)
    return rest.length === alternatives.length ? type : nullable(type)
  }
  if (Array.isArray(node.type)) {
    const rest = node.type.filter((type) => type !== 'null')
    const only = rest[0]
    const type =
      rest.length === 1 && only
        ? convert(context, { ...node, type: only }, hint)
        : unionType(
            context,
            node,
            rest.map((type) => ({ type })),
            hint
          )
    return rest.length === node.type.length ? type : nullable(type)
  }
  if (node.type === 'array') {
    return {
      kind: 'array',
      items: node.items ? convert(context, node.items, `${hint}Item`) : JSON_TYPE,
    }
  }
  if (node.type === 'object') {
    return objectType(context, node, hint)
  }
  if (node.type === 'null') {
    return nullable(JSON_TYPE)
  }
  if (node.type === undefined) {
    // The schema that accepts anything: `{}`, or one with annotations only.
    return JSON_TYPE
  }
  const scalar = SCALARS.get(node.type)
  if (!scalar) {
    throw new Error(`unsupported JSON Schema type ${JSON.stringify(node.type)}`)
  }
  return scalar
}

/**
 * Build the model of the client API (`/v1/client/*`).
 *
 * **Open or closed.** An enum or a union is *open* when a response can carry it: a schema
 * reachable from the body of any response, the error envelope included. A server may add a
 * member to such a list at any time, so a client has to be able to read one it does not know.
 * One that only a request body reaches is *closed*: the client is the one writing it, and can
 * only write what it knows.
 *
 * @param document - The OpenAPI document (`packages/contract/openapi.json`).
 * @param errorCodes - The contract's error codes, which the document's copy must equal.
 * @returns The declarations and the operations.
 * @throws Error when the document uses something this generator does not map, when two
 *   declarations would get one name, or when the document's error codes are not the contract's.
 *
 * @example
 * ```ts
 * const model = buildModel(await Bun.file(path).json(), ERROR_CODES)
 * ```
 */
export function buildModel(document: OpenApiDocument, errorCodes: readonly string[]): NativeModel {
  const operations = operationsUnder(document, CLIENT_PATH_PREFIX)
  const inResponses = new Set(
    reachableSchemas(
      document,
      operations.flatMap((operation) => [operation.response, ...operation.errors])
    )
  )
  const schemas = reachableSchemas(
    document,
    operations.flatMap((operation) => [operation.body, operation.response, ...operation.errors])
  )
  const declarations = new Map<string, NativeDeclaration>()
  for (const name of schemas) {
    const schema = document.components.schemas[name] as SchemaNode
    if (name === ERROR_CODE_SCHEMA) {
      const documented = [...(schema.enum ?? [])].sort()
      if (JSON.stringify(documented) !== JSON.stringify([...errorCodes].sort())) {
        throw new Error(
          `the document's ${ERROR_CODE_SCHEMA} is not the contract's list of error codes: run \`bun run contract:generate\``
        )
      }
      continue
    }
    const context: Context = { document, declarations, open: inResponses.has(name) }
    const type = convert(context, schema, name)
    if (type.kind !== 'named' || type.name !== typeName(name)) {
      declare(context, {
        kind: 'alias',
        name: typeName(name),
        type,
        ...(schema.description === undefined ? {} : { description: schema.description }),
      })
    }
  }
  const typeOf = (schema: SchemaNode | undefined, hint: string) =>
    schema === undefined
      ? {}
      : { [hint]: convert({ document, declarations, open: hint === 'response' }, schema, hint) }
  const before = declarations.size
  const mapped = operations.map((operation) => ({
    id: operation.id,
    method: operation.method,
    path: operation.path,
    summary: operation.summary,
    session: operation.session,
    ...typeOf(operation.body, 'body'),
    ...typeOf(operation.response, 'response'),
  }))
  if (declarations.size !== before) {
    // A body or a response written inline would need a name nobody chose.
    throw new Error('an operation declares its body or its response inline: give the schema a name')
  }
  for (const declaration of declarations.values()) {
    const serializer = serializerName(declaration.name)
    if (
      (declaration.kind === 'enum' || declaration.kind === 'union') &&
      declarations.has(serializer)
    ) {
      throw new Error(`two declarations would be named "${serializer}"`)
    }
  }
  return {
    declarations: [...declarations.values()].sort((a, b) => (a.name < b.name ? -1 : 1)),
    // By code point, like the declarations. The order the shared reader gives is a locale's
    // (`localeCompare`), which is not the same on every machine.
    operations: mapped.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  }
}
