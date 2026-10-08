import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import {
  type OpenApiDocument,
  renderAdminApi,
  renderClientApi,
  renderType,
  type SchemaNode,
} from './openapi-types'

describe('renderType', () => {
  test.each([
    ['a primitive', { type: 'string' }, 'string'],
    ['an integer', { type: 'integer' }, 'number'],
    ['a nullable type', { type: ['string', 'null'] }, 'string | null'],
    ['a const', { type: 'string', const: 'complete' }, "'complete'"],
    ['a number const', { const: 1 }, '1'],
    [
      'an enum',
      { type: 'string', enum: ['a', "it's", 'back\\slash'] },
      "'a' | 'it\\'s' | 'back\\\\slash'",
    ],
    ['a reference', { $ref: '#/components/schemas/User' }, "Schemas['User']"],
    ['an array', { type: 'array', items: { type: 'string' } }, 'string[]'],
    [
      'an array of a union',
      { type: 'array', items: { type: ['string', 'null'] } },
      '(string | null)[]',
    ],
    ['an array without items', { type: 'array' }, 'unknown[]'],
    [
      'anyOf, without duplicates',
      { anyOf: [{ type: 'string' }, { type: 'null' }, { type: 'string' }] },
      'string | null',
    ],
    ['oneOf', { oneOf: [{ type: 'number' }, { type: 'boolean' }] }, 'number | boolean'],
    ['an empty object', { type: 'object' }, 'Record<string, never>'],
    [
      'a map',
      { type: 'object', additionalProperties: { type: 'number' } },
      '{\n  [key: string]: number\n}',
    ],
    [
      'an open object',
      { type: 'object', additionalProperties: true },
      '{\n  [key: string]: unknown\n}',
    ],
    [
      'an open object written as the empty schema (a Zod loose object)',
      { type: 'object', properties: { id: { type: 'string' } }, additionalProperties: {} },
      '{\n  id?: string\n  [key: string]: unknown\n}',
    ],
  ] as [string, SchemaNode, string][])('%s', (_name, node, expected) => {
    expect(renderType(node)).toBe(expected)
  })

  test('an object marks optional properties, quotes odd names and keeps descriptions', () => {
    expect(
      renderType({
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
          'x-odd': { type: 'boolean', description: 'An odd one.' },
        },
      })
    ).toBe("{\n  id: string\n  /** An odd one. */\n  'x-odd'?: boolean\n}")
  })

  test('a map with named optional entries widens its index signature so both typecheck', () => {
    expect(
      renderType({
        type: 'object',
        properties: { web: { type: 'number' } },
        additionalProperties: { type: 'number' },
      })
    ).toBe('{\n  web?: number\n  [key: string]: number | undefined\n}')
    expect(
      renderType({
        type: 'object',
        required: ['web'],
        properties: { web: { type: 'number' } },
        additionalProperties: { type: 'number' },
      })
    ).toBe('{\n  web: number\n  [key: string]: number\n}')
  })

  test.each([
    ['allOf', { allOf: [{ type: 'string' }] }, /unsupported JSON Schema keyword "allOf"/],
    ['not', { not: { type: 'string' } }, /"not"/],
    ['an unknown type', { type: 'date' }, /unsupported JSON Schema type "date"/],
    ['no type at all', {}, /unsupported JSON Schema type undefined/],
    ['a foreign reference', { $ref: 'other.json#/x' }, /unsupported \$ref/],
  ] as [string, SchemaNode, RegExp][])(
    '%s fails the generation instead of guessing',
    (_name, node, message) => {
      expect(() => renderType(node)).toThrow(message)
    }
  )
})

function document(overrides: Partial<OpenApiDocument> = {}): OpenApiDocument {
  return {
    components: {
      schemas: {
        Thing: { type: 'object', properties: { part: { $ref: '#/components/schemas/Part' } } },
        Part: { type: 'string' },
        AdminOnly: { type: 'string' },
        Failure: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
      },
    },
    paths: {
      '/v1/client/things/{thingId}': {
        get: {
          operationId: 'getThing',
          summary: 'Get a thing',
          security: [{ publishableKey: [], accessToken: [] }],
          parameters: [
            { in: 'path', name: 'thingId', required: true },
            { in: 'header', name: 'x-tula-attempt' },
          ],
          responses: {
            200: {
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Thing' } } },
            },
            404: {
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Failure' } } },
            },
          },
        },
      },
      '/v1/client/things': {
        post: {
          operationId: 'createThing',
          requestBody: {
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Part' } } },
          },
          responses: { 204: {} },
        },
      },
      '/v1/admin/things': {
        get: {
          operationId: 'adminThings',
          responses: {
            200: {
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/AdminOnly' } },
              },
            },
          },
        },
      },
    },
    ...overrides,
  }
}

