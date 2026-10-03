import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { type OpenApiDocument, renderClientApi, renderType, type SchemaNode } from './openapi-types'

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
