import { beforeEach, describe, expect, spyOn, test } from 'bun:test'
import {
  type AccessTokenClaims,
  type EnvironmentSettings,
  MAX_CUSTOM_CLAIM_CONSTANT_LENGTH,
  MAX_JWT_TEMPLATE_CLAIMS,
  MAX_JWT_TEMPLATES,
} from '@tula/contract'
import { decodeJwt } from 'jose'
import { cacheEnvironmentSettings } from '~/adapters/cache/environment-settings'
import { createApp } from '~/index'
import * as logger from '~/lib/logger'
import * as Sessions from '~/modules/session/service'
import { createTestDeps, seedApiKey, TEST_TENANT, type TestDeps } from '~/testing'

// JWT templates through the settings API (ADR 0036): what a save refuses, what it records, and
// what a session of another instance or another environment gets.

const SK = 'tula_sk_dev_admin000000000000000000000000000000'
const PROD_SK = 'tula_sk_prod_admin00000000000000000000000000000'
const ADMIN = '/v1/admin/settings'
const USER = '00000000-0000-7000-8000-0000000000a1'
const tenant = { projectId: TEST_TENANT.projectId, environmentId: TEST_TENANT.environmentId }
const production = { ...tenant, environmentId: TEST_TENANT.productionEnvironmentId }

let deps: TestDeps
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  deps = createTestDeps()
  for (const [id, kind] of [
    [TEST_TENANT.environmentId, 'development'],
    [TEST_TENANT.productionEnvironmentId, 'production'],
  ] as const) {
    deps.environments.add({
      id,
      projectId: TEST_TENANT.projectId,
      kind,
      createdAt: deps.clock.now(),
    })
  }
  await seedApiKey(deps, SK)
  await seedApiKey(deps, PROD_SK, { environmentId: TEST_TENANT.productionEnvironmentId })
  app = createApp(deps)
})

interface State {
  revision: number
  settings: EnvironmentSettings
}

interface Failure {
  code: string
  errors?: { field: string; message: string }[]
}

function put(sessions: unknown, revision: number, key = SK) {
  return app.request(ADMIN, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
      'if-match': `"${revision}"`,
    },
    body: JSON.stringify({ sessions }),
  })
}

async function revisionNow(key = SK): Promise<number> {
  const res = await app.request(ADMIN, { headers: { authorization: `Bearer ${key}` } })
  return ((await res.json()) as State).revision
}

const role = { claims: { role: { value: 'member' } } }
const using = (jwtTemplate: string | null) => ({ web: { jwtTemplate } })
const lastEntry = () => deps.activityLog.ofType('environment.settings_updated').at(-1)?.data

function ext(tokens: Sessions.IssuedSession): AccessTokenClaims['ext'] {
  return decodeJwt<AccessTokenClaims>(tokens.accessToken ?? '').ext
}

