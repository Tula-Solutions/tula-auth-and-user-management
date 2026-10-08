import { describe, expect, test } from 'bun:test'
import {
  defineConfig,
  type EnvironmentConfig,
  type EnvironmentConfigInput,
  env,
} from '@tula/config'
import { DEFAULT_ENVIRONMENT_SETTINGS, type EnvironmentSettings } from '@tula/contract'
import {
  buildPlan,
  diffValues,
  orderOperations,
  type Plan,
  planProviders,
  type RemoteProvider,
  type RemoteState,
} from './diff'

const HASH = `sha256:${'a1'.repeat(32)}`

function environment(input: EnvironmentConfigInput = {}): EnvironmentConfig {
  const config = defineConfig({ environments: { dev: input } }).environments.dev
  if (!config) {
    throw new Error('fixture')
  }
  return config
}

function settings(patch: (settings: EnvironmentSettings) => void = () => {}): EnvironmentSettings {
  const next = structuredClone(DEFAULT_ENVIRONMENT_SETTINGS)
  patch(next)
  return next
}

function provider(
  name: RemoteProvider['provider'],
  over: Partial<RemoteProvider> = {}
): RemoteProvider {
  return {
    provider: name,
    configured: false,
    enabled: false,
    clientId: null,
    teamId: null,
    keyId: null,
    callbackUrl: `https://auth.example.com/v1/oauth/${name}/callback`,
    updatedAt: null,
    ...over,
  }
}

const NO_PROVIDERS = [provider('google'), provider('github'), provider('apple')]

function remote(over: Partial<RemoteState> = {}): RemoteState {
  return { revision: 3, settings: settings(), managedBy: null, providers: NO_PROVIDERS, ...over }
}

function plan(
  input: EnvironmentConfigInput,
  state: RemoteState = remote(),
  options: { prune?: boolean; rotateSecrets?: boolean } = {}
): Plan {
  return buildPlan(state, environment(input), { configHash: HASH, ...options })
}

describe('diffValues', () => {
  test.each([
    ['equal scalars', 1, 1, []],
    ['a changed scalar', 'a', 'b', [{ path: 'x', kind: 'changed', before: 'a', after: 'b' }]],
    ['null to a value', null, 'b', [{ path: 'x', kind: 'changed', before: null, after: 'b' }]],
    ['a value that appears', undefined, 5, [{ path: 'x', kind: 'added', after: 5 }]],
    ['a value that goes', 5, undefined, [{ path: 'x', kind: 'removed', before: 5 }]],
    ['a type change', 1, '1', [{ path: 'x', kind: 'changed', before: 1, after: '1' }]],
    [
      'an object replaced by a scalar',
      { a: 1 },
      2,
      [{ path: 'x', kind: 'changed', before: { a: 1 }, after: 2 }],
    ],
  ] as const)('%s', (_name, before, after, expected) => {
    expect(diffValues({ x: before }, { x: after })).toEqual(expected as never)
  })

  test('objects are compared key by key, at any depth, and keys set to undefined are absent', () => {
    expect(
      diffValues(
        { a: { b: { c: 1, d: 2 }, same: true }, gone: 1, undef: undefined },
        { a: { b: { c: 1, d: 3 }, same: true }, fresh: { whole: 'object' } }
      )
    ).toEqual([
      { path: 'a.b.d', kind: 'changed', before: 2, after: 3 },
      { path: 'fresh', kind: 'added', after: { whole: 'object' } },
      { path: 'gone', kind: 'removed', before: 1 },
    ])
  })

  test('a list on a set path ignores order and duplicates, and reports entries', () => {
    const paths = ['urls.allowedOrigins']
    expect(
      diffValues(
        { urls: { allowedOrigins: ['https://a.test', 'https://b.test'] } },
        { urls: { allowedOrigins: ['https://b.test', 'https://a.test', 'https://a.test'] } },
        paths
      )
    ).toEqual([])
    expect(
      diffValues(
        { urls: { allowedOrigins: ['https://a.test', 'https://b.test'] } },
        { urls: { allowedOrigins: ['https://c.test', 'https://a.test'] } },
        paths
      )
    ).toEqual([
      {
        path: 'urls.allowedOrigins',
        kind: 'changed',
        before: ['https://a.test', 'https://b.test'],
        after: ['https://c.test', 'https://a.test'],
        added: ['https://c.test'],
        removed: ['https://b.test'],
      },
    ])
  })

  test('any other list is ordered: the same entries in another order is a change', () => {
    expect(diffValues({ list: [1, 2] }, { list: [1, 2] })).toEqual([])
    expect(diffValues({ list: [1, 2] }, { list: [2, 1] })).toEqual([
      { path: 'list', kind: 'changed', before: [1, 2], after: [2, 1] },
    ])
  })
})

