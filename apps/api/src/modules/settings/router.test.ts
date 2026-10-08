import { beforeEach, describe, expect, test } from 'bun:test'
import {
  ClientConfigSchema,
  DEFAULT_ENVIRONMENT_SETTINGS,
  type EnvironmentSettings,
  MIN_PASSWORD_MIN_LENGTH,
  PASSWORD_POLICY_PRESETS,
} from '@tula/contract'
import { createApp } from '~/index'
import { ADMIN_RATE_LIMIT, CLIENT_RATE_LIMIT } from '~/middleware/rate-limit'
import { refreshCookieName } from '~/modules/session/cookies'
import * as Sessions from '~/modules/session/service'
import { createTestDeps, seedApiKey, TEST_CONFIG, TEST_TENANT, type TestDeps } from '~/testing'

const SK = 'tula_sk_dev_admin000000000000000000000000000000'
const PROD_SK = 'tula_sk_prod_admin00000000000000000000000000000'
const PK = 'tula_pk_dev_publishable0000000000000000000000000'
const PROD_PK = 'tula_pk_prod_publishable000000000000000000000000'
const ADMIN = '/v1/admin/settings'
const CONFIG = '/v1/client/config'

let deps: TestDeps
let app: ReturnType<typeof createApp>

async function build(config = TEST_CONFIG) {
  deps = createTestDeps({ config })
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
  await seedApiKey(deps, PK)
  await seedApiKey(deps, PROD_SK, { environmentId: TEST_TENANT.productionEnvironmentId })
  await seedApiKey(deps, PROD_PK, { environmentId: TEST_TENANT.productionEnvironmentId })
  app = createApp(deps)
}

beforeEach(() => build())

interface State {
  revision: number
  settings: EnvironmentSettings
  managedBy: null
}

interface Failure {
  status: number
  code: string
  params?: Record<string, unknown>
  errors?: { field: string }[]
}

const read = (key: string | null = SK) =>
  app.request(ADMIN, { headers: key ? { authorization: `Bearer ${key}` } : {} })

function put(body: unknown, ifMatch: string | null, key: string | null = SK) {
  return app.request(ADMIN, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      ...(key && { authorization: `Bearer ${key}` }),
      ...(ifMatch !== null && { 'if-match': ifMatch }),
    },
    body: JSON.stringify(body),
  })
}

const config = (key: string | null = PK, headers: Record<string, string> = {}) =>
  app.request(CONFIG, { headers: { ...(key && { 'x-tula-publishable-key': key }), ...headers } })

const strictPolicy = { ...PASSWORD_POLICY_PRESETS.strict }

describe('GET /v1/admin/settings', () => {
  test('an environment that saved nothing answers revision 0 with the defaults', async () => {
    const res = await read()
    expect(res.status).toBe(200)
    expect(res.headers.get('etag')).toBe('"0"')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect((await res.json()) as State).toEqual({
      revision: 0,
      settings: DEFAULT_ENVIRONMENT_SETTINGS,
      managedBy: null,
    })
  })

  test('the deployment’s variables show as that environment’s defaults', async () => {
    await build({
      ...TEST_CONFIG,
      passwordPolicy: PASSWORD_POLICY_PRESETS.legacy,
      corsOrigins: ['https://app.test'],
    })
    const { settings } = (await (await read()).json()) as State
    expect(settings.password).toEqual(PASSWORD_POLICY_PRESETS.legacy)
    expect(settings.urls.allowedOrigins).toEqual(['https://app.test'])
  })

  test.each<[string, string | null]>([
    ['no key', null],
    ['a publishable key', PK],
    ['an unknown secret key', `${SK.slice(0, -1)}1`],
  ])('%s is refused', async (_, key) => {
    const res = await read(key)
    expect(res.status).toBe(401)
    expect(((await res.json()) as Failure).code).toBe('auth.invalid_key')
  })

  test('shares the admin rate limit', async () => {
    for (let i = 0; i < ADMIN_RATE_LIMIT; i++) {
      await read()
    }
    const res = await read()
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBeTruthy()
  })
})

