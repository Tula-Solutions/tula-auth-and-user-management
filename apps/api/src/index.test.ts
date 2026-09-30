import { describe, expect, test } from 'bun:test'
import { HTTPException } from 'hono/http-exception'
import { validator } from 'hono-openapi'
import { z } from 'zod'
import { validationHook } from '~/handlers'
import { createApp, OPENAPI_PATH } from '~/index'
import { createTestDeps, TEST_CONFIG } from '~/testing'

function appWithTestRoutes(config = TEST_CONFIG) {
  const app = createApp(createTestDeps({ config }))
  app.post(
    '/test/echo',
    validator('json', z.object({ email: z.email(), age: z.number().int() }), validationHook),
    (c) => c.json(c.req.valid('json'))
  )
  app.get('/test/crash', () => {
    throw new Error('connection to db.internal:5432 refused for user tula_api')
  })
  app.get('/test/http/:status', (c) => {
    throw new HTTPException(Number(c.req.param('status')) as 401, { message: 'framework detail' })
  })
  return app
}

describe('error envelope', () => {
  test('unknown routes return resource.not_found', async () => {
    const res = await appWithTestRoutes().request('/nope')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({
      status: 404,
      code: 'resource.not_found',
      detail: 'The requested resource does not exist.',
    })
  })

  test('invalid input returns validation.failed with one entry per field', async () => {
    const res = await appWithTestRoutes().request('/test/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email', age: 1.5 }),
    })
    expect(res.status).toBe(422)
    const body = (await res.json()) as { code: string; errors: { field: string; code: string }[] }
    expect(body.code).toBe('validation.failed')
    expect(body.errors.map((error) => [error.field, error.code])).toEqual([
      ['email', 'validation.failed'],
      ['age', 'validation.failed'],
    ])
    expect(JSON.stringify(body)).not.toContain('not-an-email')
  })

  test('valid input reaches the handler', async () => {
    const res = await appWithTestRoutes().request('/test/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'maya@example.com', age: 30 }),
    })
    expect(await res.json()).toEqual({ email: 'maya@example.com', age: 30 })
  })

  test('malformed JSON returns request.malformed without the parser message', async () => {
    const res = await appWithTestRoutes().request('/test/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"email":',
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      status: 400,
      code: 'request.malformed',
      detail: 'The request could not be read.',
    })
  })

  test('unexpected errors return a generic 500 that leaks nothing', async () => {
    const res = await appWithTestRoutes().request('/test/crash')
    expect(res.status).toBe(500)
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({
      status: 500,
      code: 'internal',
      detail: 'Something went wrong on our side.',
    })
    expect(text).not.toContain('tula_api')
  })

  test.each([
    [401, 'auth.unauthenticated'],
    [403, 'auth.forbidden'],
    [404, 'resource.not_found'],
    [409, 'resource.conflict'],
    [429, 'rate_limited'],
    [413, 'request.too_large'],
    [415, 'request.malformed'],
    [503, 'internal'],
  ])('framework HTTPException %i maps to %s', async (status, code) => {
    const res = await appWithTestRoutes().request(`/test/http/${status}`)
    const body = (await res.json()) as { status: number; code: string; detail: string }
    expect(body.code).toBe(code)
    expect(res.status).toBe(body.status)
    expect(body.detail).not.toContain('framework detail')
  })

  test('a body over the size limit keeps its 413 status', async () => {
    const res = await appWithTestRoutes().request('/test/http/413')
    expect(res.status).toBe(413)
    expect(await res.json()).toMatchObject({ status: 413, code: 'request.too_large' })
  })
})

describe('middleware', () => {
  test('every response carries a request id and security headers', async () => {
    const res = await appWithTestRoutes().request('/v1/status')
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN')
    expect(res.headers.get('strict-transport-security')).toContain('max-age=')
  })

  test('echoes a well-formed incoming request id', async () => {
    const res = await appWithTestRoutes().request('/v1/status', {
      headers: { 'x-request-id': 'trace-abc-123' },
    })
    expect(res.headers.get('x-request-id')).toBe('trace-abc-123')
  })

  test('CORS allows only configured origins, with credentials', async () => {
    const app = appWithTestRoutes({
      ...TEST_CONFIG,
      tier: 'prod',
      corsOrigins: ['https://app.test'],
    })
    const preflight = (origin: string) =>
      app.request('/v1/status', {
        method: 'OPTIONS',
        headers: { origin, 'access-control-request-method': 'POST' },
      })
    const allowed = await preflight('https://app.test')
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://app.test')
    expect(allowed.headers.get('access-control-allow-credentials')).toBe('true')
    expect(allowed.headers.get('access-control-allow-headers')).toContain('x-tula-publishable-key')
    const denied = await preflight('https://evil.test')
    expect(denied.headers.get('access-control-allow-origin')).toBeNull()
  })
})

describe('documentation routes', () => {
  test('serves the OpenAPI document with the shared security schemes and error schema', async () => {
    // Build a test-route app first: routes registered on one app must not leak into another's spec.
    appWithTestRoutes()
    const res = await createApp(createTestDeps()).request(OPENAPI_PATH)
    const doc = (await res.json()) as {
      openapi: string
      paths: Record<string, unknown>
      components: { securitySchemes: Record<string, unknown>; schemas: Record<string, unknown> }
    }
    expect(doc.openapi).toBe('3.1.0')
    expect(Object.keys(doc.paths)).toEqual([
      '/v1/status',
      '/v1/ready',
      '/v1/admin/environments',
      '/v1/admin/api-keys',
      '/v1/admin/api-keys/{id}',
      '/v1/environments/{environmentId}/.well-known/jwks.json',
      '/v1/admin/signing-keys',
      '/v1/admin/signing-keys/rotate',
    ])
    expect(Object.keys(doc.components.securitySchemes)).toEqual([
      'publishableKey',
      'accessToken',
      'secretKey',
    ])
    expect(doc.components.schemas).toHaveProperty('ErrorEnvelope')
  })

  test('serves the API reference page', async () => {
    const res = await appWithTestRoutes().request('/v1/docs')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
  })
})
