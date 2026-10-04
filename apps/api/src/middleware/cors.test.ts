import { beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { DEFAULT_ENVIRONMENT_SETTINGS } from '@tula/contract'
import type { AppConfig } from '~/dependencies'
import { createApp } from '~/index'
import * as logger from '~/lib/logger'
import { anyEnvironmentAllowsOrigin, environmentAllowsOrigin } from '~/middleware/cors'
import { createTestDeps, seedApiKey, TEST_CONFIG, TEST_TENANT, type TestDeps } from '~/testing'

const PK = 'tula_pk_dev_publishable0000000000000000000000000'
const PROD_PK = 'tula_pk_prod_publishable000000000000000000000000'
const SK = 'tula_sk_dev_admin000000000000000000000000000000'
const DEV_ORIGIN = 'https://dev.acme.test'
const PROD_ORIGIN = 'https://app.acme.test'
const DEPLOYMENT_ORIGIN = 'https://console.acme.test'
const EVIL = 'https://evil.test'
const dev = { environmentId: TEST_TENANT.environmentId }
const prod = { environmentId: TEST_TENANT.productionEnvironmentId }

const PROD_CONFIG: AppConfig = {
  ...TEST_CONFIG,
  tier: 'prod',
  publicUrl: 'https://auth.acme.test',
  corsOrigins: [DEPLOYMENT_ORIGIN],
}

let deps: TestDeps
let app: ReturnType<typeof createApp>

function allow(environmentId: string, origins: string[]) {
  deps.environmentSettings.seed(environmentId, {
    revision: 1,
    settings: {
      ...DEFAULT_ENVIRONMENT_SETTINGS,
      urls: { allowedOrigins: origins, allowedRedirectUrls: [] },
    },
  })
}

async function build(config: AppConfig = PROD_CONFIG) {
  deps = createTestDeps({ config })
  await seedApiKey(deps, PK)
  await seedApiKey(deps, SK)
  await seedApiKey(deps, PROD_PK, { environmentId: prod.environmentId })
  allow(dev.environmentId, [DEV_ORIGIN])
  allow(prod.environmentId, [PROD_ORIGIN])
  app = createApp(deps)
}

beforeEach(() => build())

const preflight = (path: string, origin: string, method = 'POST') =>
  app.request(path, {
    method: 'OPTIONS',
    headers: {
      origin,
      'access-control-request-method': method,
      'access-control-request-headers': 'content-type,x-tula-publishable-key',
    },
  })

const config = (key: string | null, origin?: string) =>
  app.request('/v1/client/config', {
    headers: { ...(key && { 'x-tula-publishable-key': key }), ...(origin && { origin }) },
  })

const allowOrigin = (res: Response) => res.headers.get('access-control-allow-origin')

describe('preflight', () => {
  test.each<[string, string]>([
    ['an origin one environment allows', DEV_ORIGIN],
    ['an origin another environment allows', PROD_ORIGIN],
    ['an origin on the deployment’s list', DEPLOYMENT_ORIGIN],
  ])('%s may send the request', async (_, origin) => {
    const res = await preflight('/v1/client/sign-ins', origin)
    expect(res.status).toBe(204)
    expect(allowOrigin(res)).toBe(origin)
    expect(res.headers.get('access-control-allow-credentials')).toBe('true')
    expect(res.headers.get('access-control-max-age')).toBe('600')
    expect(res.headers.get('vary')).toBe('Origin')
    const headers = res.headers.get('access-control-allow-headers') ?? ''
    for (const header of [
      'Content-Type',
      'Authorization',
      'If-Match',
      'x-tula-publishable-key',
      'x-tula-client',
    ]) {
      expect(headers).toContain(header)
    }
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(res.headers.get('access-control-allow-methods')).toContain(method)
    }
  })

  test.each<[string, string]>([
    ['an origin nobody allows', EVIL],
    ['a lookalike of an allowed origin', `${DEV_ORIGIN}.evil.test`],
    ['the same host over http', 'http://dev.acme.test'],
    ['the literal null origin', 'null'],
    ['a loopback origin outside the local tier', 'http://localhost:5173'],
  ])('%s gets no permission, and no wildcard', async (_, origin) => {
    const res = await preflight('/v1/client/sign-ins', origin)
    expect(res.status).toBe(204)
    expect(allowOrigin(res)).toBeNull()
    expect(res.headers.get('access-control-allow-credentials')).toBeNull()
    expect(res.headers.get('access-control-allow-methods')).toBeNull()
    expect(res.headers.get('vary')).toBe('Origin')
  })

  test('a preflight without an origin is answered with no CORS headers', async () => {
    const res = await app.request('/v1/client/sign-ins', { method: 'OPTIONS' })
    expect(res.status).toBe(204)
    expect(allowOrigin(res)).toBeNull()
  })

  test('admin routes follow the deployment’s list only', async () => {
    expect(allowOrigin(await preflight('/v1/admin/settings', DEPLOYMENT_ORIGIN, 'PUT'))).toBe(
      DEPLOYMENT_ORIGIN
    )
    expect(allowOrigin(await preflight('/v1/admin/settings', DEV_ORIGIN, 'PUT'))).toBeNull()
    expect(allowOrigin(await preflight('/v1/admin/users', PROD_ORIGIN))).toBeNull()
  })

  test('an origin stops being allowed when its environment removes it', async () => {
    expect(allowOrigin(await preflight('/v1/client/sign-ins', DEV_ORIGIN))).toBe(DEV_ORIGIN)
    allow(dev.environmentId, [])
    expect(allowOrigin(await preflight('/v1/client/sign-ins', DEV_ORIGIN))).toBeNull()
  })

  test('any loopback origin is allowed in the local tier', async () => {
    await build({ ...TEST_CONFIG, tier: 'local' })
    expect(allowOrigin(await preflight('/v1/client/sign-ins', 'http://localhost:5173'))).toBe(
      'http://localhost:5173'
    )
  })
})