describe('planProviders', () => {
  const desired = environment({
    providers: {
      google: { clientId: 'g-client', clientSecret: env('GOOGLE_CLIENT_SECRET') },
      apple: { clientId: 'a', teamId: 'T', keyId: 'K', privateKey: env('APPLE_PRIVATE_KEY') },
    },
  }).providers

  test('a provider the server does not have is created, with its secret from the environment', () => {
    const [apple, google] = planProviders(NO_PROVIDERS, desired, {})
    expect(google).toEqual({
      provider: 'google',
      action: 'create',
      fields: [
        { path: 'clientId', kind: 'added', after: 'g-client' },
        { path: 'enabled', kind: 'added', after: true },
      ],
      secret: 'set',
      secretEnv: 'GOOGLE_CLIENT_SECRET',
      enabledBefore: false,
      enabledAfter: true,
    })
    expect(apple?.action).toBe('create')
    expect(apple?.fields.map((field) => field.path)).toEqual([
      'clientId',
      'teamId',
      'keyId',
      'enabled',
    ])
    expect(apple?.secretEnv).toBe('APPLE_PRIVATE_KEY')
  })

  test('a provider that is already as the file says is left alone, secret untouched', () => {
    const plans = planProviders(
      [
        provider('google', { configured: true, enabled: true, clientId: 'g-client' }),
        provider('apple', {
          configured: true,
          enabled: true,
          clientId: 'a',
          teamId: 'T',
          keyId: 'K',
        }),
      ],
      desired,
      {}
    )
    expect(plans.map((entry) => [entry.provider, entry.action, entry.secret])).toEqual([
      ['apple', 'none', 'keep'],
      ['google', 'none', 'keep'],
    ])
  })

  test('a changed client id is an update that sends the secret again', () => {
    const [, google] = planProviders(
      [provider('google', { configured: true, enabled: true, clientId: 'old' })],
      desired,
      {}
    )
    expect(google).toMatchObject({
      action: 'update',
      fields: [{ path: 'clientId', kind: 'changed', before: 'old', after: 'g-client' }],
      secret: 'set',
    })
  })

  test('switching a provider off or on keeps the stored secret', () => {
    const [, google] = planProviders(
      [provider('google', { configured: true, enabled: false, clientId: 'g-client' })],
      desired,
      {}
    )
    expect(google).toMatchObject({
      action: 'update',
      fields: [{ path: 'enabled', kind: 'changed', before: false, after: true }],
      secret: 'keep',
      enabledBefore: false,
      enabledAfter: true,
    })
  })

  test('--rotate-secrets sends every managed provider’s secret, changed or not', () => {
    const [, google] = planProviders(
      [provider('google', { configured: true, enabled: true, clientId: 'g-client' })],
      desired,
      { rotateSecrets: true }
    )
    expect(google).toMatchObject({ action: 'update', fields: [], secret: 'set' })
  })

  test('a provider the file leaves out is unmanaged, and deleted only with --prune', () => {
    const configured = [provider('github', { configured: true, enabled: true, clientId: 'gh' })]
    expect(planProviders(configured, {}, {})).toEqual([
      {
        provider: 'github',
        action: 'unmanaged',
        fields: [],
        secret: 'none',
        enabledBefore: true,
        enabledAfter: true,
      },
    ])
    expect(planProviders(configured, {}, { prune: true })).toMatchObject([
      { provider: 'github', action: 'delete', enabledBefore: true, enabledAfter: false },
    ])
    // Not configured and not in the file: nothing to say.
    expect(planProviders(NO_PROVIDERS, {}, { prune: true })).toEqual([])
  })
})

