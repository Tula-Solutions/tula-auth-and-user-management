/**
 * Small OpenAPI documents for the tests of the native generator: one client operation that
 * sends `Request` and answers `Answer`, so that a schema is reachable by naming it.
 */
import type { OpenApiDocument, SchemaNode } from '../openapi-types'

/**
 * A reference to a component.
 *
 * @param name - The component's name.
 * @returns The `$ref` node.
 */
export function ref(name: string): SchemaNode {
  return { $ref: `#/components/schemas/${name}` }
}

/**
 * A schema as a JSON body, as an operation's request or response holds it.
 *
 * @param schema - The body's schema.
 * @returns The `content` wrapper.
 */
export function jsonBody(schema: SchemaNode): {
  content: Record<string, { schema: SchemaNode }>
} {
  return { content: { 'application/json': { schema } } }
}

/**
 * An object schema.
 *
 * @param properties - Its properties.
 * @param required - The keys that are always there.
 * @returns The schema.
 */
export function object(
  properties: Record<string, SchemaNode>,
  required: string[] = []
): SchemaNode {
  return { type: 'object', properties, required }
}

/**
 * A document with one client operation that sends `Request` (when there is one) and answers
 * `Answer` (and `Failure` as a 422, when there is one), a second client operation that has
 * neither, and one admin operation that answers `AdminOnly` (when there is one).
 *
 * @param schemas - The document's components.
 * @returns The document.
 */
export function fixture(schemas: Record<string, SchemaNode>): OpenApiDocument {
  return {
    paths: {
      '/v1/client/things/{thingId}': {
        post: {
          operationId: 'doThing',
          summary: 'Do the thing',
          security: [{ publishableKey: [] }, { accessToken: [] }],
          parameters: [{ in: 'path', name: 'thingId', required: true }],
          ...('Request' in schemas ? { requestBody: jsonBody(ref('Request')) } : {}),
          responses: {
            200: jsonBody(ref('Answer')),
            ...('Failure' in schemas ? { 422: jsonBody(ref('Failure')) } : {}),
          },
        },
      },
      '/v1/client/nothing': {
        delete: { operationId: 'askNothing', responses: { 204: {} } },
      },
      ...('AdminOnly' in schemas
        ? {
            '/v1/admin/things': {
              get: { operationId: 'listThings', responses: { 200: jsonBody(ref('AdminOnly')) } },
            },
          }
        : {}),
    },
    components: { schemas },
  }
}

/**
 * One of every shape the renderers write: an object with a key of each kind, an object with
 * no key, an enum and a union a response carries (open) and ones only a request does
 * (closed), a map and a name for one.
 */
export const SAMPLE_SCHEMAS: Record<string, SchemaNode> = {
  Answer: {
    description: 'What the thing answered.',
    ...object(
      {
        id: { type: 'string', description: 'The id of the thing.' },
        created_at: { type: 'string', format: 'date-time' },
        default: { type: 'integer' },
        deletedAt: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        note: { type: ['string', 'null'] },
        kind: { type: 'string', const: 'thing' },
        final: { const: true },
        step: ref('Step'),
        colours: { type: 'array', items: ref('Colour') },
        scores: { type: 'object', additionalProperties: { type: 'number' } },
        extra: {},
        nothing: { type: 'object' },
        params: ref('Params'),
      },
      ['id', 'created_at', 'deletedAt', 'kind', 'final', 'step']
    ),
  },
  Colour: {
    type: 'string',
    enum: ['red', 'dark_blue', 'unknown', '2tone'],
    description: 'A colour.',
  },
  Params: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] } },
  Step: {
    description: 'What to do next.',
    oneOf: [
      object({ status: { type: 'string', const: 'needs_password' } }, ['status']),
      object({ status: { type: 'string', const: 'complete' }, userId: { type: 'string' } }, [
        'status',
        'userId',
      ]),
    ],
  },
  Request: object({ size: ref('Size'), how: ref('How') }, ['size']),
  Size: { type: 'string', enum: ['small', 'extra_large'] },
  How: {
    oneOf: [
      object({ method: { const: 'by_code' }, code: { type: 'string' } }, ['method', 'code']),
      object({ method: { const: 'by_link' } }, ['method']),
    ],
  },
}
