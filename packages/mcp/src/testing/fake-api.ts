import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { type AdminClient, type AdminFetch, createAdminClient } from '@tula/admin'
import { createTulaMcpServer, type TulaMcpServerOptions } from '../server'

/** A secret key no deployment has: the tests look for it in every output. */
export const TEST_SECRET_KEY = `tula_sk_dev_${'s3cr3tKEY'.repeat(4)}`
/** An instance admin token no deployment has. */
export const TEST_ADMIN_TOKEN = `adm1nT0KEN${'z'.repeat(40)}`

const USER_ID = '0198c1de-0000-7000-8000-000000000001'

/** A marker the canary tests look for: no output may ever contain it. */
export const CANARY = 'CANARY-7f3a9c'

/** An answer that never comes. */
export const HANG = Symbol('hang')

/** One recorded request. */
export interface Recorded {
  method: string
  path: string
  search: string
  headers: Record<string, string>
}

/** What a fake answers for a path: a JSON body, or a whole `Response`. */
export type Answers = Record<string, unknown | (() => Response)>

/** Add a canary under an unexpected key to every object of a value, at every depth. */
export function withCanaries(value: unknown, path = 'root'): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) => withCanaries(item, `${path}[${index}]`))
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(value)) {
      out[key] = withCanaries(inner, `${path}.${key}`)
    }
    out.passwordHash = `${CANARY}-hash-${path}`
    out.unexpected = { nested: `${CANARY}-nested-${path}`, deeper: [{ token: `${CANARY}-deep` }] }
    return out
  }
  return value
}