describe('the request itself', () => {
  test('an origin the key’s environment allows may read the response', async () => {
    const res = await config(PK, DEV_ORIGIN)
    expect(res.status).toBe(200)
    expect(allowOrigin(res)).toBe(DEV_ORIGIN)
    expect(res.headers.get('access-control-allow-credentials')).toBe('true')
    expect(res.headers.get('access-control-expose-headers')).toBe(
      'Retry-After,X-Request-Id,ETag,x-tula-can-still-sign-in'
    )
    expect(res.headers.get('vary')?.split(/,\s*/)).toEqual(
      expect.arrayContaining(['Origin', 'x-tula-publishable-key'])
    )
  })

  test.each<[string, string, string]>([
    ['another environment’s origin', PK, PROD_ORIGIN],
    ['the reverse', PROD_PK, DEV_ORIGIN],
    ['the deployment’s list, once the environment has its own', PK, DEPLOYMENT_ORIGIN],
    ['an origin nobody allows', PK, EVIL],
    ['the literal null origin', PK, 'null'],
  ])(
    '%s may not: the request runs, the response carries no CORS headers',
    async (_, key, origin) => {
      const res = await config(key, origin)
      expect(res.status).toBe(200)
      expect(allowOrigin(res)).toBeNull()
      expect(res.headers.get('access-control-allow-credentials')).toBeNull()
      expect(res.headers.get('vary')).toContain('Origin')
    }
  )

  test('an environment without settings of its own uses the deployment’s list', async () => {
    deps = createTestDeps({ config: PROD_CONFIG })
    await seedApiKey(deps, PK)
    app = createApp(deps)
    expect(allowOrigin(await config(PK, DEPLOYMENT_ORIGIN))).toBe(DEPLOYMENT_ORIGIN)
    expect(allowOrigin(await config(PK, DEV_ORIGIN))).toBeNull()
  })

  test('a request without an origin gets no CORS headers but still varies by it', async () => {
    const res = await config(PK)
    expect(allowOrigin(res)).toBeNull()
    expect(res.headers.get('vary')).toContain('Origin')
  })

  test('the API’s own origin is always allowed', async () => {
    expect(allowOrigin(await config(PK, 'https://auth.acme.test'))).toBe('https://auth.acme.test')
  })

  test('an error from an allowed origin is readable, so a browser can show its code', async () => {
    const res = await app.request('/v1/client/sign-ins', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tula-publishable-key': PK,
        origin: DEV_ORIGIN,
      },
      body: '{}',
    })
    expect(res.status).toBe(422)
    expect(allowOrigin(res)).toBe(DEV_ORIGIN)
  })

  test.each<[string, string | null]>([
    ['an invalid key', `${PK.slice(0, -1)}1`],
    ['no key', null],
  ])(
    'with %s, an origin any environment allows can read the error; others cannot',
    async (_, key) => {
      const res = await config(key, PROD_ORIGIN)
      expect(res.status).toBe(401)
      expect(allowOrigin(res)).toBe(PROD_ORIGIN)
      expect(allowOrigin(await config(key, EVIL))).toBeNull()
    }
  )

  test('an unknown path answers the same way', async () => {
    const res = await app.request('/v1/nope', { headers: { origin: DEV_ORIGIN } })
    expect(res.status).toBe(404)
    expect(allowOrigin(res)).toBe(DEV_ORIGIN)
  })

  test('admin responses follow the deployment’s list, whatever the environment allows', async () => {
    const admin = (origin: string) =>
      app.request('/v1/admin/settings', { headers: { authorization: `Bearer ${SK}`, origin } })
    expect(allowOrigin(await admin(DEPLOYMENT_ORIGIN))).toBe(DEPLOYMENT_ORIGIN)
    expect(allowOrigin(await admin(DEV_ORIGIN))).toBeNull()
  })

  test('when the allow-list cannot be read the response is still sent, without CORS headers', async () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => {})
    deps.environmentSettings.get = async () => {
      throw new Error('connection refused: postgres://user:secret@db/tula')
    }
    // The handler itself does not read settings, so only the CORS decision fails.
    const res = await app.request('/v1/client/me', {
      headers: { 'x-tula-publishable-key': PK, origin: DEV_ORIGIN },
    })
    expect(res.status).toBe(401)
    expect(allowOrigin(res)).toBeNull()
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      'could not read the allowed origins; response sent without CORS headers',
    ])
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret')
    warn.mockRestore()
  })
})

describe('origin checks', () => {
  test('environmentAllowsOrigin is an exact match within one environment', async () => {
    expect(await environmentAllowsOrigin(deps, dev, DEV_ORIGIN)).toBe(true)
    expect(await environmentAllowsOrigin(deps, dev, PROD_ORIGIN)).toBe(false)
    expect(await environmentAllowsOrigin(deps, dev, `${DEV_ORIGIN}:8443`)).toBe(false)
    expect(await environmentAllowsOrigin(deps, dev, '')).toBe(false)
  })

  test('anyEnvironmentAllowsOrigin is the deployment’s list plus every environment’s', async () => {
    for (const origin of [DEV_ORIGIN, PROD_ORIGIN, DEPLOYMENT_ORIGIN]) {
      expect(await anyEnvironmentAllowsOrigin(deps, origin)).toBe(true)
    }
    expect(await anyEnvironmentAllowsOrigin(deps, EVIL)).toBe(false)
  })
})
