import { DEFAULT_ENVIRONMENT_SETTINGS } from '@tula/contract'
import { type FakeHookState, hookRoutes } from './fake-hooks'
import { type FakeWebhookState, webhookRoutes } from './fake-webhooks'

export { type FakeHook, fakeHook } from './fake-hooks'

export {
  type FakeWebhookDelivery,
  type FakeWebhookEndpoint,
  fakeWebhookDelivery,
  fakeWebhookEndpoint,
} from './fake-webhooks'

// A small stand-in for the API, for component tests: the routes the dashboard calls, on plain
// in-memory data, answering with the contract's shapes and error envelope. The real API is
// what the browser tests run against (e2e/tests/dashboard); this only has to be faithful
// enough to exercise the screens' own logic.

/** The admin token the fake accepts. A test value that opens nothing. */
export const FAKE_TOKEN = 'fake-admin-token-for-component-tests'
/** Ids of the fake's seeded workspace, project and environments. */
export const IDS = {
  workspace: '00000000-0000-7000-8000-0000000000a1',
  project: '00000000-0000-7000-8000-0000000000b1',
  development: '00000000-0000-7000-8000-0000000000c1',
  production: '00000000-0000-7000-8000-0000000000c2',
  user: '00000000-0000-7000-8000-0000000000d1',
  session: '00000000-0000-7000-8000-0000000000e1',
} as const

const NOW = '2026-10-04T12:00:00.000Z'

/** One recorded request. */
export interface FakeCall {
  method: string
  path: string
  search: URLSearchParams
  headers: Headers
  body: unknown
}

/** What answers one route of the fake: a response, or a body to send with a 200. */
export type FakeHandler = (call: FakeCall, match: RegExpExecArray) => Response | unknown
type Handler = FakeHandler

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

/**
 * The contract's error envelope.
 *
 * @param status - HTTP status.
 * @param code - Error code.
 * @param detail - Description.
 * @param errors - Field errors.
 * @param params - The envelope's parameters (`reason`, `max`).
 * @returns The response.
 */
export function failure(
  status: number,
  code: string,
  detail: string,
  errors?: { field: string; code: string; message: string }[],
  params?: Record<string, unknown>
): Response {
  return json(status, {
    status,
    code,
    detail,
    ...(params ? { params } : {}),
    ...(errors ? { errors } : {}),
  })
}

function page<T>(rows: T[]) {
  return { meta: { totalCount: rows.length, totalPages: 1, page: 1, perPage: 100 }, data: rows }
}

/** The fake's data, open to a test that wants to arrange or inspect it. */
export interface FakeState extends FakeWebhookState, FakeHookState {
  /** Whether `TULA_ADMIN_TOKEN` is set (the instance routes exist). */
  adminToken: boolean
  signedIn: boolean
  workspaces: { id: string; name: string; createdAt: string }[]
  projects: {
    id: string
    workspaceId: string
    name: string
    createdAt: string
    updatedAt: string
  }[]
  environments: {
    id: string
    projectId: string
    kind: 'development' | 'production'
    createdAt: string
  }[]
  users: {
    id: string
    email: string
    emailVerifiedAt: string | null
    firstName: string | null
    lastName: string | null
    bannedAt: string | null
    lastSignInAt: string | null
    createdAt: string
  }[]
  sessions: Record<string, unknown>[]
  keys: Record<string, unknown>[]
  settings: {
    revision: number
    settings: typeof DEFAULT_ENVIRONMENT_SETTINGS
    managedBy: null | {
      tool: string
      configHash: string
      at: string
      revision: number
      drifted: boolean
    }
  }
  audit: Record<string, unknown>[]
  /** What the factor reset says about the user afterwards. */
  canStillSignIn: boolean
  /** How every user signs in, as `GET …/authentication` answers. */
  authentication: {
    hasPassword: boolean
    emailVerified: boolean
    identities: { provider: string; linkedAt: string }[]
    factors: { type: string; confirmedAt: string }[]
    backupCodesRemaining: number
    passkeys: {
      id: string
      name: string
      synced: boolean
      createdAt: string
      lastUsedAt: string | null
    }[]
    canSignInWithoutPasskeys: boolean
  }
}

