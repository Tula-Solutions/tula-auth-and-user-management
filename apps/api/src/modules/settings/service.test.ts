import { beforeEach, describe, expect, test } from 'bun:test'
import {
  DEFAULT_ENVIRONMENT_SETTINGS,
  type EnvironmentSettings,
  PASSWORD_POLICY_PRESETS,
} from '@tula/contract'
import { cacheEnvironmentSettings } from '~/adapters/cache/environment-settings'
import { ServiceException } from '~/exceptions'
import * as Settings from '~/modules/settings/service'
import { createTestDeps, TEST_ACTOR, TEST_CONFIG, TEST_TENANT, type TestDeps } from '~/testing'

const tenant: { projectId: string; environmentId: string } = {
  projectId: TEST_TENANT.projectId,
  environmentId: TEST_TENANT.environmentId,
}
const other = { ...tenant, environmentId: TEST_TENANT.productionEnvironmentId }
let deps: TestDeps

beforeEach(() => {
  deps = createTestDeps()
})

function document(overrides: Partial<EnvironmentSettings> = {}): EnvironmentSettings {
  return { ...structuredClone(DEFAULT_ENVIRONMENT_SETTINGS), ...overrides }
}

const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error('expected a rejection')
    },
    (error: unknown) => error as ServiceException
  )

const replace = (expectedRevision: number, settings: EnvironmentSettings, scope = tenant) =>
  Settings.replace(deps, scope, { expectedRevision, settings }, TEST_ACTOR)

describe('defaults', () => {
  test('an environment that saved nothing is revision 0 with the contract defaults', async () => {
    expect(await Settings.get(deps, tenant)).toEqual({
      revision: 0,
      settings: DEFAULT_ENVIRONMENT_SETTINGS,
    })
  })

  test('PASSWORD_POLICY and CORS_ORIGINS are the defaults of such an environment', async () => {
    deps = createTestDeps({
      config: {
        ...TEST_CONFIG,
        passwordPolicy: PASSWORD_POLICY_PRESETS.strict,
        corsOrigins: ['https://app.test'],
      },
    })
    const settings = await Settings.current(deps, tenant)
    expect(settings.password).toEqual(PASSWORD_POLICY_PRESETS.strict)
    expect(settings.urls).toEqual({ allowedOrigins: ['https://app.test'], allowedRedirectUrls: [] })
  })

  test('once settings are saved the variables no longer apply to that environment', async () => {
    deps = createTestDeps({
      config: {
        ...TEST_CONFIG,
        passwordPolicy: PASSWORD_POLICY_PRESETS.strict,
        corsOrigins: ['https://app.test'],
      },
    })
    await replace(0, document({ app: { name: 'Acme', supportEmail: null } }))
    const settings = await Settings.current(deps, tenant)
    expect(settings.password).toEqual(PASSWORD_POLICY_PRESETS.recommended)
    expect(settings.urls.allowedOrigins).toEqual([])
    // The other environment still has none of its own.
    expect((await Settings.current(deps, other)).password).toEqual(PASSWORD_POLICY_PRESETS.strict)
  })

  test('the default document is a copy: changing it does not change the deployment list', () => {
    const config = { ...TEST_CONFIG, corsOrigins: ['https://app.test'] }
    Settings.defaults(config).urls.allowedOrigins.push('https://evil.test')
    expect(config.corsOrigins).toEqual(['https://app.test'])
  })
})

