/**
 * Renders the client half of the OpenAPI document as TypeScript: the schemas the
 * `/v1/client/*` operations use, each operation's inputs and output, and a small runtime table
 * of methods and paths. Types and one constant only, so the SDK carries no generated client code.
 *
 * `openapi-typescript` would do the first part, but it is built on the TypeScript 5 compiler
 * API (`ts.factory`), which TypeScript 7 does not ship. The document uses a small, regular
 * subset of JSON Schema (it is itself generated from Zod), so the subset is rendered here, and
 * anything outside it fails the generation instead of being guessed at.
 */

/** A JSON Schema node, as far as this generator reads it. */
export interface SchemaNode {
  $ref?: string
  type?: string | string[]
  const?: string | number | boolean | null
  enum?: (string | number | boolean | null)[]
  anyOf?: SchemaNode[]
  oneOf?: SchemaNode[]
  items?: SchemaNode
  properties?: Record<string, SchemaNode>
  required?: string[]
  additionalProperties?: boolean | SchemaNode
  description?: string
  [keyword: string]: unknown
}

interface Parameter {
  in: string
  name: string
  required?: boolean
  schema?: SchemaNode
}

interface Operation {
  operationId: string
  summary?: string
  security?: Record<string, unknown>[]
  parameters?: Parameter[]
  requestBody?: { content?: Record<string, { schema?: SchemaNode }> }
  responses: Record<string, { content?: Record<string, { schema?: SchemaNode }> }>
}

/** The parts of an OpenAPI 3.1 document this generator reads. */
export interface OpenApiDocument {
  paths: Record<string, Record<string, Operation>>
  components: { schemas: Record<string, SchemaNode> }
}

/** Path prefix of the operations a client SDK calls. Admin routes take a secret key. */
export const CLIENT_PATH_PREFIX = '/v1/client/'

/** Path prefix of the operations the admin client (`@tula/admin`) calls. */
export const ADMIN_PATH_PREFIX = '/v1/admin/'

/** Path prefix of the instance operations (`@tula/admin`'s instance client): one per deployment. */
export const INSTANCE_PATH_PREFIX = '/v1/instance/'

/** Security scheme of an instance operation: the deployment's admin token. */
export const INSTANCE_TOKEN_SECURITY_SCHEME = 'instanceAdminToken'

/**
 * Instance operations that are a browser's alone: the dashboard's session (ADR 0032). They are
 * authenticated by a cookie, not by the admin token, so the instance client does not render
 * them. Listed by name, so that any other instance operation without the token still fails the
 * generation.
 */
export const BROWSER_ONLY_INSTANCE_OPERATIONS: readonly string[] = [
  'createDashboardSession',
  'getDashboardSession',
  'deleteDashboardSession',
]

/** Security scheme of an admin operation: the environment's secret key. */
export const SECRET_KEY_SECURITY_SCHEME = 'secretKey'

/** Security scheme that marks an operation as needing the signed-in user's access token. */
export const SESSION_SECURITY_SCHEME = 'accessToken'

const REF_PREFIX = '#/components/schemas/'

/**
 * Keywords that change a value's shape. One this generator does not render must fail the
 * generation: silently ignoring it would produce a type that is wider than the API.
 */
const UNSUPPORTED = ['allOf', 'not', 'prefixItems', 'patternProperties', 'if', 'then', 'else']

const PRIMITIVES: Record<string, string> = {
  string: 'string',
  number: 'number',
  integer: 'number',
  boolean: 'boolean',
  null: 'null',
}

function refName(ref: string): string {
  if (!ref.startsWith(REF_PREFIX)) {
    throw new Error(`unsupported $ref "${ref}"`)
  }
  return ref.slice(REF_PREFIX.length)
}