describe('PUT /v1/admin/settings', () => {
  test('replaces the whole document and answers the new revision', async () => {
    const res = await put(
      { app: { name: 'Acme', supportEmail: 'help@acme.test' }, password: strictPolicy },
      '"0"'
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('etag')).toBe('"1"')
    const saved = (await res.json()) as State
    expect(saved).toEqual({
      revision: 1,
      settings: {
        ...DEFAULT_ENVIRONMENT_SETTINGS,
        app: { name: 'Acme', supportEmail: 'help@acme.test' },
        password: strictPolicy,
      },
      managedBy: null,
    })
    expect((await (await read()).json()) as State).toEqual(saved)
  })

  test.each<['off' | 'optional' | 'required']>([['off'], ['optional'], ['required']])(
    'accepts the MFA policy `%s`, returns it, and the client config shows it',
    async (policy) => {
      const res = await put({ mfa: { policy } }, '"0"')
      expect(res.status).toBe(200)
      expect(((await res.json()) as State).settings.mfa).toEqual({ policy })
      expect(((await (await read()).json()) as State).settings.mfa).toEqual({ policy })
      expect(ClientConfigSchema.parse(await (await config()).json()).mfa).toEqual({ policy })
      // The other environment keeps its own.
      expect(ClientConfigSchema.parse(await (await config(PROD_PK)).json()).mfa).toEqual({
        policy: 'optional',
      })
    }
  )

  test('a document without `mfa` stores the default policy, and the notice switch is its own key', async () => {
    const res = await put({ notifications: { mfaChanged: false, identityChanged: true } }, '"0"')
    expect(res.status).toBe(200)
    const { settings } = (await res.json()) as State
    expect(settings.mfa).toEqual({ policy: 'optional' })
    expect(settings.notifications).toEqual({
      passwordChanged: true,
      newSignIn: true,
      mfaChanged: false,
      identityChanged: true,
    })
    expect(deps.activityLog.ofType('environment.settings_updated').at(-1)?.data).toEqual({
      revision: 1,
      changed: ['notifications.mfaChanged'],
      weakened: true,
    })
  })

  test.each<[string, unknown]>([
    ['a policy that does not exist', { mfa: { policy: 'mandatory' } }],
    ['a policy that is not a string', { mfa: { policy: true } }],
    ['an unknown key under mfa', { mfa: { policy: 'required', methods: ['sms'] } }],
    ['a notice switch that is not a boolean', { notifications: { mfaChanged: 'no' } }],
  ])('refuses %s, and nothing changes', async (_, body) => {
    const res = await put(body, '"0"')
    expect(res.status).toBe(422)
    const failure = (await res.json()) as Failure
    expect(failure.code).toBe('validation.failed')
    expect(((await (await read()).json()) as State).revision).toBe(0)
  })

  test('relaxing the MFA policy is recorded as a weakening', async () => {
    await put({ mfa: { policy: 'required' } }, '"0"')
    await put({ mfa: { policy: 'optional' } }, '"1"')
    expect(deps.activityLog.ofType('environment.settings_updated').at(-1)?.data).toEqual({
      revision: 2,
      changed: ['mfa.policy'],
      weakened: true,
    })
  })

  test('a section left out goes back to its default: the document is replaced, not merged', async () => {
    await put({ app: { name: 'Acme' }, audit: { retentionDays: 90 } }, '"0"')
    const res = await put({ app: { name: 'Acme' } }, '"1"')
    expect(((await res.json()) as State).settings.audit).toEqual({ retentionDays: null })
  })

  test('without If-Match the request is refused and nothing changes', async () => {
    const res = await put({ app: { name: 'Acme' } }, null)
    expect(res.status).toBe(428)
    expect((await res.json()) as unknown).toEqual({
      status: 428,
      code: 'precondition.required',
      detail: 'Send the revision you are changing in an If-Match header.',
    })
    expect(((await (await read()).json()) as State).revision).toBe(0)
  })

  test('a stale If-Match is refused with the current revision, and nothing changes', async () => {
    await put({ app: { name: 'One' } }, '"0"')
    const res = await put({ app: { name: 'Two' } }, '"0"')
    expect(res.status).toBe(412)
    expect((await res.json()) as Failure).toMatchObject({
      status: 412,
      code: 'precondition.failed',
      params: { revision: 1 },
    })
    expect(((await (await read()).json()) as State).settings.app.name).toBe('One')
  })

  test.each<[string, string]>([
    ['the wildcard', '*'],
    ['a weak validator', 'W/"0"'],
    ['an unquoted revision', '0'],
  ])('%s as If-Match cannot stand in for a revision', async (_, header) => {
    const res = await put({ app: { name: 'Acme' } }, header)
    expect(res.status).toBe(412)
    expect(((await (await read()).json()) as State).revision).toBe(0)
  })

  test.each<[string, unknown, string]>([
    ['an unknown section', { pasword: strictPolicy }, '(root)'],
    ['an unknown field', { app: { nmae: 'Acme' } }, 'app'],
    ['a name with a line break', { app: { name: 'Acme\r\nBcc: x@evil.test' } }, 'app.name'],
    ['a support address that is not one', { app: { supportEmail: 'nope' } }, 'app.supportEmail'],
    [
      'an origin with a path',
      { urls: { allowedOrigins: ['https://a.test/x'] } },
      'urls.allowedOrigins.0',
    ],
    [
      'a wildcard origin',
      { urls: { allowedOrigins: ['https://*.a.test'] } },
      'urls.allowedOrigins.0',
    ],
    [
      'a plain-http origin',
      { urls: { allowedOrigins: ['http://a.test'] } },
      'urls.allowedOrigins.0',
    ],
    [
      'a plain-http redirect',
      { urls: { allowedRedirectUrls: ['http://a.test/cb'] } },
      'urls.allowedRedirectUrls.0',
    ],
    [
      'every sign-in method off',
      { signIn: { methods: { password: { enabled: false } } } },
      'signIn.methods',
    ],
    [
      'a policy that cannot be met',
      { password: { ...strictPolicy, minLength: 200, maxLength: 100 } },
      'password.maxLength',
    ],
    ['a zero retention', { audit: { retentionDays: 0 } }, 'audit.retentionDays'],
  ])('%s is a validation error naming the field, and nothing is saved', async (_, body, field) => {
    const res = await put(body, '"0"')
    expect(res.status).toBe(422)
    const failure = (await res.json()) as Failure
    expect(failure.code).toBe('validation.failed')
    expect(failure.errors?.map((error) => error.field)).toContain(field)
    expect(((await (await read()).json()) as State).revision).toBe(0)
  })

  test('a validation error never echoes the submitted value', async () => {
    const res = await put({ app: { supportEmail: 'leaky-value-123' } }, '"0"')
    expect(await res.text()).not.toContain('leaky-value-123')
  })

  test('a body that is not JSON is malformed', async () => {
    const res = await app.request(ADMIN, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${SK}`,
        'if-match': '"0"',
      },
      body: '{not json',
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as Failure).code).toBe('request.malformed')
  })

  test.each<[string, string | null]>([
    ['no key', null],
    ['a publishable key', PK],
  ])('%s cannot change settings', async (_, key) => {
    const res = await put({ app: { name: 'Mine now' } }, '"0"', key)
    expect(res.status).toBe(401)
    expect(await deps.environmentSettings.get(TEST_TENANT.environmentId)).toBeNull()
  })

  test('the change is in the audit log with its keys, and neither values nor addresses', async () => {
    await put(
      {
        app: { name: 'Project Falcon', supportEmail: 'help@falcon.test' },
        urls: { allowedOrigins: ['https://falcon.test'] },
      },
      '"0"'
    )
    const res = await app.request('/v1/admin/audit-logs?action=environment.settings_updated', {
      headers: { authorization: `Bearer ${SK}` },
    })
    const text = await res.text()
    const body = JSON.parse(text) as {
      data: { action: string; actor: object; target: object; metadata: object }[]
    }
    expect(body.data).toHaveLength(1)
    expect(body.data[0]).toMatchObject({
      action: 'environment.settings_updated',
      actor: { type: 'admin' },
      target: { type: 'environment', id: TEST_TENANT.environmentId },
      metadata: {
        revision: 1,
        changed: ['app.name', 'app.supportEmail', 'urls.allowedOrigins'],
      },
    })
    expect(text).not.toContain('Falcon')
    expect(text).not.toContain('falcon.test')
  })

  test('a secret key changes only its own environment', async () => {
    await put({ app: { name: 'Dev only' } }, '"0"')
    expect(((await (await read(PROD_SK)).json()) as State).revision).toBe(0)
    const res = await put({ app: { name: 'Prod' } }, '"0"', PROD_SK)
    expect(res.status).toBe(200)
    expect(((await (await read()).json()) as State).settings.app.name).toBe('Dev only')
    expect(((await (await read(PROD_SK)).json()) as State).settings.app.name).toBe('Prod')
  })
})

describe('a managing-tool record this version would not answer', () => {
  const odd = { tool: 'Bad Tool!', configHash: 'x', at: 'now', revision: 1 }

  beforeEach(async () => {
    expect((await put({ app: { name: 'Acme' } }, '"0"')).status).toBe(200)
    deps.environmentSettings.seedManager(TEST_TENANT.environmentId, odd)
  })

  test('GET answers the settings as unmanaged instead of failing', async () => {
    const res = await read()
    expect(res.status).toBe(200)
    expect(((await res.json()) as State).managedBy).toBeNull()
  })

  test('a replace made by hand answers 200 for the write it committed', async () => {
    const res = await put({ app: { name: 'Edited' } }, '"1"')
    expect(res.status).toBe(200)
    const state = (await res.json()) as State
    expect(state.revision).toBe(2)
    expect(state.managedBy).toBeNull()
    expect((await deps.environmentSettings.get(TEST_TENANT.environmentId))?.revision).toBe(2)
  })

  test('a replace that names a manager records it', async () => {
    const res = await app.request(ADMIN, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${SK}`,
        'if-match': '"1"',
        'x-tula-managed-by': 'tula-apply',
        'x-tula-config-hash': `sha256:${'ab'.repeat(32)}`,
      },
      body: JSON.stringify({ app: { name: 'Applied' } }),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { managedBy: unknown }).managedBy).toMatchObject({
      tool: 'tula-apply',
      revision: 2,
      drifted: false,
    })
  })
})

