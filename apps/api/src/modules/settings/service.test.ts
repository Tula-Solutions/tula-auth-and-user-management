import { beforeEach, describe, expect, test } from 'bun:test'
import {
  DEFAULT_ENVIRONMENT_SETTINGS,
  type EnvironmentSettings,
  EnvironmentSettingsInputSchema,
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

describe('the MFA policy of an environment', () => {
  test('is `optional` for an environment that saved nothing', async () => {
    expect((await Settings.current(deps, tenant)).mfa).toEqual({ policy: 'optional' })
    expect((await Settings.current(deps, tenant)).notifications.mfaChanged).toBe(true)
  })

  test('is saved and read back, per environment', async () => {
    await replace(0, document({ mfa: { policy: 'required' } }))
    expect((await Settings.current(deps, tenant)).mfa.policy).toBe('required')
    expect((await Settings.current(deps, other)).mfa.policy).toBe('optional')
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
      signIn: { methods: ['password'], oauth: [] },
      signUp: { password: 'required' },
      password: PASSWORD_POLICY_PRESETS.recommended,
      mfa: { policy: 'optional' },
    })
    expect(JSON.stringify(config)).not.toContain('https://acme.test')
  })

  test.each<[EnvironmentSettings['mfa']['policy']]>([['off'], ['optional'], ['required']])(
    'shows the MFA policy `%s`, so a profile screen knows whether to offer it',
    (value) => {
      expect(Settings.clientConfig(document({ mfa: { policy: value } })).mfa).toEqual({
        policy: value,
      })
    }
  )

  test('a method that is switched off is not listed', () => {
    const settings = document({
      signIn: {
        methods: { ...DEFAULT_ENVIRONMENT_SETTINGS.signIn.methods, password: { enabled: false } },
      },
    })
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
      settings: document({
        signIn: {
          methods: { ...DEFAULT_ENVIRONMENT_SETTINGS.signIn.methods, password: { enabled: false } },
        },
      }),
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

describe('weakened', () => {
  const base = PASSWORD_POLICY_PRESETS.strict
  const policy = (overrides: Partial<typeof base>) =>
    document({ password: { ...base, preset: 'custom', ...overrides } })
  const strict = document({ password: { ...base, preset: 'custom' } })

  test.each<[string, Partial<typeof base>, boolean]>([
    ['nothing changed', {}, false],
    ['a shorter minimum length', { minLength: base.minLength - 1 }, true],
    ['a longer minimum length', { minLength: base.minLength + 1 }, false],
    ['the breach check from block to warn', { breachCheck: 'warn' }, true],
    ['the breach check from block to off', { breachCheck: 'off' }, true],
    ['lowercase no longer required', { requireLowercase: false }, true],
    ['uppercase no longer required', { requireUppercase: false }, true],
    ['a number no longer required', { requireNumber: false }, true],
    ['a special character no longer required', { requireSpecial: false }, true],
    ['user info allowed', { disallowUserInfo: false }, true],
    ['common passwords allowed', { disallowCommon: false }, true],
    ['sequences allowed', { blockSequences: false }, true],
    ['the repeat limit removed', { maxRepeatedChars: null }, true],
    ['a looser repeat limit', { maxRepeatedChars: 5 }, true],
    ['a tighter repeat limit', { maxRepeatedChars: 2 }, false],
    ['a shorter history', { history: 2 }, true],
    ['a longer history', { history: 10 }, false],
    ['a longer maximum length', { maxLength: 256 }, false],
    ['a different set of special characters', { specialChars: '!?' }, false],
    ['forced rotation removed', { expiryDays: null }, false],
  ])('%s → %p', (_, overrides, expected) => {
    expect(Settings.weakened(strict, policy(overrides))).toBe(expected)
  })

  test.each<[string, Partial<typeof base>, Partial<typeof base>, boolean]>([
    ['the breach check from warn to off', { breachCheck: 'warn' }, { breachCheck: 'off' }, true],
    ['the breach check from off to block', { breachCheck: 'off' }, { breachCheck: 'block' }, false],
    ['fewer character classes', { minCharacterClasses: 3 }, { minCharacterClasses: 2 }, true],
    ['more character classes', { minCharacterClasses: 2 }, { minCharacterClasses: 3 }, false],
    ['a repeat limit added', { maxRepeatedChars: null }, { maxRepeatedChars: 3 }, false],
    ['a rule turned on', { requireNumber: false }, { requireNumber: true }, false],
  ])('%s', (_, before, after, expected) => {
    expect(Settings.weakened(policy(before), policy(after))).toBe(expected)
  })

  test('one loosened rule is enough, whatever else got stricter', () => {
    expect(Settings.weakened(strict, policy({ minLength: 30, requireNumber: false }))).toBe(true)
  })

  test.each<[string, boolean, boolean, boolean, boolean]>([
    ['the password notice switched off', true, false, true, true],
    ['the new sign-in notice switched off', true, true, true, false],
    ['a notice switched on', false, true, true, true],
    ['a notice that stays off', false, false, true, true],
  ])('%s', (_, passwordWas, passwordIs, signInWas, signInIs) => {
    const before = document({
      notifications: {
        passwordChanged: passwordWas,
        newSignIn: signInWas,
        mfaChanged: true,
        identityChanged: true,
      },
    })
    const after = document({
      notifications: {
        passwordChanged: passwordIs,
        newSignIn: signInIs,
        mfaChanged: true,
        identityChanged: true,
      },
    })
    expect(Settings.weakened(before, after)).toBe(
      (passwordWas && !passwordIs) || (signInWas && !signInIs)
    )
  })

  test.each<[boolean, boolean, boolean]>([
    [true, false, true],
    [true, true, false],
    [false, true, false],
    [false, false, false],
  ])('the two-step verification notice from %p to %p → %p', (was, is, expected) => {
    const notifications = (mfaChanged: boolean) =>
      document({
        notifications: {
          passwordChanged: true,
          newSignIn: true,
          mfaChanged,
          identityChanged: true,
        },
      })
    expect(Settings.weakened(notifications(was), notifications(is))).toBe(expected)
  })

  type MfaPolicy = EnvironmentSettings['mfa']['policy']

  // Only a move towards `off` asks less of an account.
  test.each<[MfaPolicy, MfaPolicy, boolean]>([
    ['off', 'off', false],
    ['off', 'optional', false],
    ['off', 'required', false],
    ['optional', 'off', true],
    ['optional', 'optional', false],
    ['optional', 'required', false],
    ['required', 'off', true],
    ['required', 'optional', true],
    ['required', 'required', false],
  ])('the MFA policy from %s to %s → %p', (was, is, expected) => {
    expect(
      Settings.weakened(document({ mfa: { policy: was } }), document({ mfa: { policy: is } }))
    ).toBe(expected)
  })

  test('a stricter MFA policy does not hide a weaker password policy, nor the other way round', () => {
    expect(
      Settings.weakened(
        document({ password: strict.password, mfa: { policy: 'optional' } }),
        document({ password: policy({ minLength: 8 }).password, mfa: { policy: 'required' } })
      )
    ).toBe(true)
    expect(
      Settings.weakened(
        document({ password: policy({ minLength: 8 }).password, mfa: { policy: 'required' } }),
        document({ password: strict.password, mfa: { policy: 'optional' } })
      )
    ).toBe(true)
  })

  test('relaxing the MFA policy is flagged in the audit entry with the key, never the value', async () => {
    await replace(0, document({ mfa: { policy: 'required' } }))
    expect(deps.activityLog.ofType('environment.settings_updated').at(-1)?.data).toEqual({
      revision: 1,
      changed: ['mfa.policy'],
    })
    await replace(1, document({ mfa: { policy: 'off' } }))
    expect(deps.activityLog.ofType('environment.settings_updated').at(-1)?.data).toEqual({
      revision: 2,
      changed: ['mfa.policy'],
      weakened: true,
    })
    await replace(
      2,
      document({
        notifications: { ...document().notifications, mfaChanged: false, identityChanged: true },
      })
    )
    expect(deps.activityLog.ofType('environment.settings_updated').at(-1)?.data).toEqual({
      revision: 3,
      changed: ['mfa.policy', 'notifications.mfaChanged'],
      weakened: true,
    })
  })

  test('switching a security notice off is flagged in the audit entry, switching it on is not', async () => {
    const off = document({
      notifications: {
        passwordChanged: true,
        newSignIn: false,
        mfaChanged: true,
        identityChanged: true,
      },
    })
    await replace(0, off)
    expect(deps.activityLog.ofType('environment.settings_updated').at(-1)?.data).toEqual({
      revision: 1,
      changed: expect.arrayContaining(['notifications.newSignIn']),
      weakened: true,
    })
    await replace(1, {
      ...off,
      notifications: {
        passwordChanged: true,
        newSignIn: true,
        mfaChanged: true,
        identityChanged: true,
      },
    })
    expect(deps.activityLog.ofType('environment.settings_updated').at(-1)?.data).toEqual({
      revision: 2,
      changed: ['notifications.newSignIn'],
    })
  })

  test('changes outside the password policy are not a weakening', () => {
    const after = document({
      password: strict.password,
      app: { name: 'Acme', supportEmail: null },
      urls: { allowedOrigins: ['https://a.test'], allowedRedirectUrls: [] },
    })
    expect(Settings.weakened(strict, after)).toBe(false)
  })
})

describe('the audit entry says when a change weakened the password policy', () => {
  const recorded = () => deps.activityLog.ofType('environment.settings_updated').at(-1)?.data

  test('lowering the minimum length is flagged, without the lengths', async () => {
    await replace(0, document({ password: { ...PASSWORD_POLICY_PRESETS.strict } }))
    expect(recorded()).toEqual({
      revision: 1,
      changed: expect.arrayContaining(['password.minLength']),
    })
    await replace(
      1,
      document({ password: { ...PASSWORD_POLICY_PRESETS.strict, preset: 'custom', minLength: 9 } })
    )
    expect(recorded()).toEqual({
      revision: 2,
      changed: ['password.minLength', 'password.preset'],
      weakened: true,
    })
    expect(JSON.stringify(recorded())).not.toMatch(/\b(9|12)\b/)
  })

  test('a change that weakens nothing carries no flag', async () => {
    await replace(0, document({ app: { name: 'Acme', supportEmail: null } }))
    expect(recorded()).toEqual({ revision: 1, changed: ['app.name'] })
  })
})

describe('sections a replace leaves out take the deployment’s defaults', () => {
  const config = {
    ...TEST_CONFIG,
    passwordPolicy: PASSWORD_POLICY_PRESETS.strict,
    corsOrigins: ['https://app.test'],
  }
  const send = (expectedRevision: number, sent: Record<string, unknown>) =>
    Settings.replace(
      deps,
      tenant,
      { expectedRevision, settings: EnvironmentSettingsInputSchema.parse(sent) },
      TEST_ACTOR
    )

  beforeEach(() => {
    deps = createTestDeps({ config })
  })

  test.each<[string, Record<string, unknown>]>([
    ['an empty document', {}],
    [
      'a document with other sections only',
      { app: { name: 'Acme' }, audit: { retentionDays: 30 } },
    ],
    [
      'a urls section without allowedOrigins',
      { urls: { allowedRedirectUrls: ['https://app.test/cb'] } },
    ],
  ])('%s keeps PASSWORD_POLICY and CORS_ORIGINS', async (_, sent) => {
    const { settings } = await send(0, sent)
    expect(settings.password).toEqual(PASSWORD_POLICY_PRESETS.strict)
    expect(settings.urls.allowedOrigins).toEqual(['https://app.test'])
  })

  test('an empty document at revision 0 changes nothing at all', async () => {
    expect((await send(0, {})).revision).toBe(0)
    expect(deps.activityLog.entries).toEqual([])
  })

  test('what is sent explicitly is honoured as sent, an empty list included', async () => {
    const { settings } = await send(0, {
      password: PASSWORD_POLICY_PRESETS.recommended,
      urls: { allowedOrigins: [] },
    })
    expect(settings.password).toEqual(PASSWORD_POLICY_PRESETS.recommended)
    expect(settings.urls.allowedOrigins).toEqual([])
  })

  test('on a later replace an omitted section goes to the deployment default, not to its last value', async () => {
    await send(0, {
      password: { ...PASSWORD_POLICY_PRESETS.recommended, preset: 'custom', minLength: 16 },
      urls: { allowedOrigins: ['https://other.test'] },
    })
    const { settings, revision } = await send(1, { app: { name: 'Acme' } })
    expect(revision).toBe(2)
    expect(settings.password).toEqual(PASSWORD_POLICY_PRESETS.strict)
    expect(settings.urls.allowedOrigins).toEqual(['https://app.test'])
  })

  test('the stored list is a copy of the deployment list', async () => {
    const { settings } = await send(0, { app: { name: 'Acme' } })
    expect(settings.urls.allowedOrigins).not.toBe(config.corsOrigins)
  })
})