describe('saving a template', () => {
  test('a template and the profile that uses it are stored and read back', async () => {
    const res = await put({ jwtTemplates: { app: role }, profiles: using('app') }, 0)
    expect(res.status).toBe(200)
    const { settings } = (await res.json()) as State
    expect(settings.sessions.jwtTemplates).toEqual({ app: role })
    expect(settings.sessions.profiles.web.jwtTemplate).toBe('app')
    expect(settings.sessions.profiles.mobile.jwtTemplate).toBeNull()
  })

  test.each<[string, unknown, string]>([
    [
      'a reserved key',
      { jwtTemplates: { app: { claims: { sub: { value: 'x' } } } } },
      'sessions.jwtTemplates.app.claims.sub',
    ],
    [
      'the namespace claim’s own name as a key',
      { jwtTemplates: { app: { claims: { ext: { value: 'x' } } } } },
      'sessions.jwtTemplates.app.claims.ext',
    ],
    [
      'the key reserved for device binding',
      { jwtTemplates: { app: { claims: { cnf: { value: 'x' } } } } },
      'sessions.jwtTemplates.app.claims.cnf',
    ],
    [
      'a malformed key',
      { jwtTemplates: { app: { claims: { 'my-claim': { value: 'x' } } } } },
      'sessions.jwtTemplates.app.claims.my-claim',
    ],
    [
      'a prototype key',
      { jwtTemplates: { app: { claims: { constructor: { value: 'x' } } } } },
      'sessions.jwtTemplates.app.claims.constructor',
    ],
    [
      'a source outside the list',
      { jwtTemplates: { app: { claims: { ip: { from: 'session.ip_address' } } } } },
      'sessions.jwtTemplates.app.claims.ip',
    ],
    [
      'a nested constant',
      { jwtTemplates: { app: { claims: { role: { value: { admin: true } } } } } },
      'sessions.jwtTemplates.app.claims.role',
    ],
    [
      'a constant over the length cap',
      {
        jwtTemplates: {
          app: { claims: { role: { value: 'x'.repeat(MAX_CUSTOM_CLAIM_CONSTANT_LENGTH + 1) } } },
        },
      },
      'sessions.jwtTemplates.app.claims.role.value',
    ],
    [
      'more claims than a template may hold',
      {
        jwtTemplates: {
          app: {
            claims: Object.fromEntries(
              Array.from({ length: MAX_JWT_TEMPLATE_CLAIMS + 1 }, (_, n) => [`c${n}`, { value: n }])
            ),
          },
        },
      },
      'sessions.jwtTemplates.app.claims',
    ],
    [
      'claims that could exceed the size cap',
      {
        jwtTemplates: {
          app: {
            claims: {
              email: { from: 'user.email' },
              a: { value: 'x'.repeat(256) },
              b: { value: 'y'.repeat(256) },
            },
          },
        },
      },
      'sessions.jwtTemplates.app.claims',
    ],
    [
      'more templates than an environment may have',
      {
        jwtTemplates: Object.fromEntries(
          Array.from({ length: MAX_JWT_TEMPLATES + 1 }, (_, n) => [`t${n}`, role])
        ),
      },
      'sessions.jwtTemplates',
    ],
    [
      'a malformed template name',
      { jwtTemplates: { App_One: role } },
      'sessions.jwtTemplates.App_One',
    ],
    [
      'a profile naming a template that does not exist',
      { profiles: using('missing') },
      'sessions.profiles.web.jwtTemplate',
    ],
    [
      'a profile naming an inherited key',
      { profiles: using('constructor') },
      'sessions.profiles.web.jwtTemplate',
    ],
    [
      'an unknown key in a template',
      { jwtTemplates: { app: { claims: {}, audience: 'x' } } },
      'sessions.jwtTemplates.app',
    ],
  ])('refuses %s, says where, and nothing changes', async (_label, sessions, field) => {
    const res = await put(sessions, 0)
    expect(res.status).toBe(422)
    const failure = (await res.json()) as Failure
    expect(failure.code).toBe('validation.failed')
    expect(failure.errors?.map((error) => error.field)).toContain(field)
    expect(await revisionNow()).toBe(0)
    expect(deps.activityLog.entries).toEqual([])
  })

  test('removing a template a profile still uses is refused; unsetting it in the same save is not', async () => {
    await put({ jwtTemplates: { app: role }, profiles: using('app') }, 0)
    const refused = await put({ jwtTemplates: {}, profiles: using('app') }, 1)
    expect(refused.status).toBe(422)
    expect(((await refused.json()) as Failure).errors?.map((error) => error.field)).toEqual([
      'sessions.profiles.web.jwtTemplate',
    ])
    expect(await revisionNow()).toBe(1)

    const removed = await put({ jwtTemplates: {}, profiles: using(null) }, 1)
    expect(removed.status).toBe(200)
  })
})

describe('what a save records', () => {
  test('says that templates changed and names the profile’s field, never a template, a key or a constant', async () => {
    await put(
      {
        jwtTemplates: { 'canary-name': { claims: { canary_key: { value: 'CANARY-constant' } } } },
        profiles: using('canary-name'),
      },
      0
    )
    expect(lastEntry()).toEqual({
      revision: 1,
      changed: ['sessions.jwtTemplates', 'sessions.profiles.web.jwtTemplate'],
    })
    const recorded = JSON.stringify(deps.activityLog.entries)
    expect(recorded).not.toContain('CANARY')
    expect(recorded).not.toContain('canary_key')
    expect(recorded).not.toContain('canary-name')
  })

  test('adding a claim is not a weakening; taking one away from sessions that carry it is', async () => {
    await put({ jwtTemplates: { app: role }, profiles: using('app') }, 0)
    await put(
      {
        jwtTemplates: { app: { claims: { role: { value: 'member' }, beta: { value: true } } } },
        profiles: using('app'),
      },
      1
    )
    expect(lastEntry()).toEqual({ revision: 2, changed: ['sessions.jwtTemplates'] })

    await put(
      { jwtTemplates: { app: { claims: { beta: { value: true } } } }, profiles: using('app') },
      2
    )
    expect(lastEntry()).toEqual({
      revision: 3,
      changed: ['sessions.jwtTemplates'],
      weakened: true,
    })

    await put({ jwtTemplates: { app: { claims: { beta: { value: true } } } } }, 3)
    expect(lastEntry()).toEqual({
      revision: 4,
      changed: ['sessions.profiles.web.jwtTemplate'],
      weakened: true,
    })
  })

  test('rewriting a template’s claims in another order changes nothing', async () => {
    const one = { claims: { a: { value: 1 }, b: { value: 2 } } }
    const other = { claims: { b: { value: 2 }, a: { value: 1 } } }
    await put({ jwtTemplates: { app: one } }, 0)
    const res = await put({ jwtTemplates: { app: other } }, 1)
    expect(res.status).toBe(200)
    expect(((await res.json()) as State).revision).toBe(1)
  })
})