describe('GET /v1/client/config', () => {
  test('returns the app, the enabled methods and the password policy', async () => {
    const res = await config()
    expect(res.status).toBe(200)
    expect(ClientConfigSchema.parse(await res.json())).toEqual({
      app: { name: 'Tula', supportEmail: null },
      signIn: { methods: ['password'], oauth: [] },
      signUp: { password: 'required' },
      password: PASSWORD_POLICY_PRESETS.recommended,
      mfa: { policy: 'optional' },
      phone: { enabled: false },
    })
  })

  test('reflects a change at once on the instance that made it, and nothing operator-only', async () => {
    await put(
      {
        app: { name: 'Acme', supportEmail: 'help@acme.test' },
        password: strictPolicy,
        urls: {
          allowedOrigins: ['https://acme.test'],
          allowedRedirectUrls: ['https://acme.test/cb'],
        },
        audit: { retentionDays: 90 },
      },
      '"0"'
    )
    const text = await (await config()).text()
    expect(JSON.parse(text)).toEqual({
      app: { name: 'Acme', supportEmail: 'help@acme.test' },
      signIn: { methods: ['password'], oauth: [] },
      signUp: { password: 'required' },
      password: strictPolicy,
      mfa: { policy: 'optional' },
      phone: { enabled: false },
    })
    expect(text).not.toContain('https://acme.test')
    expect(text).not.toContain('retentionDays')
  })

  test('is cacheable briefly, per key', async () => {
    const res = await config()
    expect(res.headers.get('cache-control')).toBe('private, max-age=60')
    expect(res.headers.get('vary')?.toLowerCase()).toContain('x-tula-publishable-key')
  })

  test.each<[string, string | null]>([
    ['no key', null],
    ['a secret key', SK],
    ['an unknown key', `${PK.slice(0, -1)}1`],
  ])('%s is refused', async (_, key) => {
    const res = await config(key)
    expect(res.status).toBe(401)
    expect(((await res.json()) as Failure).code).toBe('auth.invalid_key')
  })

  test('sits under the client rate limit', async () => {
    for (let i = 0; i < CLIENT_RATE_LIMIT; i++) {
      await config()
    }
    expect((await config()).status).toBe(429)
  })
})