describe('buildPlan', () => {
  test('a file that says what the server has, recorded under the same hash, is no change', () => {
    const result = plan(
      {},
      remote({
        managedBy: {
          tool: 'tula-apply',
          configHash: HASH,
          at: '2026-01-01T00:00:00.000Z',
          revision: 3,
          drifted: false,
        },
      })
    )
    expect(result.changes).toBe(false)
    expect(result.settings).toEqual([])
    expect(result.marker).toMatchObject({ supported: true, pending: false })
    expect(orderOperations(result)).toEqual([])
  })

  test('the two deployment defaults the file leaves out are kept as the server has them', () => {
    const state = remote({
      settings: settings((s) => {
        s.password.minLength = 14
        s.urls.allowedOrigins = ['https://app.example.com']
      }),
    })
    const result = plan({ settings: { app: { name: 'Northline' } } }, state)
    expect(result.settings).toEqual([
      { path: 'app.name', kind: 'changed', before: 'Tula', after: 'Northline' },
    ])
    expect(result.kept).toEqual(['password', 'urls.allowedOrigins'])
    expect(result.body.password?.minLength).toBe(14)
    expect(result.body.urls.allowedOrigins).toEqual(['https://app.example.com'])
  })

  test('a field the file leaves out goes back to its default', () => {
    const state = remote({
      settings: settings((s) => {
        s.mfa.policy = 'required'
      }),
    })
    const result = plan({}, state)
    expect(result.settings).toEqual([
      { path: 'mfa.policy', kind: 'changed', before: 'required', after: 'optional' },
    ])
    expect(result.weakened).toEqual(['mfa.policy'])
  })

  test.each([
    ['a period where the server keeps entries for ever', null, 365, ['audit.retentionDays']],
    ['a shorter period', 365, 30, ['audit.retentionDays']],
    ['a longer period', 30, 365, []],
    ['the same period', 30, 30, []],
    ['no period (left out of the file) where there was one', 365, null, []],
  ] as [string, number | null, number | null, string[]][])(
    'audit retention: %s is flagged only when older entries would be deleted',
    (_name, was, is, weakened) => {
      const state = remote({
        settings: settings((s) => {
          s.audit.retentionDays = was
        }),
      })
      const file = is === null ? {} : { settings: { audit: { retentionDays: is } } }
      expect(plan(file, state).weakened).toEqual(weakened)
    }
  )

  test('weakenings are the contract’s: a shorter password and a longer session are both flagged', () => {
    const result = plan({
      settings: {
        password: { ...DEFAULT_ENVIRONMENT_SETTINGS.password, minLength: 8 },
        sessions: { profiles: { web: { idleTimeout: '300d', absoluteTimeout: null } } },
      },
    })
    expect(result.weakened).toEqual(['password.minLength', 'sessions.profiles.web'])
  })

  test('allowed origins and redirect URLs are sets: order alone is no change', () => {
    const state = remote({
      settings: settings((s) => {
        s.urls.allowedOrigins = ['https://a.test', 'https://b.test']
        s.urls.allowedRedirectUrls = ['https://a.test/cb', 'https://b.test/cb']
      }),
    })
    const same = plan(
      {
        settings: {
          urls: {
            allowedOrigins: ['https://b.test', 'https://a.test'],
            allowedRedirectUrls: ['https://b.test/cb', 'https://a.test/cb'],
          },
        },
      },
      state
    )
    expect(same.settings).toEqual([])
  })

  test('a session profile is added and removed as a whole', () => {
    const state = remote({
      settings: settings((s) => {
        s.sessions.profiles.old = structuredClone(s.sessions.profiles.web)
      }),
    })
    const result = plan(
      { settings: { sessions: { profiles: { kiosk: { idleTimeout: '5m' } } } } },
      state
    )
    expect(result.settings.map((change) => [change.path, change.kind])).toEqual([
      ['sessions.profiles.kiosk', 'added'],
      ['sessions.profiles.old', 'removed'],
    ])
    expect(result.unknown).toEqual([])
  })

  test('a setting the server has and this version does not know is reported, not hidden', () => {
    const state = remote({
      settings: { ...settings(), future: { feature: true } } as unknown as EnvironmentSettings,
    })
    const result = plan({}, state)
    expect(result.unknown).toEqual(['future'])
  })

  test.each([
    ['never applied', null, true, 'unmanaged'],
    [
      'applied from another version of the file',
      {
        tool: 'tula-apply',
        configHash: `sha256:${'00'.repeat(32)}`,
        at: 'x',
        revision: 3,
        drifted: false,
      },
      true,
      'other-config',
    ],
    [
      'changed around the file since',
      { tool: 'tula-apply', configHash: HASH, at: 'x', revision: 2, drifted: true },
      true,
      'drifted',
    ],
    [
      'managed by another tool',
      { tool: 'terraform', configHash: HASH, at: 'x', revision: 3, drifted: false },
      true,
      'other-tool',
    ],
  ] as const)(
    'the marker is pending when the settings were %s',
    (_name, managedBy, pending, reason) => {
      const result = plan({}, remote({ managedBy }))
      expect(result.marker).toMatchObject({ supported: true, pending, reason })
      expect(result.changes).toBe(true)
      expect(orderOperations(result).map((operation) => operation.kind)).toEqual(['settings'])
    }
  )

  test('a server that does not report a manager is not asked to record one', () => {
    const result = plan({}, remote({ managedBy: undefined }))
    expect(result.marker).toMatchObject({ supported: false, pending: false })
    expect(result.changes).toBe(false)
  })

  test('unmanaged providers are listed and are not a change', () => {
    const state = remote({
      managedBy: { tool: 'tula-apply', configHash: HASH, at: 'x', revision: 3, drifted: false },
      providers: [provider('github', { configured: true, enabled: true, clientId: 'gh' })],
    })
    const result = plan({}, state)
    expect(result.providers.map((entry) => entry.action)).toEqual(['unmanaged'])
    expect(result.changes).toBe(false)
    expect(plan({}, state, { prune: true }).changes).toBe(true)
  })
})

