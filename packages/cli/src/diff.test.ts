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
  type HookChange,
  hookSnapshot,
  orderOperations,
  type Plan,
  planHooks,
  planProviders,
  planWebhooks,
  type RemoteHook,
  type RemoteProvider,
  type RemoteState,
  type RemoteWebhook,
  type WebhookChange,
  webhookSnapshot,
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
    tenant: null,
    callbackUrl: `https://auth.example.com/v1/oauth/${name}/callback`,
    updatedAt: null,
    ...over,
  }
}

const NO_PROVIDERS = [
  provider('google'),
  provider('github'),
  provider('apple'),
  provider('microsoft'),
]

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

  describe('Microsoft', () => {
    const microsoft = {
      clientId: 'ms-client',
      clientSecret: env('MICROSOFT_CLIENT_SECRET'),
      tenant: 'organizations',
    }
    const file = (over: Partial<typeof microsoft> & { enabled?: boolean } = {}) =>
      environment({ providers: { microsoft: { ...microsoft, ...over } } }).providers
    const stored = (over: Partial<RemoteProvider> = {}) => [
      provider('microsoft', {
        configured: true,
        enabled: true,
        clientId: 'ms-client',
        tenant: 'organizations',
        ...over,
      }),
    ]
    const TENANT_ID = '72f988bf-86f1-41af-91ab-2d7cd011db47'

    test('it is created with its tenant as a field and its secret from the environment', () => {
      expect(planProviders(NO_PROVIDERS, file(), {})).toEqual([
        {
          provider: 'microsoft',
          action: 'create',
          fields: [
            { path: 'clientId', kind: 'added', after: 'ms-client' },
            { path: 'tenant', kind: 'added', after: 'organizations' },
            { path: 'enabled', kind: 'added', after: true },
          ],
          secret: 'set',
          secretEnv: 'MICROSOFT_CLIENT_SECRET',
          enabledBefore: false,
          enabledAfter: true,
        },
      ])
    })

    // What each difference between the file and the server does to the provider and to its
    // stored secret. The tenant says which accounts may sign in, not which app registration
    // the secret belongs to: changing it keeps the secret, as switching the provider does.
    test.each([
      ['nothing differs', {}, {}, 'none', [], 'keep'],
      ['the tenant', { tenant: TENANT_ID }, {}, 'update', ['tenant'], 'keep'],
      [
        'the tenant, written in capitals',
        { tenant: TENANT_ID.toUpperCase() },
        { tenant: TENANT_ID },
        'none',
        [],
        'keep',
      ],
      ['an alias in capitals', { tenant: 'Organizations' }, {}, 'none', [], 'keep'],
      [
        'the tenant and the switch',
        { tenant: 'common', enabled: false },
        {},
        'update',
        ['tenant', 'enabled'],
        'keep',
      ],
      ['the client id', { clientId: 'other' }, {}, 'update', ['clientId'], 'set'],
      [
        'the client id and the tenant',
        { clientId: 'other', tenant: 'common' },
        {},
        'update',
        ['clientId', 'tenant'],
        'set',
      ],
      ['a server that reports no tenant', {}, { tenant: null }, 'update', ['tenant'], 'keep'],
    ] as const)('%s', (_name, inFile, onServer, action, fields, secret) => {
      const [plan] = planProviders(stored(onServer), file(inFile), {})
      expect(plan?.action).toBe(action)
      expect(plan?.fields.map((field) => field.path)).toEqual([...fields])
      expect(plan?.secret).toBe(secret)
    })

    // Pinned, not decided (TULA-12): a wider tenant admits accounts from more directories,
    // and nothing here calls that a weakening, so `apply --yes` makes the change without
    // `--allow-weaker`. Whether it should be one is the owner's question; this row is what
    // changes when it is answered.
    test.each([
      ['one organization to every organization', TENANT_ID, 'organizations'],
      ['one organization to any account', TENANT_ID, 'common'],
      ['every organization to any account', 'organizations', 'common'],
      ['personal accounts to any account', 'consumers', 'common'],
    ])(
      'widening the tenant (%s) is a change and is not flagged as a weakening',
      (_name, was, is) => {
        const state = remote({
          providers: [
            ...NO_PROVIDERS.filter((entry) => entry.provider !== 'microsoft'),
            ...stored({ tenant: was }),
          ],
        })
        const result = plan({ providers: { microsoft: { ...microsoft, tenant: is } } }, state)
        expect(result.providers.find((entry) => entry.provider === 'microsoft')?.fields).toEqual([
          { path: 'tenant', kind: 'changed', before: was, after: is },
        ])
        expect(result.weakened).toEqual([])
      }
    )

    test('a tenant change with --rotate-secrets sends the secret', () => {
      const [plan] = planProviders(stored(), file({ tenant: 'common' }), { rotateSecrets: true })
      expect(plan).toMatchObject({ action: 'update', secret: 'set' })
    })
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

  describe('JWT templates', () => {
    const app = { claims: { role: { value: 'member' }, email: { from: 'user.email' } } } as const
    /** A server that has these templates, with `web` using the one named. */
    const server = (templates: Record<string, unknown>, web: string | null = null) =>
      remote({
        settings: settings((s) => {
          s.sessions.jwtTemplates = structuredClone(templates) as never
          s.sessions.profiles.web.jwtTemplate = web
        }),
      })
    const file = (jwtTemplates: Record<string, unknown>, web: string | null = null) =>
      ({
        settings: { sessions: { jwtTemplates, profiles: { web: { jwtTemplate: web } } } },
      }) as never
    const lines = (result: ReturnType<typeof plan>) =>
      result.settings.map((change) => [change.path, change.kind])

    test.each<[string, Record<string, unknown>, Record<string, unknown>, [string, string][]]>([
      ['the same templates', { app }, { app }, []],
      [
        'templates and claims are sets: another order is no change',
        { app, other: { claims: {} } },
        {
          other: { claims: {} },
          app: { claims: { email: { from: 'user.email' }, role: { value: 'member' } } },
        },
        [],
      ],
      [
        'a template only the file has is added as a whole',
        {},
        { app },
        [['sessions.jwtTemplates.app', 'added']],
      ],
      [
        'a template only the server has is removed as a whole',
        { app },
        {},
        [['sessions.jwtTemplates.app', 'removed']],
      ],
      [
        'a claim only the file has is added by its key',
        { app },
        { app: { claims: { ...app.claims, beta: { value: true } } } },
        [['sessions.jwtTemplates.app.claims.beta', 'added']],
      ],
      [
        'a claim only the server has is removed by its key',
        { app },
        { app: { claims: { role: { value: 'member' } } } },
        [['sessions.jwtTemplates.app.claims.email', 'removed']],
      ],
      [
        'a constant that differs is one changed claim',
        { app },
        { app: { claims: { ...app.claims, role: { value: 'owner' } } } },
        [['sessions.jwtTemplates.app.claims.role', 'changed']],
      ],
      [
        'a claim that changes its kind of source is one changed claim, not a field each way',
        { app },
        { app: { claims: { ...app.claims, role: { from: 'session.client' } } } },
        [['sessions.jwtTemplates.app.claims.role', 'changed']],
      ],
    ])('%s', (_name, has, wants, expected) => {
      const result = plan(file(wants), server(has))
      expect(lines(result)).toEqual(expected)
      // A template or a claim the file does not have is the file's choice, never a setting
      // this version does not know.
      expect(result.unknown).toEqual([])
    })

    test('a changed claim shows both definitions whole', () => {
      const result = plan(
        file({ app: { claims: { ...app.claims, role: { from: 'session.client' } } } }),
        server({ app })
      )
      expect(result.settings).toEqual([
        {
          path: 'sessions.jwtTemplates.app.claims.role',
          kind: 'changed',
          before: { value: 'member' },
          after: { from: 'session.client' },
        },
      ])
    })

    test('a profile that starts or stops using a template is a change of its field', () => {
      expect(lines(plan(file({ app }, 'app'), server({ app })))).toEqual([
        ['sessions.profiles.web.jwtTemplate', 'changed'],
      ])
      expect(lines(plan(file({ app }), server({ app }, 'app')))).toEqual([
        ['sessions.profiles.web.jwtTemplate', 'changed'],
      ])
    })

    test.each<[string, Record<string, unknown>, string | null, string[]]>([
      [
        'the profile stops using its template',
        { app },
        null,
        ['sessions.profiles.web.jwtTemplate'],
      ],
      [
        'a claim its sessions carry is removed',
        { app: { claims: { role: { value: 'member' } } } },
        'app',
        ['sessions.profiles.web.jwtTemplate'],
      ],
      [
        'a claim its sessions carry changes',
        { app: { claims: { ...app.claims, role: { value: 'owner' } } } },
        'app',
        ['sessions.profiles.web.jwtTemplate'],
      ],
      [
        'a claim is added',
        { app: { claims: { ...app.claims, beta: { value: true } } } },
        'app',
        [],
      ],
      ['another template is added', { app, extra: { claims: {} } }, 'app', []],
    ])('weakening: %s', (_name, wants, web, weakened) => {
      expect(plan(file(wants, web), server({ app }, 'app')).weakened).toEqual(weakened)
    })

    test('a file that leaves templates out removes the server’s: flagged where a profile used one', () => {
      const result = plan({}, server({ app }, 'app'))
      expect(lines(result)).toEqual([
        ['sessions.profiles.web.jwtTemplate', 'changed'],
        ['sessions.jwtTemplates.app', 'removed'],
      ])
      expect(result.weakened).toEqual(['sessions.profiles.web.jwtTemplate'])
      expect(result.unknown).toEqual([])
    })
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
      operation.kind === 'provider.set' || operation.kind === 'provider.delete'
        ? `${operation.kind}:${operation.provider}`
        : operation.kind
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

const HOOK = 'https://hooks.northline.app/tula'

function endpoint(id: number, over: Partial<RemoteWebhook> = {}): RemoteWebhook {
  return {
    id: `00000000-0000-7000-8000-${String(id).padStart(12, '0')}`,
    url: `${HOOK}/${id}`,
    eventTypes: ['user.created'],
    enabled: true,
    disabledReason: null,
    failingSince: null,
    lastFailedAt: null,
    rotationOverlapEndsAt: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...over,
  }
}

const idOf = (id: number) => endpoint(id).id

describe('planWebhooks', () => {
  type Row = [
    name: string,
    remote: RemoteWebhook[],
    desired: NonNullable<EnvironmentConfigInput['webhooks']>,
    prune: boolean,
    expected: Partial<WebhookChange>[],
  ]
  const rows: Row[] = [
    [
      'an address the server does not have is created; enabled left out is not sent',
      [],
      [{ url: `${HOOK}/1`, eventTypes: ['user.deleted', 'user.created'] }],
      false,
      [
        {
          url: `${HOOK}/1`,
          action: 'create',
          fields: [{ path: 'eventTypes', kind: 'added', after: ['user.created', 'user.deleted'] }],
        },
      ],
    ],
    [
      'enabled written on a new endpoint is part of the creation',
      [],
      [{ url: `${HOOK}/1`, eventTypes: ['user.created'], enabled: false }],
      false,
      [
        {
          action: 'create',
          fields: [
            { path: 'eventTypes', kind: 'added', after: ['user.created'] },
            { path: 'enabled', kind: 'added', after: false },
          ],
        },
      ],
    ],
    [
      'the same address with the same event types is no change',
      [endpoint(1)],
      [{ url: `${HOOK}/1`, eventTypes: ['user.created'] }],
      false,
      [{ url: `${HOOK}/1`, id: idOf(1), action: 'none', fields: [] }],
    ],
    [
      'event types are a set: another order, and repeats in the file, are no change',
      [endpoint(1, { eventTypes: ['user.deleted', 'user.created'] })],
      [{ url: `${HOOK}/1`, eventTypes: ['user.created', 'user.deleted', 'user.created'] }],
      false,
      [{ action: 'none', fields: [] }],
    ],
    [
      'a changed set shows the types added and removed, sorted',
      [endpoint(1, { eventTypes: ['user.updated', 'user.created'] })],
      [{ url: `${HOOK}/1`, eventTypes: ['user.deleted', 'user.created', 'session.created'] }],
      false,
      [
        {
          action: 'update',
          id: idOf(1),
          fields: [
            {
              path: 'eventTypes',
              kind: 'changed',
              before: ['user.created', 'user.updated'],
              after: ['session.created', 'user.created', 'user.deleted'],
              added: ['session.created', 'user.deleted'],
              removed: ['user.updated'],
            },
          ],
        },
      ],
    ],
    [
      'enabled left out is not managed: an endpoint that is off stays off, unmentioned',
      [endpoint(1, { enabled: false, disabledReason: 'failing' })],
      [{ url: `${HOOK}/1`, eventTypes: ['user.created'] }],
      false,
      [{ action: 'none', fields: [] }],
    ],
    [
      'enabled written is managed: switching an endpoint off',
      [endpoint(1)],
      [{ url: `${HOOK}/1`, eventTypes: ['user.created'], enabled: false }],
      false,
      [
        {
          action: 'update',
          fields: [{ path: 'enabled', kind: 'changed', before: true, after: false }],
        },
      ],
    ],
    [
      'switching on an endpoint an administrator switched off carries no reason',
      [endpoint(1, { enabled: false })],
      [{ url: `${HOOK}/1`, eventTypes: ['user.created'], enabled: true }],
      false,
      [
        {
          action: 'update',
          fields: [{ path: 'enabled', kind: 'changed', before: false, after: true }],
        },
      ],
    ],
    [
      'switching on an endpoint the server switched off says why it was off',
      [endpoint(1, { enabled: false, disabledReason: 'failing' })],
      [{ url: `${HOOK}/1`, eventTypes: ['user.created'], enabled: true }],
      false,
      [
        {
          action: 'update',
          reenables: 'failing',
          fields: [{ path: 'enabled', kind: 'changed', before: false, after: true }],
        },
      ],
    ],
    [
      'an endpoint the list leaves out is unmanaged',
      [endpoint(1), endpoint(2)],
      [{ url: `${HOOK}/1`, eventTypes: ['user.created'] }],
      false,
      [{ action: 'none' }, { url: `${HOOK}/2`, id: idOf(2), action: 'unmanaged', fields: [] }],
    ],
    [
      'and removed with --prune',
      [endpoint(1), endpoint(2)],
      [{ url: `${HOOK}/1`, eventTypes: ['user.created'] }],
      true,
      [{ action: 'none' }, { url: `${HOOK}/2`, id: idOf(2), action: 'delete', fields: [] }],
    ],
    [
      'an empty list manages webhooks and has none: what the server has is unmanaged',
      [endpoint(1)],
      [],
      false,
      [{ action: 'unmanaged' }],
    ],
    [
      'a changed address is a new endpoint, and the old one is another: never an update',
      [endpoint(1)],
      [{ url: `${HOOK}/moved`, eventTypes: ['user.created'] }],
      true,
      [
        { url: `${HOOK}/moved`, action: 'create' },
        { url: `${HOOK}/1`, action: 'delete' },
      ],
    ],
    [
      'an address is compared exactly, as the server stores it: a trailing slash is another',
      [endpoint(1, { url: `${HOOK}/a/` })],
      [{ url: `${HOOK}/a`, eventTypes: ['user.created'] }],
      false,
      [
        { url: `${HOOK}/a`, action: 'create' },
        { url: `${HOOK}/a/`, action: 'unmanaged' },
      ],
    ],
    [
      'an address the server has twice cannot be matched: neither is touched',
      [endpoint(1, { url: HOOK }), endpoint(2, { url: HOOK }), endpoint(3)],
      [{ url: HOOK, eventTypes: ['user.deleted'], enabled: false }],
      true,
      [
        { url: HOOK, action: 'ambiguous', duplicates: [idOf(1), idOf(2)], fields: [] },
        { url: `${HOOK}/3`, action: 'delete' },
      ],
    ],
    [
      'an address the server has twice and the file does not name is two endpoints like any',
      [endpoint(1, { url: HOOK }), endpoint(2, { url: HOOK })],
      [],
      true,
      [
        { url: HOOK, id: idOf(1), action: 'delete' },
        { url: HOOK, id: idOf(2), action: 'delete' },
      ],
    ],
  ]

  test.each(rows)('%s', (_, remoteEndpoints, desired, prune, expected) => {
    const result = planWebhooks(remoteEndpoints, environment({ webhooks: desired }).webhooks, {
      prune,
    })
    expect(result.managed).toBe(true)
    expect(result.endpoints).toHaveLength(expected.length)
    expect(result.endpoints).toMatchObject(expected)
  })

  test('a file without the key manages nothing: no entry, whatever the server has, even with --prune', () => {
    expect(planWebhooks([endpoint(1)], undefined, { prune: true })).toEqual({
      managed: false,
      endpoints: [],
      removedFirst: 0,
      overLimit: null,
      seen: webhookSnapshot([]),
    })
    const result = plan({}, remote({ webhooks: undefined }), { prune: true })
    expect(result.webhooks.managed).toBe(false)
    expect(orderOperations(result).some((operation) => operation.kind.startsWith('webhook.'))).toBe(
      false
    )
  })

  test('an unchanged or unmanaged endpoint is not a change; a create, update or delete is', () => {
    const state = remote({
      managedBy: { tool: 'tula-apply', configHash: HASH, at: 'x', revision: 3, drifted: false },
      webhooks: [endpoint(1), endpoint(2)],
    })
    const same = { url: `${HOOK}/1`, eventTypes: ['user.created' as const] }
    expect(plan({ webhooks: [same] }, state).changes).toBe(false)
    expect(plan({ webhooks: [same] }, state, { prune: true }).changes).toBe(true)
    expect(plan({ webhooks: [{ ...same, enabled: false }] }, state).changes).toBe(true)
    expect(plan({ webhooks: [same, { ...same, url: `${HOOK}/3` }] }, state).changes).toBe(true)
  })

  test('the snapshot is the same for the same endpoints in any order, and moves with any field a plan reads', () => {
    const base = webhookSnapshot([endpoint(1), endpoint(2)])
    expect(webhookSnapshot([endpoint(2), endpoint(1)])).toBe(base)
    // Not what a plan reads: a delivery failing or a rotation must not make a plan stale.
    expect(
      webhookSnapshot([
        endpoint(1, { failingSince: '2026-10-02T00:00:00.000Z', updatedAt: 'later' }),
        endpoint(2),
      ])
    ).toBe(base)
    for (const moved of [
      [endpoint(1)],
      [endpoint(1), endpoint(2), endpoint(3)],
      [endpoint(1, { url: `${HOOK}/x` }), endpoint(2)],
      [endpoint(1, { eventTypes: ['user.deleted'] }), endpoint(2)],
      [endpoint(1, { enabled: false }), endpoint(2)],
      [endpoint(1, { enabled: false, disabledReason: 'gone' }), endpoint(2)],
    ]) {
      expect(webhookSnapshot(moved)).not.toBe(base)
    }
  })
})

describe('orderOperations: webhooks', () => {
  const google = { clientId: 'g', clientSecret: env('GOOGLE_CLIENT_SECRET') }
  const types = ['user.created' as const]

  function steps(result: Plan): string[] {
    return orderOperations(result).map((operation) => {
      if (operation.kind === 'settings') {
        return 'settings'
      }
      if ('point' in operation) {
        return `${operation.kind}:${operation.point}`
      }
      return operation.kind === 'provider.set' || operation.kind === 'provider.delete'
        ? `${operation.kind}:${operation.provider}`
        : `${operation.kind}:${operation.url.slice(HOOK.length + 1)}`
    })
  }

  const webhookSteps = (result: Plan) => steps(result).filter((step) => step.startsWith('webhook.'))

  test('webhooks come after the settings and every provider: nothing about sign-in waits for them', () => {
    const state = remote({
      providers: [provider('github', { configured: true, enabled: true, clientId: 'gh' })],
      webhooks: [endpoint(1), endpoint(2, { eventTypes: ['user.deleted'] })],
    })
    const result = plan(
      {
        settings: { app: { name: 'New' } },
        providers: { google },
        webhooks: [
          { url: `${HOOK}/3`, eventTypes: types },
          { url: `${HOOK}/2`, eventTypes: types },
        ],
      },
      state,
      { prune: true }
    )
    expect(steps(result)).toEqual([
      'settings',
      'provider.set:google',
      'provider.delete:github',
      'webhook.update:2',
      'webhook.create:3',
      'webhook.delete:1',
    ])
  })

  test('also when the settings wait for a provider', () => {
    const result = plan(
      {
        settings: { signIn: { methods: { password: { enabled: false } } } },
        providers: { google },
        webhooks: [{ url: `${HOOK}/1`, eventTypes: types }],
      },
      remote({ webhooks: [] })
    )
    expect(steps(result)).toEqual(['provider.set:google', 'settings', 'webhook.create:1'])
  })

  const ten = Array.from({ length: 10 }, (_, index) => endpoint(index + 1))
  const keep = (from: number, to: number) =>
    ten.slice(from - 1, to).map((entry) => ({ url: entry.url, eventTypes: types }))
  const fresh = (name: string) => ({ url: `${HOOK}/${name}`, eventTypes: types })

  test.each([
    [
      'room for the new one: created before anything is removed',
      ten.slice(0, 9),
      [...keep(1, 8), fresh('new')],
      0,
      ['webhook.create:new', 'webhook.delete:9'],
    ],
    [
      'at the limit, one replaced: exactly one removal goes first, the oldest being removed',
      ten,
      [...keep(1, 8), fresh('new')],
      1,
      ['webhook.delete:9', 'webhook.create:new', 'webhook.delete:10'],
    ],
    [
      'at the limit, two replaced by two: both removals first',
      ten,
      [...keep(1, 8), fresh('a'), fresh('b')],
      2,
      ['webhook.delete:9', 'webhook.delete:10', 'webhook.create:a', 'webhook.create:b'],
    ],
    [
      'one under the limit, two new, two removed: one removal first, no more than needed',
      ten.slice(0, 9),
      [...keep(1, 7), fresh('a'), fresh('b')],
      1,
      ['webhook.delete:8', 'webhook.create:a', 'webhook.create:b', 'webhook.delete:9'],
    ],
  ])('the limit of ten, %s', (_, existing, desired, removedFirst, expected) => {
    const result = plan({ webhooks: desired }, remote({ webhooks: existing }), { prune: true })
    expect(result.webhooks.removedFirst).toBe(removedFirst)
    expect(result.webhooks.overLimit).toBeNull()
    expect(webhookSteps(result)).toEqual(expected)
  })

  test('a plan that would leave more than ten says how many, and removes nothing first', () => {
    const result = plan({ webhooks: [fresh('new')] }, remote({ webhooks: ten }))
    expect(result.webhooks.overLimit).toBe(11)
    expect(result.webhooks.removedFirst).toBe(0)
  })

  test('an address that cannot be matched is no operation', () => {
    const result = plan(
      { webhooks: [{ url: HOOK, eventTypes: types, enabled: false }] },
      remote({ webhooks: [endpoint(1, { url: HOOK }), endpoint(2, { url: HOOK })] })
    )
    expect(webhookSteps(result)).toEqual([])
  })
})

describe('planHooks', () => {
  const ASK = 'https://api.northline.app/hooks'

  function hook(point: string, over: Partial<RemoteHook> = {}): RemoteHook {
    return {
      id: `id-${point}`,
      point,
      url: `${ASK}/${point}`,
      enabled: true,
      deadlineMs: 2000,
      failureMode: 'deny',
      lastFailedAt: null,
      lastFailureReason: null,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      ...over,
    }
  }

  /** What a row expects of one hook: its point, the action, the fields that differ, the weakenings. */
  type Expected = [
    point: string,
    action: HookChange['action'],
    fields: string[],
    weakened: string[],
  ]

  const summary = (changes: readonly HookChange[]): Expected[] =>
    changes.map((change) => [
      change.point,
      change.action,
      change.fields.map((field) => field.path),
      change.weakened,
    ])

  type Desired = NonNullable<EnvironmentConfigInput['hooks']>

  // The weakenings are the contract's `hookWeakenings`: `failureMode` to `allow` (or a hook
  // registered with it), `enabled` to `false`, the removal of a hook that is on.
  const rows: [string, RemoteHook[], Desired, boolean, Expected[]][] = [
    [
      'a hook the server does not have is created, every field sent',
      [],
      { before_sign_up: { url: `${ASK}/before_sign_up` } },
      false,
      [['before_sign_up', 'create', ['url', 'enabled', 'deadlineMs', 'failureMode'], []]],
    ],
    [
      'a hook created to let through on failure is weaker, as the server records it',
      [],
      { before_session: { url: `${ASK}/before_session`, failureMode: 'allow' } },
      false,
      [
        [
          'before_session',
          'create',
          ['url', 'enabled', 'deadlineMs', 'failureMode'],
          ['hooks.before_session.failureMode'],
        ],
      ],
    ],
    [
      'a hook that is as the file says is left alone',
      [hook('before_sign_up')],
      { before_sign_up: { url: `${ASK}/before_sign_up` } },
      false,
      [['before_sign_up', 'none', [], []]],
    ],
    [
      'the defaults are the file’s word: a server’s other deadline is a difference',
      [hook('before_sign_up', { deadlineMs: 4000 })],
      { before_sign_up: { url: `${ASK}/before_sign_up` } },
      false,
      [['before_sign_up', 'update', ['deadlineMs'], []]],
    ],
    [
      'a changed address is the same hook, updated: the point names it',
      [hook('before_token')],
      { before_token: { url: `${ASK}/claims` } },
      false,
      [['before_token', 'update', ['url'], []]],
    ],
    [
      'an address is compared exactly: a trailing slash is another address',
      [hook('before_token', { url: `${ASK}/claims/` })],
      { before_token: { url: `${ASK}/claims` } },
      false,
      [['before_token', 'update', ['url'], []]],
    ],
    [
      'deny to allow is weaker',
      [hook('before_sign_up')],
      { before_sign_up: { url: `${ASK}/before_sign_up`, failureMode: 'allow' } },
      false,
      [['before_sign_up', 'update', ['failureMode'], ['hooks.before_sign_up.failureMode']]],
    ],
    [
      'allow to deny is not',
      [hook('before_sign_up', { failureMode: 'allow' })],
      { before_sign_up: { url: `${ASK}/before_sign_up` } },
      false,
      [['before_sign_up', 'update', ['failureMode'], []]],
    ],
    [
      'allow that stays allow is no change and no new weakening',
      [hook('before_sign_up', { failureMode: 'allow' })],
      { before_sign_up: { url: `${ASK}/before_sign_up`, failureMode: 'allow' } },
      false,
      [['before_sign_up', 'none', [], []]],
    ],
    [
      'switching a hook off is weaker',
      [hook('before_session')],
      { before_session: { url: `${ASK}/before_session`, enabled: false } },
      false,
      [['before_session', 'update', ['enabled'], ['hooks.before_session.enabled']]],
    ],
    [
      'switching one on is not',
      [hook('before_session', { enabled: false })],
      { before_session: { url: `${ASK}/before_session` } },
      false,
      [['before_session', 'update', ['enabled'], []]],
    ],
    [
      'off and allow at once: both fields, in the contract’s order',
      [hook('before_session')],
      { before_session: { url: `${ASK}/before_session`, enabled: false, failureMode: 'allow' } },
      false,
      [
        [
          'before_session',
          'update',
          ['enabled', 'failureMode'],
          ['hooks.before_session.enabled', 'hooks.before_session.failureMode'],
        ],
      ],
    ],
    [
      'a point the file leaves out is unmanaged',
      [hook('before_sign_up'), hook('before_token')],
      { before_sign_up: { url: `${ASK}/before_sign_up` } },
      false,
      [
        ['before_sign_up', 'none', [], []],
        ['before_token', 'unmanaged', [], []],
      ],
    ],
    [
      '--prune removes it, and removing a hook that is on is weaker',
      [hook('before_sign_up'), hook('before_token')],
      { before_sign_up: { url: `${ASK}/before_sign_up` } },
      true,
      [
        ['before_sign_up', 'none', [], []],
        ['before_token', 'delete', [], ['hooks.before_token']],
      ],
    ],
    [
      'removing a hook that is off weakens nothing',
      [hook('before_token', { enabled: false })],
      {},
      true,
      [['before_token', 'delete', [], []]],
    ],
    [
      'a point this version does not know is left alone, even with --prune',
      [hook('before_refresh')],
      {},
      true,
      [['before_refresh', 'unknown', [], []]],
    ],
    [
      'the points come in the contract’s order, whatever the file’s or the server’s',
      [hook('before_token'), hook('before_sign_up')],
      {
        before_token: { url: `${ASK}/before_token` },
        before_session: { url: `${ASK}/before_session` },
      },
      false,
      [
        ['before_sign_up', 'unmanaged', [], []],
        ['before_session', 'create', ['url', 'enabled', 'deadlineMs', 'failureMode'], []],
        ['before_token', 'none', [], []],
      ],
    ],
  ]

  test.each(rows)('%s', (_, remoteHooks, desired, prune, expected) => {
    const planned = planHooks(remoteHooks, environment({ hooks: desired }).hooks, { prune })
    expect(planned.managed).toBe(true)
    expect(summary(planned.hooks)).toEqual(expected)
  })

  test('a file without the key manages nothing: no entry, whatever the server has, even with --prune', () => {
    const planned = planHooks([hook('before_sign_up')], environment({}).hooks, { prune: true })
    expect(planned).toEqual({ managed: false, hooks: [], seen: hookSnapshot([]) })
    const whole = plan({}, remote({ hooks: [hook('before_sign_up')] }), { prune: true })
    expect(whole.hooks.managed).toBe(false)
    expect(orderOperations(whole).some((operation) => operation.kind.startsWith('hook.'))).toBe(
      false
    )
  })

  test('a change shows the server’s value and the file’s; a creation only the file’s', () => {
    const changed = planHooks(
      [hook('before_sign_up', { deadlineMs: 4000, failureMode: 'allow' })],
      environment({ hooks: { before_sign_up: { url: `${ASK}/before_sign_up` } } }).hooks,
      {}
    ).hooks[0]
    expect(changed).toEqual({
      point: 'before_sign_up',
      id: 'id-before_sign_up',
      url: `${ASK}/before_sign_up`,
      action: 'update',
      fields: [
        { path: 'deadlineMs', kind: 'changed', before: 4000, after: 2000 },
        { path: 'failureMode', kind: 'changed', before: 'allow', after: 'deny' },
      ],
      weakened: [],
    })
    const created = planHooks(
      [],
      environment({ hooks: { before_token: { url: `${ASK}/claims`, deadlineMs: 300 } } }).hooks,
      {}
    ).hooks[0]
    expect(created).toEqual({
      point: 'before_token',
      url: `${ASK}/claims`,
      action: 'create',
      fields: [
        { path: 'url', kind: 'added', after: `${ASK}/claims` },
        { path: 'enabled', kind: 'added', after: true },
        { path: 'deadlineMs', kind: 'added', after: 300 },
        { path: 'failureMode', kind: 'added', after: 'deny' },
      ],
      weakened: [],
    })
  })

  test('the plan’s weakenings are the settings’ and the hooks’ together; a hook change is a change', () => {
    const state = remote({ hooks: [hook('before_sign_up'), hook('before_session')] })
    const weaker = plan(
      {
        settings: { mfa: { policy: 'optional' } },
        hooks: { before_sign_up: { url: `${ASK}/before_sign_up`, failureMode: 'allow' } },
      },
      remote({
        ...state,
        settings: settings((s) => {
          s.mfa.policy = 'required'
        }),
      }),
      { prune: true }
    )
    expect(weaker.weakened).toEqual([
      'mfa.policy',
      'hooks.before_sign_up.failureMode',
      'hooks.before_session',
    ])
    expect(weaker.changes).toBe(true)

    const settled = buildPlan(
      {
        ...state,
        managedBy: {
          tool: 'tula-apply',
          configHash: HASH,
          at: '2026-10-01T00:00:00.000Z',
          revision: 3,
          drifted: false,
        },
      },
      environment({
        hooks: {
          before_sign_up: { url: `${ASK}/before_sign_up` },
        },
      }),
      { configHash: HASH }
    )
    // One is as the file says, the other unmanaged: nothing is pending for the hooks.
    expect(settled.hooks.hooks.map((entry) => entry.action)).toEqual(['none', 'unmanaged'])
    expect(settled.weakened).toEqual([])
  })

  test('the snapshot is the same for the same hooks in any order, and moves with any field a plan reads', () => {
    const one = hook('before_sign_up')
    const two = hook('before_token')
    const base = hookSnapshot([one, two])
    expect(hookSnapshot([two, one])).toBe(base)
    // What a call moves is not what a plan reads.
    expect(
      hookSnapshot([
        { ...one, lastFailedAt: '2026-10-02T00:00:00.000Z', lastFailureReason: 'timeout' },
        { ...two, updatedAt: '2026-10-03T00:00:00.000Z' },
      ])
    ).toBe(base)
    for (const moved of [
      { id: 'another' },
      { point: 'before_session' },
      { url: `${ASK}/elsewhere` },
      { enabled: false },
      { deadlineMs: 2001 },
      { failureMode: 'allow' },
    ]) {
      expect(hookSnapshot([{ ...one, ...moved }, two])).not.toBe(base)
    }
    expect(hookSnapshot([one])).not.toBe(base)
  })
})

describe('orderOperations: hooks', () => {
  const ASK = 'https://api.northline.app/hooks'
  const HOOK = 'https://hooks.northline.app/tula'

  function hook(point: string, over: Partial<RemoteHook> = {}): RemoteHook {
    return {
      id: `id-${point}`,
      point,
      url: `${ASK}/${point}`,
      enabled: true,
      deadlineMs: 2000,
      failureMode: 'deny',
      lastFailedAt: null,
      lastFailureReason: null,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      ...over,
    }
  }

  const kinds = (planned: Plan) =>
    orderOperations(planned).map((operation) =>
      'point' in operation ? `${operation.kind} ${operation.point}` : operation.kind
    )

  test('hooks come last: after the settings, every provider and every webhook endpoint', () => {
    const planned = plan(
      {
        settings: { app: { name: 'Northline' } },
        providers: { google: { clientId: 'g', clientSecret: env('GOOGLE_CLIENT_SECRET') } },
        webhooks: [{ url: HOOK, eventTypes: ['user.created'] }],
        hooks: { before_sign_up: { url: `${ASK}/before_sign_up` } },
      },
      remote({ webhooks: [], hooks: [] })
    )
    expect(kinds(planned)).toEqual([
      'settings',
      'provider.set',
      'webhook.create',
      'hook.create before_sign_up',
    ])
  })

  test('what adds a check or loosens none goes first, then what loosens one, then removals', () => {
    const planned = plan(
      {
        hooks: {
          // Loosened: goes after the two below.
          before_sign_up: { url: `${ASK}/before_sign_up`, failureMode: 'allow' },
          // Tightened (switched on): first.
          before_session: { url: `${ASK}/before_session` },
        },
      },
      remote({
        hooks: [
          hook('before_sign_up'),
          hook('before_session', { enabled: false }),
          hook('before_token'),
        ],
      }),
      { prune: true }
    )
    expect(kinds(planned)).toEqual([
      'settings',
      'hook.update before_session',
      'hook.update before_sign_up',
      'hook.delete before_token',
    ])
  })

  test('a new hook is created before another is loosened, whatever the points’ order', () => {
    const planned = plan(
      {
        hooks: {
          before_sign_up: { url: `${ASK}/before_sign_up`, enabled: false },
          before_token: { url: `${ASK}/before_token`, failureMode: 'allow' },
        },
      },
      remote({ hooks: [hook('before_sign_up')] })
    )
    expect(kinds(planned)).toEqual([
      'settings',
      'hook.create before_token',
      'hook.update before_sign_up',
    ])
  })

  test('an unchanged, an unmanaged and an unknown hook are no operation', () => {
    const planned = plan(
      { hooks: { before_sign_up: { url: `${ASK}/before_sign_up` } } },
      remote({ hooks: [hook('before_sign_up'), hook('before_token'), hook('before_refresh')] })
    )
    expect(kinds(planned)).toEqual(['settings'])
  })
})