describe('two environments in one deployment', () => {
  const signUp = (key: string, password: string) =>
    app.request('/v1/client/sign-ups', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tula-publishable-key': key,
        'x-tula-client': 'ios',
      },
      body: JSON.stringify({ email: `maya+${key.slice(8, 11)}@northline.app`, password }),
    })

  test('enforce different password policies', async () => {
    await put(
      { password: { ...PASSWORD_POLICY_PRESETS.recommended, preset: 'custom', minLength: 20 } },
      '"0"',
      PROD_SK
    )
    const password = 'plum-gravel-otter-7'
    expect(password).toHaveLength(19)

    const dev = await signUp(PK, password)
    expect(dev.status).toBe(200)

    const prod = await signUp(PROD_PK, password)
    expect(prod.status).toBe(422)
    expect((await prod.json()) as Failure).toMatchObject({
      code: 'password.too_short',
      params: { min: 20 },
    })

    const policy = async (key: string) => {
      const res = await app.request('/v1/client/password-policy', {
        headers: { 'x-tula-publishable-key': key },
      })
      return (await res.json()) as { minLength: number }
    }
    expect((await policy(PK)).minLength).toBe(10)
    expect((await policy(PROD_PK)).minLength).toBe(20)
    expect(
      ((await (await config(PROD_PK)).json()) as { password: { minLength: number } }).password
        .minLength
    ).toBe(20)
  })

  test('allow different browser origins', async () => {
    await build({ ...TEST_CONFIG, tier: 'prod' })
    await put({ urls: { allowedOrigins: ['https://dev.acme.test'] } }, '"0"')
    await put({ urls: { allowedOrigins: ['https://app.acme.test'] } }, '"0"', PROD_SK)

    const allowOrigin = async (key: string, origin: string) =>
      (await config(key, { origin })).headers.get('access-control-allow-origin')

    expect(await allowOrigin(PK, 'https://dev.acme.test')).toBe('https://dev.acme.test')
    expect(await allowOrigin(PROD_PK, 'https://app.acme.test')).toBe('https://app.acme.test')
    // Each origin is refused by the other environment.
    expect(await allowOrigin(PK, 'https://app.acme.test')).toBeNull()
    expect(await allowOrigin(PROD_PK, 'https://dev.acme.test')).toBeNull()
  })
})

