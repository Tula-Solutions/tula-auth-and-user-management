import { describe, expect, spyOn, test } from 'bun:test'
import { HTTPException } from 'hono/http-exception'
import { validator } from 'hono-openapi'
import { z } from 'zod'
import { validationHook } from '~/handlers'
import { createApp, MAX_BODY_BYTES, OPENAPI_PATH } from '~/index'
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

  test('rejects request bodies over MAX_BODY_BYTES before auth runs', async () => {
    const res = await createApp(createTestDeps()).request('/v1/admin/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x'.repeat(MAX_BODY_BYTES) }),
    })
    expect(res.status).toBe(413)
    expect(await res.json()).toMatchObject({ status: 413, code: 'request.too_large' })
  })

  test('an oversized body from an allowed origin still gets CORS headers, so browsers see the code', async () => {
    const app = createApp(
      createTestDeps({ config: { ...TEST_CONFIG, corsOrigins: ['https://app.test'] } })
    )
    const res = await app.request('/v1/admin/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://app.test' },
      body: JSON.stringify({ name: 'x'.repeat(MAX_BODY_BYTES) }),
    })
    expect(res.status).toBe(413)
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.test')
    expect(await res.json()).toMatchObject({ code: 'request.too_large' })
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
      '/v1/client/password-policy',
      '/v1/client/sessions/refresh',
      '/v1/client/sessions/sign-out',
      '/v1/client/sessions',
      '/v1/client/sessions/revoke-others',
      '/v1/client/sessions/{sessionId}',
      '/v1/client/sessions/step-up',
      '/v1/client/sessions/step-up/email-code',
      '/v1/client/sessions/step-up/passkey',
      '/v1/admin/sessions/verify',
      '/v1/admin/users/{userId}/sessions',
      '/v1/admin/users/{userId}/sessions/{sessionId}',
      '/v1/client/sign-ups',
      '/v1/client/sign-ins',
      '/v1/client/sign-ins/{attemptId}/password',
      '/v1/client/sign-ins/{attemptId}/first-factor/prepare',
      '/v1/client/sign-ins/{attemptId}/first-factor/attempt',
      '/v1/client/sign-ins/link',
      '/v1/client/sign-ins/passkey',
      '/v1/client/sign-ins/{attemptId}/passkey',
      '/v1/client/sign-ins/oauth',
      '/v1/client/sign-ins/oauth/exchange',
      '/v1/client/sign-ups/{attemptId}/verify-email',
      '/v1/client/sign-ins/{attemptId}/verify-email',
      '/v1/client/password-resets',
      '/v1/client/password-resets/{attemptId}/password',
      '/v1/client/sign-ups/{attemptId}/resend-code',
      '/v1/client/sign-ins/{attemptId}/resend-code',
      '/v1/client/password-resets/{attemptId}/resend-code',
      '/v1/client/sign-ins/{attemptId}/second-factor',
      '/v1/client/sign-ins/{attemptId}/second-factor/passkey/options',
      '/v1/client/password-resets/{attemptId}/second-factor',
      '/v1/client/password-resets/{attemptId}/second-factor/passkey/options',
      '/v1/client/sign-ups/{attemptId}/factor-enrolment/totp',
      '/v1/client/sign-ups/{attemptId}/factor-enrolment/totp/confirm',
      '/v1/client/sign-ins/{attemptId}/factor-enrolment/totp',
      '/v1/client/sign-ins/{attemptId}/factor-enrolment/totp/confirm',
      '/v1/client/password-resets/{attemptId}/factor-enrolment/totp',
      '/v1/client/password-resets/{attemptId}/factor-enrolment/totp/confirm',
      '/v1/admin/users',
      '/v1/admin/users/{userId}',
      '/v1/admin/users/{userId}/authentication',
      '/v1/admin/users/{userId}/ban',
      '/v1/admin/users/{userId}/unban',
      '/v1/admin/users/{userId}/password',
      '/v1/client/me',
      '/v1/client/me/password',
      '/v1/client/me/factors',
      '/v1/client/me/factors/totp',
      '/v1/client/me/factors/totp/confirm',
      '/v1/client/me/factors/backup-codes',
      '/v1/admin/users/{userId}/factors',
      '/v1/admin/audit-logs',
      '/v1/admin/settings',
      '/v1/client/config',
      '/v1/admin/oauth-providers',
      '/v1/admin/oauth-providers/{provider}',
      '/v1/oauth/callback/{provider}',
      '/v1/client/me/identities',
      '/v1/client/me/identities/oauth',
      '/v1/client/me/identities/oauth/exchange',
      '/v1/client/me/identities/{identityId}',
      '/v1/client/me/passkeys',
      '/v1/client/me/passkeys/options',
      '/v1/client/me/passkeys/{passkeyId}',
      '/v1/client/me/phone',
      '/v1/client/me/phone/verify',
      '/v1/admin/webhook-endpoints',
      '/v1/admin/webhook-endpoints/{id}',
      '/v1/admin/webhook-endpoints/{id}/deliveries',
      '/v1/admin/webhook-endpoints/{id}/deliveries/{deliveryId}',
      '/v1/admin/webhook-endpoints/{id}/test',
      '/v1/admin/webhook-endpoints/{id}/deliveries/{deliveryId}/redeliver',
      '/v1/admin/webhook-endpoints/{id}/secret/rotate',
      '/v1/admin/webhook-endpoints/{id}/secret/previous',
      '/v1/admin/hooks',
      '/v1/admin/hooks/{id}',
      '/v1/instance/diagnostics',
      '/v1/instance/session',
      '/v1/instance/workspaces',
      '/v1/instance/projects',
      '/v1/instance/projects/{projectId}',
      '/v1/instance/environments',
      '/v1/instance/projects/{projectId}/environments',
      '/v1/instance/audit-logs',
    ])
    expect(Object.keys(doc.components.securitySchemes)).toEqual([
      'publishableKey',
      'accessToken',
      'secretKey',
      'instanceAdminToken',
      'dashboardSession',
    ])
    expect(doc.components.schemas).toHaveProperty('ErrorEnvelope')
  })

  test('serves the API reference page', async () => {
    const res = await appWithTestRoutes().request('/v1/docs')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
  })
})