describe('whose template a session gets', () => {
  test('never another environment’s', async () => {
    await put({ jwtTemplates: { app: role }, profiles: using('app') }, 0, PROD_SK)
    const ours = await Sessions.create(deps, tenant, { userId: USER, client: 'web' })
    const theirs = await Sessions.create(deps, production, { userId: USER, client: 'web' })
    expect(ext(ours)).toBeUndefined()
    expect(ext(theirs)).toEqual({ role: 'member' })
  })

  // Settings are cached per instance (ADR 0018): another instance may issue under the template
  // as it was a few seconds ago. That template was a valid one when it was saved; nothing a
  // stale read can produce is a claim no revision of the settings ever defined.
  test('an instance with a stale cache issues the template it last read, then the new one', async () => {
    const store = deps.environmentSettings
    const other = {
      ...deps,
      environmentSettings: cacheEnvironmentSettings(store, deps.clock, 30_000),
    }
    await put({ jwtTemplates: { app: role }, profiles: using('app') }, 0)
    const first = await Sessions.create(other, tenant, { userId: USER, client: 'web' })
    expect(ext(first)).toEqual({ role: 'member' })

    // Saved through the writer's instance; `other` has not heard.
    await put(
      { jwtTemplates: { app: { claims: { role: { value: 'owner' } } } }, profiles: using('app') },
      1
    )
    const stale = await Sessions.refresh(other, tenant, first.refreshToken ?? '')
    expect(ext(stale)).toEqual({ role: 'member' })
    const fresh = await Sessions.create(deps, tenant, { userId: USER, client: 'web' })
    expect(ext(fresh)).toEqual({ role: 'owner' })

    deps.clock.advance('31s')
    const caughtUp = await Sessions.refresh(other, tenant, stale.refreshToken ?? '')
    expect(ext(caughtUp)).toEqual({ role: 'owner' })
  })

  test('a stale instance that still names a removed template issues it until it catches up, then nothing', async () => {
    const other = {
      ...deps,
      environmentSettings: cacheEnvironmentSettings(deps.environmentSettings, deps.clock, 30_000),
    }
    await put({ jwtTemplates: { app: role }, profiles: using('app') }, 0)
    const first = await Sessions.create(other, tenant, { userId: USER, client: 'web' })
    await put({ jwtTemplates: {}, profiles: using(null) }, 1)
    deps.clock.advance('31s')
    const warn = spyOn(logger, 'warn')
    const refreshed = await Sessions.refresh(other, tenant, first.refreshToken ?? '')
    expect(ext(refreshed)).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('the session check a backend makes', () => {
  async function verify(token: string): Promise<AccessTokenClaims> {
    const res = await app.request('/v1/admin/sessions/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${SK}` },
      body: JSON.stringify({ token }),
    })
    expect(res.status).toBe(200)
    return (await res.json()) as AccessTokenClaims
  }

  test('answers a stateful session’s custom claims', async () => {
    await put(
      { jwtTemplates: { app: role }, profiles: { web: { type: 'stateful', jwtTemplate: 'app' } } },
      0
    )
    const session = await Sessions.create(deps, tenant, { userId: USER, client: 'web' })
    expect((await verify(session.sessionToken ?? '')).ext).toEqual({ role: 'member' })
  })

  test('answers an access token’s custom claims, and none where there is no template', async () => {
    const plain = await Sessions.create(deps, tenant, { userId: USER, client: 'web' })
    expect('ext' in (await verify(plain.accessToken ?? ''))).toBe(false)
    await put({ jwtTemplates: { app: role }, profiles: using('app') }, 0)
    const templated = await Sessions.create(deps, tenant, { userId: USER, client: 'web' })
    expect((await verify(templated.accessToken ?? '')).ext).toEqual({ role: 'member' })
  })
})