describe('a replace that leaves sections out', () => {
  const ORIGIN = 'https://app.northline.app'

  test('with CORS_ORIGINS set, PUT {} keeps the origin working, cookie refresh included', async () => {
    await build({
      ...TEST_CONFIG,
      tier: 'prod',
      publicUrl: 'https://auth.northline.app',
      corsOrigins: [ORIGIN],
    })
    expect((await put({}, '"0"')).status).toBe(200)
    expect((await put({ app: { name: 'Northline' } }, '"0"')).status).toBe(200)
    const { settings } = (await (await read()).json()) as State
    expect(settings.urls.allowedOrigins).toEqual([ORIGIN])

    const tenant = { projectId: TEST_TENANT.projectId, environmentId: TEST_TENANT.environmentId }
    const tokens = await Sessions.create(deps, tenant, {
      userId: '00000000-0000-7000-8000-0000000000a1',
      client: 'web',
      userAgent: null,
      ipAddress: null,
    })
    const refresh = await app.request('/v1/client/sessions/refresh', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tula-publishable-key': PK,
        origin: ORIGIN,
        cookie: `${refreshCookieName(deps.config, tenant.environmentId)}=${tokens.refreshToken}`,
      },
      body: '{}',
    })
    expect(refresh.status).toBe(200)
    expect(refresh.headers.get('access-control-allow-origin')).toBe(ORIGIN)
  })

  test('with a strict deployment policy, PUT { app } keeps strict', async () => {
    await build({ ...TEST_CONFIG, passwordPolicy: PASSWORD_POLICY_PRESETS.strict })
    const res = await put({ app: { name: 'Acme' } }, '"0"')
    expect(((await res.json()) as State).settings.password).toEqual(PASSWORD_POLICY_PRESETS.strict)
    const policy = await app.request('/v1/client/password-policy', {
      headers: { 'x-tula-publishable-key': PK },
    })
    expect(await policy.json()).toEqual(PASSWORD_POLICY_PRESETS.strict)
  })

  test('an explicitly empty origin list is honoured', async () => {
    await build({ ...TEST_CONFIG, corsOrigins: [ORIGIN] })
    const res = await put({ urls: { allowedOrigins: [] } }, '"0"')
    expect(((await res.json()) as State).settings.urls.allowedOrigins).toEqual([])
  })
})