describe('replace', () => {
  test('the first save names revision 0 and becomes revision 1', async () => {
    const saved = await replace(0, document({ app: { name: 'Acme', supportEmail: null } }))
    expect(saved.revision).toBe(1)
    expect(saved.settings.app.name).toBe('Acme')
    expect(await Settings.get(deps, tenant)).toEqual(saved)
  })

  test('a stale revision is refused with the current one, and nothing changes', async () => {
    await replace(0, document({ app: { name: 'One', supportEmail: null } }))
    await replace(1, document({ app: { name: 'Two', supportEmail: null } }))
    const error = await rejection(
      replace(1, document({ app: { name: 'Stale', supportEmail: null } }))
    )
    expect(error).toBeInstanceOf(ServiceException)
    expect(error.toJSON()).toMatchObject({
      status: 412,
      code: 'precondition.failed',
      params: { revision: 2 },
    })
    expect((await Settings.current(deps, tenant)).app.name).toBe('Two')
    expect(deps.activityLog.ofType('environment.settings_updated')).toHaveLength(2)
  })

  test('a revision ahead of the stored one is refused too', async () => {
    const error = await rejection(replace(3, document()))
    expect(error.code).toBe('precondition.failed')
    expect(await deps.environmentSettings.get(tenant.environmentId)).toBeNull()
  })

  test('a writer that loses the race at the store is refused, not overwritten', async () => {
    // The read sees revision 1, then another writer saves revision 2 before this one writes.
    await replace(0, document({ app: { name: 'One', supportEmail: null } }))
    const store = deps.environmentSettings
    const racing = {
      get: store.get.bind(store),
      allowedOrigins: store.allowedOrigins.bind(store),
      replace: async (...args: Parameters<typeof store.replace>) => {
        await replace(1, document({ app: { name: 'Winner', supportEmail: null } }))
        return store.replace(...args)
      },
    }
    const error = await rejection(
      Settings.replace(
        { ...deps, environmentSettings: racing },
        tenant,
        {
          expectedRevision: 1,
          settings: document({ app: { name: 'Loser', supportEmail: null } }),
        },
        TEST_ACTOR
      )
    )
    expect(error.code).toBe('precondition.failed')
    expect(await Settings.get(deps, tenant)).toMatchObject({
      revision: 2,
      settings: { app: { name: 'Winner' } },
    })
  })

  test('the change is audited with the keys that changed and never their values', async () => {
    await replace(
      0,
      document({
        app: { name: 'Secret Project Falcon', supportEmail: 'help@falcon.test' },
        password: { ...PASSWORD_POLICY_PRESETS.recommended, preset: 'custom', minLength: 14 },
        urls: { allowedOrigins: ['https://falcon.test'], allowedRedirectUrls: [] },
        audit: { retentionDays: 400 },
      })
    )
    const [entry] = deps.activityLog.ofType('environment.settings_updated')
    expect(entry).toMatchObject({
      actor: { type: 'admin', id: TEST_ACTOR.id },
      target: { type: 'environment', id: tenant.environmentId },
      environmentId: tenant.environmentId,
      data: {
        revision: 1,
        changed: [
          'app.name',
          'app.supportEmail',
          'audit.retentionDays',
          'password.minLength',
          'password.preset',
          'urls.allowedOrigins',
        ],
      },
    })
    const recorded = JSON.stringify(entry)
    for (const value of ['Falcon', 'falcon.test', '14', '400']) {
      expect(recorded).not.toContain(value)
    }
  })

  test('saving the document that is already in force changes nothing and records nothing', async () => {
    expect(await replace(0, document())).toEqual({
      revision: 0,
      settings: DEFAULT_ENVIRONMENT_SETTINGS,
    })
    expect(await deps.environmentSettings.get(tenant.environmentId)).toBeNull()
    const saved = await replace(0, document({ app: { name: 'Acme', supportEmail: null } }))
    expect(await replace(1, structuredClone(saved.settings))).toEqual(saved)
    expect(deps.activityLog.ofType('environment.settings_updated')).toHaveLength(1)
  })

  test('one environment’s settings and revisions are its own', async () => {
    await replace(0, document({ app: { name: 'Dev', supportEmail: null } }))
    expect(await Settings.get(deps, other)).toMatchObject({ revision: 0 })
    expect((await rejection(replace(1, document(), other))).code).toBe('precondition.failed')
    await replace(0, document({ app: { name: 'Prod', supportEmail: null } }), other)
    expect((await Settings.current(deps, tenant)).app.name).toBe('Dev')
    expect((await Settings.current(deps, other)).app.name).toBe('Prod')
  })

  test('behind the cache, the check is made against what is stored, not what was cached', async () => {
    // Two instances over one store, with no shared marker: B's cache goes stale when A writes.
    const shared = deps.environmentSettings
    const a = { ...deps, environmentSettings: cacheEnvironmentSettings(shared, deps.clock, 30_000) }
    const b = { ...deps, environmentSettings: cacheEnvironmentSettings(shared, deps.clock, 30_000) }
    expect((await Settings.get(b, tenant)).revision).toBe(0)
    const input = (name: string, expectedRevision: number) => ({
      expectedRevision,
      settings: document({ app: { name, supportEmail: null } }),
    })
    await Settings.replace(a, tenant, input('From A', 0), TEST_ACTOR)
    // B still serves its cached copy to request paths...
    expect((await Settings.get(b, tenant)).revision).toBe(0)
    // ...but a replace through B that names the real revision goes through,
    expect((await Settings.replace(b, tenant, input('From B', 1), TEST_ACTOR)).revision).toBe(2)
    // one that names B's stale revision is refused,
    expect((await rejection(Settings.replace(a, tenant, input('Late', 1), TEST_ACTOR))).code).toBe(
      'precondition.failed'
    )
    // and the audit entry lists what changed against the stored document.
    expect(deps.activityLog.ofType('environment.settings_updated').at(-1)?.data).toEqual({
      revision: 2,
      changed: ['app.name'],
    })
    // A fresh read through either instance is the stored document.
    expect(await Settings.get(a, tenant, true)).toMatchObject({
      revision: 2,
      settings: { app: { name: 'From B' } },
    })
  })
})