describe('renderClientApi', () => {
  test('renders client operations only, with the schemas they reach (errors included)', () => {
    const source = renderClientApi(document())
    expect(source).toContain("  Thing: {\n    part?: Schemas['Part']\n  }")
    expect(source).toContain('  Part: string')
    expect(source).toContain('  Failure: {')
    expect(source).not.toContain('AdminOnly')
    expect(source).not.toContain('adminThings')
    expect(source).toContain('  /** Get a thing (`GET /v1/client/things/{thingId}`). */')
    expect(source).toContain(
      "  getThing: { params: { thingId: string }; body: undefined; response: Schemas['Thing'] }"
    )
    expect(source).toContain(
      "  createThing: { params: Record<string, never>; body: Schemas['Part']; response: undefined }"
    )
    expect(source).toContain(
      "  getThing: { method: 'GET', path: '/v1/client/things/{thingId}', session: true },"
    )
    expect(source).toContain(
      "  createThing: { method: 'POST', path: '/v1/client/things', session: false },"
    )
    // Operations are sorted by id, so the output does not depend on route registration order.
    expect(source.indexOf('createThing:')).toBeLessThan(source.indexOf('getThing:'))
  })

  test('an operation needs exactly one success response', () => {
    const broken = document()
    const operation = broken.paths['/v1/client/things']?.post
    if (operation) {
      operation.responses = { 200: {}, 204: {} }
    }
    expect(() => renderClientApi(broken)).toThrow('createThing: expected exactly one 2xx response')
  })

  test('a reference to a schema that does not exist fails', () => {
    const broken = document()
    delete broken.components.schemas.Part
    expect(() => renderClientApi(broken)).toThrow('schema "Part" is referenced but not defined')
  })

  test('the committed file is what the contract’s OpenAPI snapshot generates', async () => {
    const snapshot = await Bun.file(join(import.meta.dir, '../../contract/openapi.json')).json()
    const committed = await Bun.file(join(import.meta.dir, '../src/generated/api.gen.ts')).text()
    expect(renderClientApi(snapshot as OpenApiDocument)).toBe(committed)
  })
})