describe('the password policy has a floor', () => {
  const withMin = (minLength: number) => ({
    password: { ...PASSWORD_POLICY_PRESETS.recommended, preset: 'custom', minLength },
  })

  test('a minimum length under 8 is refused, naming the field', async () => {
    const res = await put(withMin(7), '"0"')
    expect(res.status).toBe(422)
    const failure = (await res.json()) as Failure
    expect(failure.errors?.map((error) => error.field)).toEqual(['password.minLength'])
    expect(((await (await read()).json()) as State).revision).toBe(0)
  })

  test('8 is accepted, and the change is flagged as a weakening in the audit log', async () => {
    expect((await put(withMin(8), '"0"')).status).toBe(200)
    expect(deps.activityLog.ofType('environment.settings_updated').at(-1)?.data).toEqual({
      revision: 1,
      changed: ['password.minLength', 'password.preset'],
      weakened: true,
    })
  })

  test('every shipped preset is at or above the floor', () => {
    for (const preset of Object.values(PASSWORD_POLICY_PRESETS)) {
      expect(preset.minLength).toBeGreaterThanOrEqual(MIN_PASSWORD_MIN_LENGTH)
    }
  })
})

describe('deployment defaults the settings cannot store', () => {
  const LAN = 'http://app.lan'

  beforeEach(() => build({ ...TEST_CONFIG, tier: 'prod', corsOrigins: [LAN] }))

  test.each<[string, unknown]>([
    ['an empty document', {}],
    ['a document that leaves the origins out', { app: { name: 'Acme' } }],
  ])(
    '%s is refused with a field error on urls.allowedOrigins, and nothing is written',
    async (_, body) => {
      const res = await put(body, '"0"')
      expect(res.status).toBe(422)
      const text = await res.text()
      const failure = JSON.parse(text) as Failure & { errors: { field: string; message: string }[] }
      expect(failure.code).toBe('validation.failed')
      expect(failure.errors).toEqual([
        {
          field: 'urls.allowedOrigins',
          code: 'validation.failed',
          message:
            'The deployment’s default origins (CORS_ORIGINS) include an entry settings cannot store. Send urls.allowedOrigins explicitly.',
        },
      ])
      // The offending value is the operator's own configuration, but an error never echoes input.
      expect(text).not.toContain('app.lan')
      expect(await deps.environmentSettings.get(TEST_TENANT.environmentId)).toBeNull()
      expect(deps.activityLog.entries).toEqual([])

      // The environment still reads, at the same revision, with its defaults.
      const after = await read()
      expect(after.status).toBe(200)
      expect(after.headers.get('etag')).toBe('"0"')
      expect(((await after.json()) as State).settings.urls.allowedOrigins).toEqual([LAN])
      expect((await config()).status).toBe(200)
      // And the default origin keeps working for browsers.
      expect((await config(PK, { origin: LAN })).headers.get('access-control-allow-origin')).toBe(
        LAN
      )
    }
  )

  test('sending the list explicitly is the way out', async () => {
    const res = await put({ urls: { allowedOrigins: ['https://app.acme.test'] } }, '"0"')
    expect(res.status).toBe(200)
    expect(((await res.json()) as State).settings.urls.allowedOrigins).toEqual([
      'https://app.acme.test',
    ])
  })

  test('a deployment default policy the settings cannot store is refused the same way', async () => {
    await build({
      ...TEST_CONFIG,
      passwordPolicy: { ...PASSWORD_POLICY_PRESETS.recommended, preset: 'custom', minLength: 6 },
    })
    const res = await put({ app: { name: 'Acme' } }, '"0"')
    expect(res.status).toBe(422)
    expect(((await res.json()) as { errors: unknown }).errors).toEqual([
      {
        field: 'password',
        code: 'validation.failed',
        message:
          'The deployment’s default password policy cannot be stored in settings. Send password explicitly.',
      },
    ])
    expect(await deps.environmentSettings.get(TEST_TENANT.environmentId)).toBeNull()
  })
})