function literal(value: string | number | boolean | null): string {
  return typeof value === 'string'
    ? `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
    : `${value}`
}

function propertyKey(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : literal(name)
}

function union(types: string[]): string {
  return [...new Set(types)].join(' | ')
}

function renderObject(node: SchemaNode, indent: string): string {
  const inner = `${indent}  `
  const required = new Set(node.required ?? [])
  const lines = Object.entries(node.properties ?? {}).map(([name, property]) => {
    const comment = property.description ? `${inner}/** ${property.description} */\n` : ''
    const optional = required.has(name) ? '' : '?'
    return `${comment}${inner}${propertyKey(name)}${optional}: ${renderType(property, inner)}`
  })
  // `{}` is the schema that accepts anything: what a Zod loose object emits.
  const open =
    node.additionalProperties === true ||
    (typeof node.additionalProperties === 'object' &&
      Object.keys(node.additionalProperties).length === 0)
  if (node.additionalProperties && !open) {
    // TypeScript wants every named property to fit the index signature, and an optional one
    // is `T | undefined`: the signature is widened by `undefined` exactly when there is one.
    const optional = Object.keys(node.properties ?? {}).some((name) => !required.has(name))
    const type = renderType(node.additionalProperties as SchemaNode, inner)
    lines.push(`${inner}[key: string]: ${optional ? `${type} | undefined` : type}`)
  } else if (open) {
    lines.push(`${inner}[key: string]: unknown`)
  }
  return lines.length === 0 ? 'Record<string, never>' : `{\n${lines.join('\n')}\n${indent}}`
}

/**
 * Render one schema node as a TypeScript type.
 *
 * @param node - The JSON Schema node.
 * @param indent - Indentation of the line the type starts on.
 * @returns The type's source text.
 * @throws Error for a keyword or type outside the supported subset.
 */
export function renderType(node: SchemaNode, indent = ''): string {
  const unsupported = UNSUPPORTED.find((keyword) => keyword in node)
  if (unsupported) {
    throw new Error(`unsupported JSON Schema keyword "${unsupported}"`)
  }
  if (node.$ref) {
    return `Schemas['${refName(node.$ref)}']`
  }
  if ('const' in node && node.const !== undefined) {
    return literal(node.const)
  }
  if (node.enum) {
    return union(node.enum.map(literal))
  }
  const alternatives = node.anyOf ?? node.oneOf
  if (alternatives) {
    return union(alternatives.map((alternative) => renderType(alternative, indent)))
  }
  if (Array.isArray(node.type)) {
    return union(node.type.map((type) => renderType({ ...node, type }, indent)))
  }
  if (node.type === 'array') {
    const items = node.items ? renderType(node.items, indent) : 'unknown'
    return items.includes(' | ') ? `(${items})[]` : `${items}[]`
  }
  if (node.type === 'object') {
    return renderObject(node, indent)
  }
  const primitive = node.type === undefined ? undefined : PRIMITIVES[node.type]
  if (!primitive) {
    throw new Error(`unsupported JSON Schema type ${JSON.stringify(node.type)}`)
  }
  return primitive
}

function collectRefs(node: unknown, found: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      collectRefs(item, found)
    }
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') {
        found.add(refName(value))
      } else {
        collectRefs(value, found)
      }
    }
  }
}

interface ClientOperation {
  id: string
  method: string
  path: string
  summary: string
  session: boolean
  secretKey: boolean
  instanceToken: boolean
  pathParams: string[]
  /** Query and header parameters. The client half has none worth typing; the admin half does. */
  query: Parameter[]
  headers: Parameter[]
  body: SchemaNode | undefined
  response: SchemaNode | undefined
  /** Bodies of the non-2xx responses (the error envelope), so their schemas are generated too. */
  errors: (SchemaNode | undefined)[]
}

function jsonSchema(
  content: Record<string, { schema?: SchemaNode }> | undefined
): SchemaNode | undefined {
  return content?.['application/json']?.schema
}

function operationsUnder(document: OpenApiDocument, prefix: string): ClientOperation[] {
  const operations: ClientOperation[] = []
  for (const [path, methods] of Object.entries(document.paths)) {
    if (!path.startsWith(prefix)) {
      continue
    }
    for (const [method, operation] of Object.entries(methods)) {
      const success = Object.entries(operation.responses).filter(([status]) =>
        status.startsWith('2')
      )
      if (success.length !== 1) {
        throw new Error(`${operation.operationId}: expected exactly one 2xx response`)
      }
      operations.push({
        id: operation.operationId,
        method: method.toUpperCase(),
        path,
        summary: operation.summary ?? operation.operationId,
        session: (operation.security ?? []).some((entry) => SESSION_SECURITY_SCHEME in entry),
        secretKey: (operation.security ?? []).some((entry) => SECRET_KEY_SECURITY_SCHEME in entry),
        instanceToken: (operation.security ?? []).some(
          (entry) => INSTANCE_TOKEN_SECURITY_SCHEME in entry
        ),
        pathParams: (operation.parameters ?? [])
          .filter((parameter) => parameter.in === 'path')
          .map((parameter) => parameter.name),
        query: (operation.parameters ?? []).filter((parameter) => parameter.in === 'query'),
        headers: (operation.parameters ?? []).filter((parameter) => parameter.in === 'header'),
        body: jsonSchema(operation.requestBody?.content),
        response: jsonSchema(success[0]?.[1].content),
        errors: Object.entries(operation.responses)
          .filter(([status]) => !status.startsWith('2'))
          .map(([, response]) => jsonSchema(response.content)),
      })
    }
  }
  return operations.sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * Every schema the given nodes reach, directly or through other schemas.
 *
 * @param document - The OpenAPI document.
 * @param roots - Nodes to start from.
 * @returns The schema names, sorted.
 */
function reachableSchemas(document: OpenApiDocument, roots: unknown[]): string[] {
  const found = new Set<string>()
  collectRefs(roots, found)
  for (const name of found) {
    const schema = document.components.schemas[name]
    if (!schema) {
      throw new Error(`schema "${name}" is referenced but not defined`)
    }
    // A Set iterates over entries added during the loop, so this walks the whole closure.
    collectRefs(schema, found)
  }
  return [...found].sort()
}

/**
 * Render the generated module for the client API.
 *
 * @param document - The OpenAPI document (`packages/contract/openapi.json`).
 * @returns The source text of `src/generated/api.gen.ts`.
 * @throws Error when the document uses something this generator does not render.
 *
 * @example
 * ```ts
 * await Bun.write('src/generated/api.gen.ts', renderClientApi(await Bun.file(path).json()))
 * ```
 */
export function renderClientApi(document: OpenApiDocument): string {
  const operations = operationsUnder(document, CLIENT_PATH_PREFIX)
  const schemas = reachableSchemas(
    document,
    operations.flatMap((operation) => [operation.body, operation.response, ...operation.errors])
  )

  const schemaLines = schemas.map((name) => {
    const schema = document.components.schemas[name] as SchemaNode
    return `  ${name}: ${renderType(schema, '  ')}`
  })

  const operationLines = operations.map((operation) => {
    const params =
      operation.pathParams.length === 0
        ? 'Record<string, never>'
        : `{ ${operation.pathParams.map((name) => `${propertyKey(name)}: string`).join('; ')} }`
    const body = operation.body ? renderType(operation.body) : 'undefined'
    const response = operation.response ? renderType(operation.response) : 'undefined'
    return [
      `  /** ${operation.summary} (\`${operation.method} ${operation.path}\`). */`,
      `  ${operation.id}: { params: ${params}; body: ${body}; response: ${response} }`,
    ].join('\n')
  })

  const tableLines = operations.map(
    (operation) =>
      `  ${operation.id}: { method: '${operation.method}', path: '${operation.path}', session: ${operation.session} },`
  )

  return `// Generated by \`bun run --filter @tula/core generate\` from packages/contract/openapi.json.
// Do not edit: change the API, run \`bun run contract:generate\`, then regenerate this file.

/** Schemas of the client API (\`/v1/client/*\`), by their name in the OpenAPI document. */
export interface Schemas {
${schemaLines.join('\n')}
}

/** Path parameters, JSON body and success response of every client operation. */
export interface Operations {
${operationLines.join('\n')}
}

/** How one operation is called. */
export interface OperationRoute {
  /** HTTP method. */
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** Path, with \`{name}\` placeholders for its path parameters. */
  readonly path: string
  /** Whether the operation needs the signed-in user's access token. */
  readonly session: boolean
}

/** Method, path and authentication of every client operation, by operation id. */
export const OPERATIONS: { readonly [Id in keyof Operations]: OperationRoute } = {
${tableLines.join('\n')}
}
`
}

function pathParamsType(names: string[]): string {
  return names.length === 0
    ? 'Record<string, never>'
    : `{ ${names.map((name) => `${propertyKey(name)}: string`).join('; ')} }`
}

/** The type of an operation's query or header parameters: optional unless marked required. */
function parametersType(parameters: Parameter[]): string {
  if (parameters.length === 0) {
    return 'Record<string, never>'
  }
  const fields = parameters.map((parameter) => {
    const type = parameter.schema ? renderType(parameter.schema) : 'string'
    return `${propertyKey(parameter.name)}${parameter.required ? '' : '?'}: ${type}`
  })
  return `{ ${fields.join('; ')} }`
}

/**
 * Render the generated module for the admin API: what `@tula/admin` is typed from.
 *
 * Unlike the client half it types each operation's query and header parameters (the admin API
 * pages its lists and replaces settings under `If-Match`), and it has no `session` column:
 * every admin operation takes the environment's secret key, which the generation checks.
 *
 * @param document - The OpenAPI document (`packages/contract/openapi.json`).
 * @returns The source text of `packages/admin/src/generated/api.gen.ts`.
 * @throws Error when the document uses something this generator does not render, or an admin
 *   operation does not take the secret key.
 *
 * @example
 * ```ts
 * await Bun.write('src/generated/api.gen.ts', renderAdminApi(await Bun.file(path).json()))
 * ```
 */
export function renderAdminApi(document: OpenApiDocument): string {
  const operations = operationsUnder(document, ADMIN_PATH_PREFIX)
  for (const operation of operations) {
    if (!operation.secretKey) {
      throw new Error(`${operation.id}: an admin operation must take the secret key`)
    }
  }
  const instance = operationsUnder(document, INSTANCE_PATH_PREFIX).filter(
    (operation) => !BROWSER_ONLY_INSTANCE_OPERATIONS.includes(operation.id)
  )
  for (const operation of instance) {
    if (!operation.instanceToken || operation.secretKey) {
      throw new Error(`${operation.id}: an instance operation must take the instance admin token`)
    }
  }
  const all = [...operations, ...instance]
  const schemas = reachableSchemas(document, [
    ...all.flatMap((operation) => [operation.body, operation.response]),
    ...all.flatMap((operation) =>
      [...operation.query, ...operation.headers].map((parameter) => parameter.schema)
    ),
    // The error envelope, so the transport's reading of it can be checked against its schema.
    ...all.flatMap((operation) => operation.errors),
  ])

  const schemaLines = schemas.map((name) => {
    const schema = document.components.schemas[name] as SchemaNode
    return `  ${name}: ${renderType(schema, '  ')}`
  })

  const operationLine = (operation: ClientOperation) => {
    const body = operation.body ? renderType(operation.body) : 'undefined'
    const response = operation.response ? renderType(operation.response) : 'undefined'
    return [
      `  /** ${operation.summary} (\`${operation.method} ${operation.path}\`). */`,
      `  ${operation.id}: { params: ${pathParamsType(operation.pathParams)}; ` +
        `query: ${parametersType(operation.query)}; ` +
        `headers: ${parametersType(operation.headers)}; body: ${body}; response: ${response} }`,
    ].join('\n')
  }
  const tableLine = (operation: ClientOperation) =>
    `  ${operation.id}: { method: '${operation.method}', path: '${operation.path}' },`
  const operationLines = operations.map(operationLine)
  const tableLines = operations.map(tableLine)

  return `// Generated by \`bun run --filter @tula/admin generate\` from packages/contract/openapi.json.
// Do not edit: change the API, run \`bun run contract:generate\`, then regenerate this file.

/** Schemas of the admin and instance APIs (\`/v1/admin/*\`, \`/v1/instance/*\`), by their name in the OpenAPI document. */
export interface Schemas {
${schemaLines.join('\n')}
}

/** Path, query and header parameters, JSON body and success response of every admin operation. */
export interface Operations {
${operationLines.join('\n')}
}

/** How one operation is called. */
export interface OperationRoute {
  /** HTTP method. */
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** Path, with \`{name}\` placeholders for its path parameters. */
  readonly path: string
}

/** Method and path of every admin operation, by operation id. */
export const OPERATIONS: { readonly [Id in keyof Operations]: OperationRoute } = {
${tableLines.join('\n')}
}

/**
 * The instance operations (\`/v1/instance/*\`): about the deployment, not one environment.
 * They take the instance admin token (\`TULA_ADMIN_TOKEN\`), never a secret key.
 */
export interface InstanceOperations {
${instance.map(operationLine).join('\n')}
}

/** Method and path of every instance operation, by operation id. */
export const INSTANCE_OPERATIONS: { readonly [Id in keyof InstanceOperations]: OperationRoute } = {
${instance.map(tableLine).join('\n')}
}
`
}