/** The admin API's answers, as the real one shapes them. */
export function defaultAnswers(): Answers {
  const user = {
    id: USER_ID,
    email: 'maya@example.com',
    emailVerifiedAt: '2026-01-01T00:00:00.000Z',
    firstName: 'Maya',
    lastName: 'Lin',
    bannedAt: null,
    lastSignInAt: '2026-02-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
  }
  return {
    'GET /v1/admin/users': {
      meta: { totalCount: 1, totalPages: 1, page: 1, perPage: 20 },
      data: [user],
    },
    [`GET /v1/admin/users/${USER_ID}`]: user,
    [`GET /v1/admin/users/${USER_ID}/authentication`]: {
      hasPassword: true,
      emailVerified: true,
      identities: [{ provider: 'google', linkedAt: '2026-01-02T00:00:00.000Z' }],
      factors: [{ type: 'totp', confirmedAt: '2026-01-03T00:00:00.000Z' }],
      backupCodesRemaining: 8,
      passkeys: [
        {
          id: '0198c1de-0000-7000-8000-0000000000aa',
          name: 'Laptop',
          synced: true,
          createdAt: '2026-01-04T00:00:00.000Z',
          lastUsedAt: null,
        },
      ],
      canSignInWithoutPasskeys: true,
    },
    [`GET /v1/admin/users/${USER_ID}/sessions`]: {
      data: [
        {
          id: '0198c1de-0000-7000-8000-0000000000bb',
          client: 'web',
          userAgent: 'Mozilla/5.0 (Macintosh)',
          ipAddress: '203.0.113.7',
          createdAt: '2026-02-01T00:00:00.000Z',
          lastActiveAt: '2026-02-01T01:00:00.000Z',
          expiresAt: '2026-03-01T00:00:00.000Z',
          current: false,
        },
      ],
    },
    'GET /v1/admin/audit-logs': {
      meta: { totalCount: 1, totalPages: 1, page: 1, perPage: 50 },
      data: [
        {
          id: '0198c1de-0000-7000-8000-0000000000cc',
          action: 'session.created',
          actor: { type: 'user', id: USER_ID },
          target: { type: 'session', id: '0198c1de-0000-7000-8000-0000000000bb' },
          ipAddress: '203.0.113.7',
          userAgent: 'Mozilla/5.0 (Macintosh)',
          metadata: { userId: USER_ID, methods: ['pwd'], client: 'web' },
          occurredAt: '2026-02-01T00:00:00.000Z',
        },
      ],
    },
    'GET /v1/admin/settings': {
      revision: 3,
      settings: {
        version: 1,
        app: { name: 'Northline', supportEmail: 'help@example.com' },
        password: { preset: 'recommended', minLength: 12, maxLength: 128, breachCheck: 'block' },
        signIn: { methods: { password: { enabled: true }, emailCode: { enabled: false } } },
        signUp: { password: 'required' },
        urls: { allowedOrigins: ['https://app.example.com'], allowedRedirectUrls: [] },
        audit: { retentionDays: 90 },
        notifications: { passwordChanged: true, newSignIn: true },
        mfa: { policy: 'optional' },
        passkeys: { rpId: null },
        sessions: { profiles: { web: { type: 'hybrid', accessTokenTtl: '60s' } }, maxPerUser: 5 },
      },
      managedBy: {
        tool: 'tula-cli',
        configHash: 'abc123',
        at: '2026-01-01T00:00:00.000Z',
        revision: 3,
        drifted: false,
      },
    },
    'GET /v1/admin/oauth-providers': {
      data: [
        {
          provider: 'google',
          configured: true,
          enabled: true,
          clientId: 'client-id.apps.example',
          teamId: null,
          keyId: null,
          tenant: null,
          callbackUrl: 'https://auth.example.com/v1/client/oauth/google/callback',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    },
  }
}

/** The user every default answer is about. */
export const TEST_USER_ID = USER_ID

/**
 * A `fetch` that records every request and answers from a table keyed `"<METHOD> <path>"`.
 * Anything not in the table is a contract 404. `outstanding` counts the requests to a
 * `HANG` path that nothing has aborted yet.
 */
export function fakeFetch(answers: Answers = defaultAnswers()): {
  fetch: AdminFetch
  requests: Recorded[]
  outstanding(): number
} {
  const requests: Recorded[] = []
  let open = 0
  const fetch: AdminFetch = async (url, init) => {
    const parsed = new URL(url)
    const method = (init?.method ?? 'GET').toUpperCase()
    requests.push({
      method,
      path: parsed.pathname,
      search: parsed.search,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    })
    const answer = answers[`${method} ${parsed.pathname}`]
    if (answer === HANG) {
      // Never answers; ends only when the caller's own timeout aborts the request.
      open += 1
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          open -= 1
          reject(init.signal?.reason)
        })
      })
    }
    if (typeof answer === 'function') {
      return (answer as () => Response)()
    }
    if (answer === undefined) {
      return Response.json(
        { status: 404, code: 'resource.not_found', detail: `upstream detail ${CANARY}-detail` },
        { status: 404 }
      )
    }
    return Response.json(answer)
  }
  return { fetch, requests, outstanding: () => open }
}

/** An admin client over a fake `fetch`. */
export function fakeAdmin(answers?: Answers): {
  admin: AdminClient
  requests: Recorded[]
  outstanding(): number
} {
  const { fetch, requests, outstanding } = fakeFetch(answers)
  return {
    admin: createAdminClient({
      baseUrl: 'https://auth.example.com',
      secretKey: TEST_SECRET_KEY,
      fetch,
    }),
    requests,
    outstanding,
  }
}

/** A server and a real MCP client, joined in memory. */
export async function connect(options: TulaMcpServerOptions): Promise<{
  client: Client
  close(): Promise<void>
}> {
  const server = createTulaMcpServer(options)
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  await server.connect(serverEnd)
  await client.connect(clientEnd)
  return {
    client,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

/** A tool result, read the way a client reads it. */
export interface Called {
  /** The structured result. */
  structured: Record<string, unknown>
  /** The text rendering. */
  text: string
  /** Whether the tool reported a failure. */
  isError: boolean
  /** Everything the client received, as one string: what the secret checks search. */
  raw: string
}

/** Call a tool and read its answer. */
export async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
): Promise<Called> {
  const result = (await client.callTool({ name, arguments: args })) as {
    content?: { type: string; text?: string }[]
    structuredContent?: Record<string, unknown>
    isError?: boolean
  }
  return {
    structured: result.structuredContent ?? {},
    text: (result.content ?? []).map((part) => part.text ?? '').join('\n'),
    isError: result.isError === true,
    raw: JSON.stringify(result),
  }
}