describe('orderOperations', () => {
  const managed = { tool: 'tula-apply', configHash: HASH, at: 'x', revision: 3, drifted: false }
  const google = { clientId: 'g', clientSecret: env('GOOGLE_CLIENT_SECRET') }

  function kinds(result: Plan): string[] {
    return orderOperations(result).map((operation) =>
      operation.kind === 'settings' ? 'settings' : `${operation.kind}:${operation.provider}`
    )
  }

  test('while a native method stays on, the settings go first: a stale revision stops everything', () => {
    const result = plan(
      { settings: { app: { name: 'New' } }, providers: { google } },
      remote({ managedBy: managed })
    )
    expect(kinds(result)).toEqual(['settings', 'provider.set:google'])
  })

  test('when the file switches every native method off, the provider is enabled first', () => {
    const result = plan(
      {
        settings: { signIn: { methods: { password: { enabled: false } } } },
        providers: { google },
      },
      remote({ managedBy: managed })
    )
    expect(kinds(result)).toEqual(['provider.set:google', 'settings'])
  })

  test('a provider is switched off or deleted only after the settings that replace it', () => {
    const state = remote({
      managedBy: managed,
      settings: settings((s) => {
        s.signIn.methods.password.enabled = false
      }),
      providers: [
        provider('google', { configured: true, enabled: true, clientId: 'g' }),
        provider('github', { configured: true, enabled: true, clientId: 'gh' }),
      ],
    })
    const result = plan({ providers: { google: { ...google, enabled: false } } }, state, {
      prune: true,
    })
    expect(kinds(result)).toEqual(['settings', 'provider.set:google', 'provider.delete:github'])
  })

  test('with no native method: enable, then the settings, then disable, then delete', () => {
    const state = remote({
      managedBy: managed,
      providers: [
        provider('github', { configured: true, enabled: true, clientId: 'gh' }),
        provider('apple', {
          configured: true,
          enabled: true,
          clientId: 'a',
          teamId: 'T',
          keyId: 'K',
        }),
      ],
    })
    const result = plan(
      {
        settings: { signIn: { methods: { password: { enabled: false } } } },
        providers: {
          google,
          github: { clientId: 'gh', clientSecret: env('GITHUB_CLIENT_SECRET'), enabled: false },
        },
      },
      state,
      { prune: true }
    )
    expect(kinds(result)).toEqual([
      'provider.set:google',
      'settings',
      'provider.set:github',
      'provider.delete:apple',
    ])
  })
})