function initialState(): FakeState {
  return {
    adminToken: true,
    signedIn: false,
    workspaces: [{ id: IDS.workspace, name: 'Acme Studio', createdAt: NOW }],
    projects: [
      {
        id: IDS.project,
        workspaceId: IDS.workspace,
        name: 'Mobile app',
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    environments: [
      { id: IDS.development, projectId: IDS.project, kind: 'development', createdAt: NOW },
      { id: IDS.production, projectId: IDS.project, kind: 'production', createdAt: NOW },
    ],
    users: [
      {
        id: IDS.user,
        email: 'ada@example.com',
        emailVerifiedAt: NOW,
        firstName: 'Ada',
        lastName: 'Lovelace',
        bannedAt: null,
        lastSignInAt: NOW,
        createdAt: NOW,
      },
    ],
    sessions: [
      {
        id: IDS.session,
        client: 'web',
        userAgent: 'Chrome on macOS',
        ipAddress: '203.0.113.7',
        createdAt: NOW,
        lastActiveAt: NOW,
        expiresAt: NOW,
        current: false,
      },
    ],
    keys: [],
    settings: {
      revision: 3,
      settings: structuredClone(DEFAULT_ENVIRONMENT_SETTINGS),
      managedBy: null,
    },
    audit: [
      {
        id: 'audit-1',
        action: 'user.created',
        actor: { type: 'instance_admin', id: 'dash-session' },
        target: { type: 'user', id: IDS.user },
        ipAddress: '203.0.113.7',
        userAgent: null,
        metadata: { note: '<b>not html</b>' },
        occurredAt: NOW,
      },
    ],
    webhookEndpoints: [],
    webhookDeliveries: [],
    webhookReceiver: { statusCode: 204, durationMs: 41, failureReason: null },
    webhookNow: NOW,
    hooks: [],
    hookNow: NOW,
    webhookWorkerSeparate: false,
    canStillSignIn: true,
    authentication: {
      hasPassword: true,
      emailVerified: true,
      identities: [],
      factors: [],
      backupCodesRemaining: 0,
      passkeys: [],
      canSignInWithoutPasskeys: true,
    },
  }
}

/**
 * Install the fake API as `globalThis.fetch`.
 *
 * @returns The data, the recorded calls, a way to override one route and `restore()`.
 */
export function installFakeApi() {
  const state = initialState()
  const calls: FakeCall[] = []
  const overrides: { method: string; pattern: RegExp; handler: Handler }[] = []
  let keyCount = 0

  const routes: [string, RegExp, Handler][] = [
    [
      'POST',
      /^\/v1\/instance\/session$/,
      (call) => {
        if ((call.body as { token?: string }).token !== FAKE_TOKEN) {
          return failure(401, 'auth.invalid_key', 'The key is not valid.')
        }
        state.signedIn = true
        return { expiresAt: '2026-10-04T20:00:00.000Z' }
      },
    ],
    ['GET', /^\/v1\/instance\/session$/, () => ({ expiresAt: '2026-10-04T20:00:00.000Z' })],
    [
      'DELETE',
      /^\/v1\/instance\/session$/,
      () => {
        state.signedIn = false
        return new Response(null, { status: 204 })
      },
    ],
    ['GET', /^\/v1\/instance\/workspaces$/, () => page(state.workspaces)],
    [
      'POST',
      /^\/v1\/instance\/workspaces$/,
      (call) => {
        const workspace = {
          id: `00000000-0000-7000-8000-00000000a${state.workspaces.length + 1}0`,
          name: (call.body as { name: string }).name,
          createdAt: NOW,
        }
        state.workspaces.push(workspace)
        return json(201, workspace)
      },
    ],
    [
      'GET',
      /^\/v1\/instance\/projects$/,
      (call) =>
        page(
          state.projects.filter((entry) => entry.workspaceId === call.search.get('workspaceId'))
        ),
    ],
    [
      'POST',
      /^\/v1\/instance\/projects$/,
      (call) => {
        const body = call.body as { workspaceId: string; name: string }
        const id = `00000000-0000-7000-8000-00000000b${state.projects.length + 1}0`
        const project = {
          id,
          workspaceId: body.workspaceId,
          name: body.name,
          createdAt: NOW,
          updatedAt: NOW,
        }
        const environments = (['development', 'production'] as const).map((kind, index) => ({
          id: `00000000-0000-7000-8000-0000000${state.projects.length + 1}c${index}0`,
          projectId: id,
          kind,
          createdAt: NOW,
        }))
        state.projects.push(project)
        state.environments.push(...environments)
        return json(201, { project, environments })
      },
    ],
    [
      'PATCH',
      /^\/v1\/instance\/projects\/([^/]+)$/,
      (call, match) => {
        const project = state.projects.find((entry) => entry.id === match[1])
        if (!project) {
          return failure(404, 'resource.not_found', 'Not found.')
        }
        project.name = (call.body as { name: string }).name
        return project
      },
    ],
    [
      'GET',
      /^\/v1\/instance\/environments$/,
      (call) =>
        page(
          state.environments.filter((entry) => entry.projectId === call.search.get('projectId'))
        ),
    ],
    [
      'POST',
      /^\/v1\/instance\/projects\/([^/]+)\/environments$/,
      (call, match) => {
        const environment = {
          id: '00000000-0000-7000-8000-0000000000c9',
          projectId: match[1] as string,
          kind: (call.body as { kind: 'development' | 'production' }).kind,
          createdAt: NOW,
        }
        state.environments.push(environment)
        return json(201, environment)
      },
    ],
    ['GET', /^\/v1\/instance\/audit-logs$/, () => page(state.audit)],
    [
      'GET',
      /^\/v1\/instance\/diagnostics$/,
      () => ({
        version: '0.0.0',
        environment: 'local',
        time: NOW,
        publicUrl: 'http://localhost:3003',
        checks: [
          { id: 'database', status: 'ok', summary: 'The database answers.' },
          {
            id: 'redis',
            status: 'warn',
            summary: 'No Redis is configured.',
            fix: 'Set REDIS_URL before running more than one instance.',
            values: ['REDIS_URL'],
          },
          {
            id: 'mail',
            status: 'fail',
            summary: 'The mail server refused.',
            fix: 'Check SMTP_URL.',
          },
          { id: 'public_url', status: 'skipped', summary: 'Not checked in the local tier.' },
        ],
      }),
    ],
    [
      'GET',
      /^\/v1\/admin\/users$/,
      (call) => {
        const q = call.search.get('q')?.toLowerCase() ?? ''
        return page(state.users.filter((user) => user.email.includes(q)))
      },
    ],
    [
      'POST',
      /^\/v1\/admin\/users$/,
      (call) => {
        const body = call.body as { email: string; firstName?: string }
        if (state.users.some((user) => user.email === body.email)) {
          return failure(409, 'resource.conflict', 'A user with that email exists.')
        }
        const user = {
          id: `00000000-0000-7000-8000-00000000d${state.users.length + 1}0`,
          email: body.email,
          emailVerifiedAt: null,
          firstName: body.firstName ?? null,
          lastName: null,
          bannedAt: null,
          lastSignInAt: null,
          createdAt: NOW,
        }
        state.users.push(user)
        return json(201, user)
      },
    ],
    [
      'GET',
      /^\/v1\/admin\/users\/([^/]+)$/,
      (_call, match) =>
        state.users.find((user) => user.id === match[1]) ??
        failure(404, 'resource.not_found', 'No such user.'),
    ],
    [
      'DELETE',
      /^\/v1\/admin\/users\/([^/]+)$/,
      (_call, match) => {
        state.users = state.users.filter((user) => user.id !== match[1])
        return new Response(null, { status: 204 })
      },
    ],
    [
      'POST',
      /^\/v1\/admin\/users\/([^/]+)\/(ban|unban)$/,
      (_call, match) => {
        const user = state.users.find((entry) => entry.id === match[1])
        if (!user) {
          return failure(404, 'resource.not_found', 'No such user.')
        }
        user.bannedAt = match[2] === 'ban' ? NOW : null
        return user
      },
    ],
    [
      'PUT',
      /^\/v1\/admin\/users\/([^/]+)\/password$/,
      (call) =>
        (call.body as { password: string }).password.length < 10
          ? failure(422, 'validation.failed', 'The password does not meet the policy.', [
              {
                field: 'password',
                code: 'password.too_short',
                message: 'Use 10 or more characters.',
              },
              { field: 'password', code: 'password.too_common', message: 'Too common.' },
            ])
          : new Response(null, { status: 204 }),
    ],
    [
      'DELETE',
      /^\/v1\/admin\/users\/([^/]+)\/factors$/,
      () =>
        new Response(null, {
          status: 204,
          headers: { 'x-tula-can-still-sign-in': String(state.canStillSignIn) },
        }),
    ],
    [
      'GET',
      /^\/v1\/admin\/users\/([^/]+)\/authentication$/,
      (_call, match) =>
        state.users.some((user) => user.id === match[1])
          ? state.authentication
          : failure(404, 'resource.not_found', 'The requested resource does not exist.'),
    ],
    ['GET', /^\/v1\/admin\/users\/([^/]+)\/sessions$/, () => page(state.sessions)],
    [
      'DELETE',
      /^\/v1\/admin\/users\/([^/]+)\/sessions$/,
      () => {
        const revoked = state.sessions.length
        state.sessions = []
        return { revoked }
      },
    ],
    [
      'DELETE',
      /^\/v1\/admin\/users\/([^/]+)\/sessions\/([^/]+)$/,
      (_call, match) => {
        state.sessions = state.sessions.filter((session) => session.id !== match[2])
        return new Response(null, { status: 204 })
      },
    ],
    ['GET', /^\/v1\/admin\/api-keys$/, () => page(state.keys)],
    [
      'POST',
      /^\/v1\/admin\/api-keys$/,
      (call) => {
        const body = call.body as { kind: 'secret' | 'publishable'; name: string }
        keyCount += 1
        const key = `tula_${body.kind === 'secret' ? 'sk' : 'pk'}_dev_fakekeymaterial${keyCount}wxyz`
        const record = {
          id: `00000000-0000-7000-8000-00000000f${keyCount}00`,
          kind: body.kind,
          name: body.name,
          environmentId: IDS.development,
          lastFour: key.slice(-4),
          createdAt: NOW,
          lastUsedAt: null,
          revokedAt: null as string | null,
        }
        state.keys.push(record)
        return json(201, { ...record, key })
      },
    ],
    [
      'DELETE',
      /^\/v1\/admin\/api-keys\/([^/]+)$/,
      (_call, match) => {
        const key = state.keys.find((entry) => entry.id === match[1])
        if (!key) {
          return failure(404, 'resource.not_found', 'No such key.')
        }
        key.revokedAt = NOW
        return key
      },
    ],
    [
      'GET',
      /^\/v1\/admin\/signing-keys$/,
      () =>
        page([
          { id: 'key-active', status: 'active', createdAt: NOW, activatedAt: NOW, retiredAt: null },
          { id: 'key-next', status: 'next', createdAt: NOW, activatedAt: null, retiredAt: null },
        ]),
    ],
    [
      'POST',
      /^\/v1\/admin\/signing-keys\/rotate$/,
      () =>
        page([
          { id: 'key-active', status: 'retired', createdAt: NOW, activatedAt: NOW, retiredAt: NOW },
          { id: 'key-next', status: 'active', createdAt: NOW, activatedAt: NOW, retiredAt: null },
          { id: 'key-new', status: 'next', createdAt: NOW, activatedAt: null, retiredAt: null },
        ]),
    ],
    ['GET', /^\/v1\/admin\/audit-logs$/, () => page(state.audit)],
    ...webhookRoutes(state),
    ...hookRoutes(state),
    ['GET', /^\/v1\/admin\/settings$/, () => structuredClone(state.settings)],
    [
      'PUT',
      /^\/v1\/admin\/settings$/,
      (call) => {
        if (call.headers.get('if-match') !== `"${state.settings.revision}"`) {
          return failure(412, 'precondition.failed', 'The settings changed.')
        }
        const body = call.body as typeof DEFAULT_ENVIRONMENT_SETTINGS
        if (body.password.minLength < 8) {
          return failure(422, 'validation.failed', 'Invalid settings.', [
            {
              field: 'password.minLength',
              code: 'validation.failed',
              message: 'Must be 8 or more.',
            },
          ])
        }
        state.settings = {
          revision: state.settings.revision + 1,
          settings: body,
          managedBy: state.settings.managedBy
            ? { ...state.settings.managedBy, drifted: true }
            : null,
        }
        return structuredClone(state.settings)
      },
    ],
    [
      'GET',
      /^\/v1\/admin\/oauth-providers$/,
      () => ({
        data: (['google', 'github', 'apple', 'microsoft'] as const).map((provider) => ({
          provider,
          configured: false,
          enabled: false,
          clientId: null,
          teamId: null,
          keyId: null,
          tenant: null,
          callbackUrl: `http://localhost:3003/v1/client/oauth/${provider}/callback`,
          updatedAt: null,
        })),
      }),
    ],
  ]

  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input), 'http://localhost:3003')
    const call: FakeCall = {
      method: (init.method ?? 'GET').toUpperCase(),
      path: url.pathname,
      search: url.searchParams,
      headers: new Headers(init.headers),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    }
    calls.push(call)
    if (call.path.startsWith('/v1/instance/') && !state.adminToken) {
      return failure(404, 'resource.not_found', 'Not found.')
    }
    const open = call.path === '/v1/instance/session' && call.method !== 'GET'
    if (!open && !state.signedIn) {
      return failure(401, 'auth.unauthenticated', 'Sign in.')
    }
    for (const route of [
      ...overrides.map((entry) => [entry.method, entry.pattern, entry.handler] as const),
      ...routes,
    ]) {
      const match = route[0] === call.method ? route[1].exec(call.path) : null
      if (match) {
        const result = route[2](call, match)
        return result instanceof Response ? result : json(200, result)
      }
    }
    return failure(404, 'resource.not_found', `No fake route for ${call.method} ${call.path}.`)
  }) as typeof fetch

  return {
    state,
    calls,
    /** Answer one route differently (checked before the built-in routes). */
    override(method: string, pattern: RegExp, handler: Handler) {
      overrides.unshift({ method, pattern, handler })
    },
    /** The calls made to a path with a method. */
    callsTo(method: string, path: string): FakeCall[] {
      return calls.filter((call) => call.method === method && call.path === path)
    },
    restore() {
      globalThis.fetch = realFetch
    },
  }
}

/** What {@link installFakeApi} returns. */
export type FakeApi = ReturnType<typeof installFakeApi>