describe('changedKeys', () => {
  test('lists dotted keys, sorted, comparing lists whole', () => {
    const before = document({
      urls: { allowedOrigins: ['https://a.test', 'https://b.test'], allowedRedirectUrls: [] },
    })
    const after = document({
      app: { name: 'Acme', supportEmail: null },
      urls: { allowedOrigins: ['https://b.test', 'https://a.test'], allowedRedirectUrls: [] },
    })
    expect(Settings.changedKeys(before, after)).toEqual(['app.name', 'urls.allowedOrigins'])
    expect(Settings.changedKeys(before, structuredClone(before))).toEqual([])
  })

  test('a key present on one side only counts as changed', () => {
    const before = document()
    const after = { ...document(), extra: { flag: true } } as unknown as EnvironmentSettings
    expect(Settings.changedKeys(before, after)).toEqual(['extra.flag'])
    expect(Settings.changedKeys(after, before)).toEqual(['extra.flag'])
  })
})

describe('expectedRevision and etag', () => {
  test.each<[string, string, number]>([
    ['the first save', '"0"', 0],
    ['a revision', '"12"', 12],
    ['surrounding whitespace', '  "3" ', 3],
  ])('%s', (_, header, revision) => {
    expect(Settings.expectedRevision(header)).toBe(revision)
    expect(Settings.etag(revision)).toBe(header.trim())
  })

  test.each<[string, string | undefined]>([
    ['a missing header', undefined],
    ['an empty header', ''],
    ['a blank header', '   '],
  ])('%s is precondition.required', (_, header) => {
    expect(() => Settings.expectedRevision(header)).toThrow(
      expect.objectContaining({ code: 'precondition.required', status: 428 })
    )
  })

  test.each<[string, string]>([
    ['the wildcard', '*'],
    ['a weak validator', 'W/"3"'],
    ['an unquoted number', '3'],
    ['a list', '"3", "4"'],
    ['a negative number', '"-1"'],
    ['a leading zero', '"03"'],
    ['a huge number', '"12345678901234567890"'],
    ['words', '"latest"'],
  ])('%s is precondition.failed', (_, header) => {
    expect(() => Settings.expectedRevision(header)).toThrow(
      expect.objectContaining({ code: 'precondition.failed', status: 412 })
    )
  })
})

describe('clientConfig', () => {
  test('holds the app, the enabled methods and the password policy, and no allow-list', () => {
    const settings = document({
      app: { name: 'Acme', supportEmail: 'help@acme.test' },
      urls: {
        allowedOrigins: ['https://acme.test'],
        allowedRedirectUrls: ['https://acme.test/cb'],
      },
      audit: { retentionDays: 30 },
    })
    const config = Settings.clientConfig(settings)
    expect(config).toEqual({
      app: { name: 'Acme', supportEmail: 'help@acme.test' },
      signIn: { methods: ['password'] },
      password: PASSWORD_POLICY_PRESETS.recommended,
    })
    expect(JSON.stringify(config)).not.toContain('https://acme.test')
  })

  test('a method that is switched off is not listed', () => {
    const settings = document({ signIn: { methods: { password: { enabled: false } } } })
    expect(Settings.clientConfig(settings).signIn.methods).toEqual([])
  })
})

describe('requireMethod', () => {
  test('passes while the method is enabled', async () => {
    await Settings.requireMethod(deps, tenant, 'password')
    await replace(0, document({ app: { name: 'Acme', supportEmail: null } }))
    await Settings.requireMethod(deps, tenant, 'password')
  })

  test('refuses a method the environment has switched off, and only there', async () => {
    deps.environmentSettings.seed(tenant.environmentId, {
      revision: 1,
      settings: document({ signIn: { methods: { password: { enabled: false } } } }),
    })
    const error = await rejection(Settings.requireMethod(deps, tenant, 'password'))
    expect(error.toJSON()).toEqual({
      status: 403,
      code: 'auth.method_disabled',
      detail: 'This sign-in method is not available.',
      params: { method: 'password' },
    })
    await Settings.requireMethod(deps, other, 'password')
  })
})