describe('what a 500 logs', () => {
  test('a failed database query is logged without its SQL parameters', async () => {
    const { DrizzleQueryError } = await import('drizzle-orm/errors')
    const logger = await import('~/lib/logger')
    const logged = spyOn(logger, 'error').mockImplementation(() => undefined)
    try {
      const app = createApp(createTestDeps())
      app.get('/test/db-crash', () => {
        throw new DrizzleQueryError(
          'insert into "tula"."users" ("email", "secret") values ($1, $2)',
          ['maya@northline.app', '$argon2id$v=19$secret-hash'],
          Object.assign(new Error('connection terminated unexpectedly'), { code: '08006' })
        )
      })
      const res = await app.request('/test/db-crash')
      expect(res.status).toBe(500)
      expect(await res.json()).toMatchObject({ code: 'internal' })
      expect(logged).toHaveBeenCalledTimes(1)
      const written = JSON.stringify(logged.mock.calls[0])
      expect(written).toContain('08006')
      for (const secret of ['maya@northline.app', 'argon2id', 'secret-hash', 'Failed query']) {
        expect(written).not.toContain(secret)
      }
    } finally {
      logged.mockRestore()
    }
  })
})

describe('input the database cannot store', () => {
  // Postgres rejects a NUL character in text (SQLSTATE 22021) and in JSON (22P05). That is the
  // client's input, not a server fault.
  test.each(['22021', '22P05'])('SQLSTATE %s is a 400, not a 500', async (code) => {
    const app = createApp(createTestDeps())
    app.get('/test/nul', () => {
      throw new Error('Failed query', {
        cause: Object.assign(new Error('invalid byte sequence for encoding "UTF8": 0x00'), {
          code,
        }),
      })
    })
    const res = await app.request('/test/nul')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      status: 400,
      code: 'request.malformed',
      detail: 'The request could not be read.',
    })
  })

  test('any other database error is still a 500', async () => {
    const app = createApp(createTestDeps())
    app.get('/test/db', () => {
      throw Object.assign(new Error('deadlock detected'), { code: '40P01' })
    })
    expect((await app.request('/test/db')).status).toBe(500)
  })
})

describe('CORS methods', () => {
  test('a browser may call every method the API has routes for, including PUT', async () => {
    const app = createApp(
      createTestDeps({ config: { ...TEST_CONFIG, corsOrigins: ['https://app.test'] } })
    )
    const res = await app.request('/v1/admin/users/00000000-0000-7000-8000-000000000001/password', {
      method: 'OPTIONS',
      headers: { origin: 'https://app.test', 'access-control-request-method': 'PUT' },
    })
    const allowed = res.headers.get('access-control-allow-methods') ?? ''
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(allowed).toContain(method)
    }
  })
})

describe('the API document', () => {
  test('every operation that takes a body documents the 413 it can answer', async () => {
    const res = await createApp(createTestDeps()).request(OPENAPI_PATH)
    const doc = (await res.json()) as {
      paths: Record<string, Record<string, { requestBody?: unknown; responses: object }>>
    }
    const missing: string[] = []
    for (const [path, operations] of Object.entries(doc.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        if (operation.requestBody && !('413' in operation.responses)) {
          missing.push(`${method.toUpperCase()} ${path}`)
        }
      }
    }
    expect(missing).toEqual([])
  })

  test('setting a password documents the 409 for a user with no password', async () => {
    const res = await createApp(createTestDeps()).request(OPENAPI_PATH)
    const doc = (await res.json()) as {
      paths: Record<string, Record<string, { responses: object }>>
    }
    expect(doc.paths['/v1/admin/users/{userId}/password']?.put?.responses).toHaveProperty('409')
  })
})