describe('renderAdminApi', () => {
  function adminDocument(): OpenApiDocument {
    const base = document()
    const list = base.paths['/v1/admin/things']?.get
    if (list) {
      list.security = [{ secretKey: [] }]
    }
    base.paths['/v1/admin/things/{thingId}'] = {
      put: {
        operationId: 'replaceThing',
        summary: 'Replace a thing',
        security: [{ secretKey: [] }],
        parameters: [
          { in: 'path', name: 'thingId', required: true },
          { in: 'header', name: 'If-Match', required: true, schema: { type: 'string' } },
          { in: 'header', name: 'x-tula-managed-by', schema: { type: 'string' } },
          { in: 'query', name: 'page', schema: { type: 'integer' } },
          { in: 'query', name: 'q', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Part' } } },
        },
        responses: {
          200: {
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Thing' } } },
          },
        },
      },
    }
    return base
  }

  test('renders admin operations only, with query and header parameters', () => {
    const source = renderAdminApi(adminDocument())
    expect(source).toContain('bun run --filter @tula/admin generate')
    expect(source).toContain('  AdminOnly: string')
    expect(source).not.toContain('getThing')
    expect(source).not.toContain('Failure')
    expect(source).toContain(
      '  adminThings: { params: Record<string, never>; query: Record<string, never>; ' +
        "headers: Record<string, never>; body: undefined; response: Schemas['AdminOnly'] }"
    )
    expect(source).toContain(
      '  replaceThing: { params: { thingId: string }; query: { page?: number; q: string }; ' +
        "headers: { 'If-Match': string; 'x-tula-managed-by'?: string }; " +
        "body: Schemas['Part']; response: Schemas['Thing'] }"
    )
    expect(source).toContain("  adminThings: { method: 'GET', path: '/v1/admin/things' },")
    expect(source).toContain(
      "  replaceThing: { method: 'PUT', path: '/v1/admin/things/{thingId}' },"
    )
    // No `session` column: every admin operation takes the secret key.
    expect(source).not.toContain('session:')
  })

  test('renders the instance operations beside the admin ones, with their own table', () => {
    const base = adminDocument()
    base.components.schemas.Health = { type: 'object', properties: { ok: { type: 'boolean' } } }
    base.paths['/v1/instance/health'] = {
      get: {
        operationId: 'getHealth',
        summary: 'Health',
        security: [{ instanceAdminToken: [] }],
        responses: {
          200: {
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Health' } } },
          },
        },
      },
    }
    const source = renderAdminApi(base)
    expect(source).toContain('  Health: {')
    expect(source).toContain(
      '  getHealth: { params: Record<string, never>; query: Record<string, never>; ' +
        "headers: Record<string, never>; body: undefined; response: Schemas['Health'] }"
    )
    expect(source).toContain("  getHealth: { method: 'GET', path: '/v1/instance/health' },")
    // In the instance table and interface, not the admin ones.
    const adminTable = source.slice(
      source.indexOf('export const OPERATIONS'),
      source.indexOf('export interface InstanceOperations')
    )
    expect(adminTable).not.toContain('getHealth')
    expect(source.slice(source.indexOf('export const INSTANCE_OPERATIONS'))).toContain('getHealth')
  })

  test('renders the event a webhook delivers, though no operation returns it', () => {
    const base = adminDocument()
    base.components.schemas.ThingMadeEvent = {
      type: 'object',
      properties: {
        type: { type: 'string', const: 'thing.made' },
        data: { $ref: '#/components/schemas/Part' },
      },
      required: ['type', 'data'],
    }
    base.components.schemas.TulaEvent = {
      oneOf: [{ $ref: '#/components/schemas/ThingMadeEvent' }],
    }
    const source = renderAdminApi(base)
    expect(source).toContain("  TulaEvent: Schemas['ThingMadeEvent']")
    expect(source).toContain("    type: 'thing.made'")
    // The client half has no use for it: a browser receives no webhook.
    expect(renderClientApi(base)).not.toContain('TulaEvent')
  })

  test('a document without events still renders', () => {
    expect(renderAdminApi(adminDocument())).not.toContain('TulaEvent')
  })

  test('an instance operation that does not take the admin token fails the generation', () => {
    const base = adminDocument()
    base.paths['/v1/instance/health'] = {
      get: {
        operationId: 'getHealth',
        security: [{ secretKey: [] }],
        responses: { 200: {} },
      },
    }
    expect(() => renderAdminApi(base)).toThrow('getHealth: an instance operation must take')
  })

  test('an operation the dashboard may also call (a session beside the credential) renders as before', () => {
    const base = adminDocument()
    const operation = base.paths['/v1/admin/things/{thingId}']?.put
    if (operation) {
      operation.security = [{ secretKey: [] }, { dashboardSession: [] }]
    }
    base.paths['/v1/instance/health'] = {
      get: {
        operationId: 'getHealth',
        security: [{ instanceAdminToken: [] }, { dashboardSession: [] }],
        responses: { 200: {} },
      },
    }
    const source = renderAdminApi(base)
    expect(source).toContain("  getHealth: { method: 'GET', path: '/v1/instance/health' },")
    expect(source).toContain('replaceThing')
  })

  test('the dashboard’s own session operations are a browser’s: left out, by name only', () => {
    const base = adminDocument()
    base.paths['/v1/instance/session'] = {
      post: { operationId: 'createDashboardSession', security: [], responses: { 200: {} } },
      get: {
        operationId: 'getDashboardSession',
        security: [{ dashboardSession: [] }],
        responses: { 200: {} },
      },
      delete: {
        operationId: 'deleteDashboardSession',
        security: [{ dashboardSession: [] }],
        responses: { 204: {} },
      },
    }
    const source = renderAdminApi(base)
    expect(source).not.toContain('DashboardSession')
    // Any other instance operation without the token still fails: a new route cannot drop
    // out of the client by forgetting its security.
    base.paths['/v1/instance/other'] = {
      get: {
        operationId: 'getOther',
        security: [{ dashboardSession: [] }],
        responses: { 200: {} },
      },
    }
    expect(() => renderAdminApi(base)).toThrow('getOther: an instance operation must take')
  })

  test('a parameter without a schema is a string', () => {
    const broken = adminDocument()
    const operation = broken.paths['/v1/admin/things/{thingId}']?.put
    if (operation) {
      operation.parameters = [{ in: 'query', name: 'sort' }]
    }
    expect(renderAdminApi(broken)).toContain('query: { sort?: string }')
  })

  test('an admin operation that does not take the secret key fails the generation', () => {
    const broken = adminDocument()
    const operation = broken.paths['/v1/admin/things/{thingId}']?.put
    if (operation) {
      operation.security = [{ publishableKey: [] }]
    }
    expect(() => renderAdminApi(broken)).toThrow('replaceThing: an admin operation must take')
  })
})
