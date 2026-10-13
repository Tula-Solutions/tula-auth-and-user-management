import { describe, expect, test } from 'bun:test'
import { createApp } from '../../../apps/api/src/index'
import { createTestDeps, seedApiKey } from '../../../apps/api/src/testing'
import {
  type AdminClient,
  type AdminFetch,
  createAdminClient,
  etagRevision,
  ifMatch,
  isTulaAdminError,
  type TulaAdminError,
} from './index'

// `@tula/admin` driven through its public API against the real server in process: memory
// adapters, and `fetch` handed straight to the app. What the client's own unit tests fake (an
// envelope, an ETag, a 204) is checked here against what the API really sends.

const SECRET_KEY = 'tula_sk_dev_adminclient000000000000000000000'
const PUBLISHABLE_KEY = 'tula_pk_dev_adminclient000000000000000000000'
const BASE_URL = 'http://localhost:3003'

async function world(secretKey = SECRET_KEY): Promise<{ admin: AdminClient; requests: string[] }> {
  const deps = createTestDeps()
  await seedApiKey(deps, SECRET_KEY)
  await seedApiKey(deps, PUBLISHABLE_KEY)
  const app = createApp(deps)
  const requests: string[] = []
  const fetch: AdminFetch = async (url, init) => {
    requests.push(`${init?.method ?? 'GET'} ${url.slice(BASE_URL.length)}`)
    return app.request(url, init)
  }
  return { admin: createAdminClient({ baseUrl: BASE_URL, secretKey, fetch }), requests }
}

async function failure(promise: Promise<unknown>): Promise<TulaAdminError> {
  try {
    await promise
  } catch (error) {
    if (isTulaAdminError(error)) {
      return error
    }
    throw error
  }
  throw new Error('expected the call to fail')
}

describe('@tula/admin against the API', () => {
  test('reads the settings with their revision and replaces them under If-Match', async () => {
    const { admin, requests } = await world()
    const read = await admin.call('getEnvironmentSettings')
    expect(read.data.revision).toBe(0)
    expect(etagRevision(read.etag)).toBe(0)

    const written = await admin.call('replaceEnvironmentSettings', {
      headers: { 'If-Match': ifMatch(read.data.revision) },
      body: { app: { name: 'Northline' } },
    })
    expect(written.data.revision).toBe(1)
    expect(etagRevision(written.etag)).toBe(1)
    expect(written.data.settings.app?.name).toBe('Northline')
    expect(requests).toEqual(['GET /v1/admin/settings', 'PUT /v1/admin/settings'])
  })

  test('a stale revision is precondition.failed and nothing is written', async () => {
    const { admin } = await world()
    await admin.call('replaceEnvironmentSettings', {
      headers: { 'If-Match': ifMatch(0) },
      body: { app: { name: 'First' } },
    })
    const error = await failure(
      admin.call('replaceEnvironmentSettings', {
        headers: { 'If-Match': ifMatch(0) },
        body: { app: { name: 'Second' } },
      })
    )
    expect(error.code).toBe('precondition.failed')
    expect(error.status).toBe(412)
    expect(error.operation).toBe('replaceEnvironmentSettings')
    expect((await admin.call('getEnvironmentSettings')).data.settings.app?.name).toBe('First')
  })

  test('a refused document names the field', async () => {
    const { admin } = await world()
    const error = await failure(
      admin.call('replaceEnvironmentSettings', {
        headers: { 'If-Match': ifMatch(0) },
        body: { mfa: { policy: 'sometimes' as 'off' } },
      })
    )
    expect(error.code).toBe('validation.failed')
    expect(error.status).toBe(422)
    expect(error.errors.map((problem) => problem.field)).toContain('mfa.policy')
  })

  test('providers: list, set (the secret is never returned) and remove (a 204)', async () => {
    const { admin } = await world()
    const before = await admin.call('listOAuthProviders')
    expect(before.data.data.map((provider) => provider.provider).sort()).toEqual([
      'apple',
      'discord',
      'facebook',
      'github',
      'google',
      'linkedin',
      'microsoft',
      'x',
    ])
    const secret = 'in-process-client-secret-value'
    const set = await admin.call('updateOAuthProvider', {
      params: { provider: 'github' },
      body: { clientId: 'gh-client', clientSecret: secret, enabled: true },
    })
    expect(set.data.configured).toBe(true)
    expect(JSON.stringify(set.data)).not.toContain(secret)
    const removed = await admin.call('deleteOAuthProvider', { params: { provider: 'github' } })
    expect(removed.status).toBe(204)
    expect(removed.data).toBeUndefined()
  })

  test('Microsoft: the tenant is typed, required, returned lower-cased, and the secret is not', async () => {
    const { admin } = await world()
    const secret = 'in-process-microsoft-secret-value'
    const missing = await failure(
      admin.call('updateOAuthProvider', {
        params: { provider: 'microsoft' },
        body: { clientId: 'ms-client', clientSecret: secret },
      })
    )
    expect(missing.status).toBe(422)
    expect(JSON.stringify(missing)).not.toContain(secret)
    const set = await admin.call('updateOAuthProvider', {
      params: { provider: 'microsoft' },
      body: {
        clientId: 'ms-client',
        clientSecret: secret,
        tenant: '72F988BF-86F1-41AF-91AB-2D7CD011DB47',
      },
    })
    expect(set.data.tenant).toBe('72f988bf-86f1-41af-91ab-2d7cd011db47')
    expect(JSON.stringify(set.data)).not.toContain(secret)
    const listed = await admin.call('listOAuthProviders')
    expect(listed.data.data.map((provider) => [provider.provider, provider.tenant]).sort()).toEqual(
      [
        ['apple', null],
        ['discord', null],
        ['facebook', null],
        ['github', null],
        ['google', null],
        ['linkedin', null],
        ['microsoft', '72f988bf-86f1-41af-91ab-2d7cd011db47'],
        ['x', null],
      ]
    )
  })

  test('query parameters reach the API', async () => {
    const { admin } = await world()
    const users = await admin.call('listUsers', { query: { page: 1, size: 5 } })
    expect(users.data.data).toEqual([])
  })

  test('a key the API does not know is auth.invalid_key, and the error does not carry it', async () => {
    const unknown = 'tula_sk_dev_nobodyknowsthiskey000000000000000'
    const { admin } = await world(unknown)
    const error = await failure(admin.call('getEnvironmentSettings'))
    expect(error.status).toBe(401)
    expect(error.code).toBe('auth.invalid_key')
    expect(JSON.stringify(error)).not.toContain(unknown)
  })

  test('a publishable key is refused before any request', async () => {
    let refused: unknown
    try {
      await world(PUBLISHABLE_KEY)
    } catch (error) {
      refused = error
    }
    expect(isTulaAdminError(refused) && refused.code).toBe('client.publishable_key')
  })
})
