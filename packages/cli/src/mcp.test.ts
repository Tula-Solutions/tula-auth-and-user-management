import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import type { AdminFetch } from '@tula-tech/admin'
import { parseConfig } from '@tula-tech/config'
import {
  DRAFT_TOOL_NAMES,
  PROPOSE_TOOL_NAMES,
  READ_TOOL_NAMES,
  SCAFFOLD_TOOL_NAMES,
  TEST_TOOL_NAMES,
  TOOL_NAMES,
} from '@tula-tech/mcp'
import { createApp } from '../../../apps/api/src/index'
import { base32Decode, totp } from '../../../apps/api/src/lib/totp'
import * as Audit from '../../../apps/api/src/modules/audit/service'
import * as Mfa from '../../../apps/api/src/modules/mfa/service'
import * as Notices from '../../../apps/api/src/modules/notice/service'
import * as Sessions from '../../../apps/api/src/modules/session/service'
import {
  createInstanceTestDeps,
  seedApiKey,
  TEST_ADMIN_TOKEN,
  TEST_MASTER_KEY,
  TEST_TENANT,
  type TestDeps,
} from '../../../apps/api/src/testing'
import { INJECTED_KEY, INJECTION_CORPUS } from '../../mcp/src/testing/injection'
import { buildMcpServer } from './commands/mcp'
import { type CliIo, COMMANDS, runCli } from './index'
import { createOutput } from './output'

// `tula mcp` against the real API in process (memory adapters, `fetch` handed straight to the
// app): every read tool, with an account that has one of everything secret, and a search of
// every result and log line for all of it.

const SECRET_KEY = 'tula_sk_dev_mcptest0000000000000000000000000000'
const AGENT_KEY = 'tula_ak_dev_mcptest0000000000000000000000000000'
const BASE_URL = 'http://localhost:3003'
const PASSWORD = 'correct horse battery staple'
const GOOGLE_SECRET = 'google-client-secret-Mc81-do-not-return'
const CREDENTIAL_ID = 'CANARY-credential-id'
const PUBLIC_KEY = 'CANARY-public-key'
const tenant = { projectId: TEST_TENANT.projectId, environmentId: TEST_TENANT.environmentId }

let deps: TestDeps
let app: ReturnType<typeof createApp>
let dir: string
const closers: (() => Promise<void>)[] = []

beforeEach(async () => {
  deps = createInstanceTestDeps()
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
  await seedApiKey(deps, SECRET_KEY)
  await seedApiKey(deps, AGENT_KEY)
  app = createApp(deps)
  dir = await mkdtemp(join(tmpdir(), 'tula-mcp-test-'))
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ dependencies: { next: '16.0.0', react: '19.0.0' } })
  )
})

afterEach(async () => {
  for (const close of closers.splice(0)) {
    await close()
  }
  await Notices.settled()
  await rm(dir, { recursive: true, force: true })
})

async function admin(method: string, path: string, body?: unknown, headers: object = {}) {
  return app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${SECRET_KEY}`,
      'content-type': 'application/json',
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

interface World {
  io: CliIo
  /** Everything written to standard error. */
  stderr: () => string
  /** Everything written to standard output through the CLI's own writer. */
  stdout: () => string
  /** Every request, e.g. `GET /v1/admin/users`. */
  requests: string[]
}

function world(
  env: Record<string, string | undefined> = {},
  files: Record<string, string> = {}
): World {
  let stdout = ''
  let stderr = ''
  const requests: string[] = []
  const fetch: AdminFetch = async (url, init) => {
    requests.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`)
    return app.request(url, init)
  }
  return {
    io: {
      stdout: { write: (text) => (stdout += text) },
      stderr: { write: (text) => (stderr += text) },
      env: { TULA_API_URL: BASE_URL, TULA_SECRET_KEY: SECRET_KEY, ...env },
      cwd: dir,
      isTTY: false,
      fetch,
      readFile: async (path) => {
        const text = files[path]
        if (text === undefined) {
          throw new Error('ENOENT')
        }
        return text
      },
      now: () => deps.clock.now(),
    },
    stderr: () => stderr,
    stdout: () => stdout,
    requests,
  }
}

async function connect(
  w: World,
  flags: Record<string, string | boolean | undefined> = {}
): Promise<Client> {
  const server = await buildMcpServer({
    flags,
    positionals: [],
    io: w.io,
    output: createOutput(w.io.stdout, w.io.stderr, w.io.env),
  })
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0.0.0' })
  await server.connect(serverEnd)
  await client.connect(clientEnd)
  closers.push(async () => {
    await client.close()
    await server.close()
  })
  return client
}

interface Called {
  structured: Record<string, unknown>
  isError: boolean
  raw: string
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
): Promise<Called> {
  const result = (await client.callTool({ name, arguments: args })) as {
    structuredContent?: Record<string, unknown>
    isError?: boolean
  }
  return {
    structured: result.structuredContent ?? {},
    isError: result.isError === true,
    raw: JSON.stringify(result),
  }
}

/** An account with one of everything a tool must not return. */
async function seed() {
  const created = await admin('POST', '/v1/admin/users', {
    email: 'maya@northline.app',
    password: PASSWORD,
    firstName: 'Maya',
    emailVerified: true,
  })
  expect(created.status).toBe(201)
  const user = (await created.json()) as { id: string }
  const passwordHash =
    (await deps.users.findByEmailWithPassword(tenant.environmentId, 'maya@northline.app'))
      ?.passwordHash ?? ''
  const { secret, uri } = await Mfa.startTotp(deps, tenant, user.id)
  const { codes } = await Mfa.confirmTotp(
    deps,
    tenant,
    { userId: user.id },
    totp(base32Decode(secret), deps.clock.now()),
    { type: 'user', id: user.id, ipAddress: null, userAgent: null }
  )
  const sealed = (await deps.factors.findTotp(tenant.environmentId, user.id))?.secret ?? ''
  await deps.passkeys.create(
    {
      id: deps.ids.next(),
      ...tenant,
      userId: user.id,
      credentialId: CREDENTIAL_ID,
      publicKey: new TextEncoder().encode(PUBLIC_KEY),
      signCount: 0,
      transports: ['internal'],
      aaguid: '00000000-0000-0000-0000-000000000000',
      backupEligible: true,
      backedUp: true,
      userHandle: 'CANARY-user-handle',
      name: 'Laptop',
      lastUsedAt: null,
      createdAt: deps.clock.now(),
    },
    10,
    Audit.none('fixture')
  )
  const session = await Sessions.create(deps, tenant, {
    userId: user.id,
    client: 'ios',
    userAgent: 'TulaTest/1.0 (iPhone)',
    ipAddress: '203.0.113.9',
  })
  const provider = await admin('PUT', '/v1/admin/oauth-providers/google', {
    clientId: 'google-client-id.apps.example',
    clientSecret: GOOGLE_SECRET,
    additionalClientIds: ['1234567890-android.apps.googleusercontent.com'],
    enabled: true,
  })
  expect(provider.status).toBe(200)
  const current = (await (await admin('GET', '/v1/admin/settings')).json()) as {
    revision: number
    settings: { app: { name: string } }
  }
  const saved = await admin(
    'PUT',
    '/v1/admin/settings',
    { ...current.settings, app: { ...current.settings.app, name: 'Northline' } },
    { 'if-match': `"${current.revision}"` }
  )
  expect(saved.status).toBe(200)
  const secrets = [
    SECRET_KEY,
    TEST_ADMIN_TOKEN,
    TEST_MASTER_KEY,
    PASSWORD,
    passwordHash,
    secret,
    uri,
    sealed,
    ...codes,
    CREDENTIAL_ID,
    PUBLIC_KEY,
    'CANARY-user-handle',
    GOOGLE_SECRET,
    session.accessToken,
    session.refreshToken,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0)
  expect(secrets.length).toBeGreaterThanOrEqual(14)
  expect(passwordHash.startsWith('$argon2')).toBe(true)
  const [open] = await deps.sessions.listActiveByUser(
    tenant.environmentId,
    user.id,
    deps.clock.now()
  )
  return { user, secrets, sessionId: String(open?.id) }
}

/** A session id that names no session: for the calls that are refused before one is read. */
const NO_SESSION = '0198c1de-0000-7000-8000-0000000005e5'

const args = (
  userId: string,
  sessionId: string = NO_SESSION
): Record<string, Record<string, unknown>> => ({
  list_users: { query: 'maya' },
  get_user: { userId },
  list_user_sessions: { userId },
  list_audit_entries: { size: 100 },
  get_settings: {},
  list_oauth_providers: {},
  run_doctor: {},
  propose_ban_user: { userId },
  propose_unban_user: { userId },
  propose_end_session: { sessionId },
  propose_disable_oauth_provider: { provider: 'google' },
  test_signin: {},
  draft_settings_change: {
    settings: [{ path: 'password.minLength', value: 8 }],
    providers: [{ provider: 'google', enabled: false, secretEnv: 'GOOGLE_CLIENT_SECRET' }],
  },
  detect_framework: {},
  scaffold_provider: { framework: 'nextjs' },
  scaffold_protected_route: { framework: 'nextjs' },
  scaffold_sign_in_page: { framework: 'react-vite' },
})

describe('tula mcp against the real API', () => {
  test('every read tool answers, with the shapes the docs promise', async () => {
    const { user } = await seed()
    const w = world({ TULA_ADMIN_TOKEN: TEST_ADMIN_TOKEN })
    const client = await connect(w)

    const users = await call(client, 'list_users', { query: 'maya' })
    expect(users.isError).toBe(false)
    expect(users.structured.data).toEqual([
      {
        id: user.id,
        email: 'maya@northline.app',
        emailVerifiedAt: expect.any(String),
        firstName: 'Maya',
        lastName: null,
        bannedAt: null,
        lastSignInAt: null,
        createdAt: expect.any(String),
      },
    ])
    expect(users.structured.meta).toMatchObject({ totalCount: 1, page: 1 })

    const got = await call(client, 'get_user', { userId: user.id })
    expect(got.structured.user).toMatchObject({ id: user.id, email: 'maya@northline.app' })
    expect(got.structured.signInMethods).toEqual({
      hasPassword: true,
      emailVerified: true,
      identities: [],
      factors: [{ type: 'totp', confirmedAt: expect.any(String) }],
      backupCodesRemaining: expect.any(Number),
      passkeys: [
        {
          id: expect.any(String),
          name: 'Laptop',
          synced: true,
          createdAt: expect.any(String),
          lastUsedAt: null,
        },
      ],
      canSignInWithoutPasskeys: true,
    })

    const sessions = await call(client, 'list_user_sessions', { userId: user.id })
    expect(sessions.structured.data).toEqual([
      {
        id: expect.any(String),
        client: 'ios',
        userAgent: 'TulaTest/1.0 (iPhone)',
        ipAddress: '203.0.113.9',
        createdAt: expect.any(String),
        lastActiveAt: expect.any(String),
        expiresAt: expect.any(String),
        // A yes or no, and nothing of a device key (ADR 0043).
        deviceBound: false,
      },
    ])

    const audit = await call(client, 'list_audit_entries', { size: 100 })
    const actions = (audit.structured.data as { action: string }[]).map((entry) => entry.action)
    for (const action of [
      'user.created',
      'user.mfa_enabled',
      'session.created',
      'oauth_provider.updated',
      'environment.settings_updated',
    ]) {
      expect(actions).toContain(action)
    }
    const updated = (audit.structured.data as { action: string; metadata: object }[]).find(
      (entry) => entry.action === 'environment.settings_updated'
    )
    expect(updated?.metadata).toMatchObject({ changed: ['app.name'] })
    const filtered = await call(client, 'list_audit_entries', { action: 'session.created' })
    expect((filtered.structured.data as unknown[]).length).toBe(1)

    const settings = await call(client, 'get_settings')
    expect(settings.structured).toMatchObject({
      revision: expect.any(Number),
      settings: { app: { name: 'Northline' }, password: { minLength: expect.any(Number) } },
      managedBy: null,
    })

    const providers = await call(client, 'list_oauth_providers')
    expect(providers.structured.data).toContainEqual({
      provider: 'google',
      configured: true,
      enabled: true,
      clientId: 'google-client-id.apps.example',
      teamId: null,
      keyId: null,
      tenant: null,
      additionalClientIds: ['1234567890-android.apps.googleusercontent.com'],
      callbackUrl: 'http://localhost:3003/v1/oauth/callback/google',
      updatedAt: expect.any(String),
    })

    const doctor = await call(client, 'run_doctor')
    expect(doctor.isError).toBe(false)
    const checks = doctor.structured.checks as { id: string; source: string; status: string }[]
    expect(checks.some((check) => check.source === 'cli')).toBe(true)
    expect(checks.some((check) => check.source === 'server')).toBe(true)
    // The native checks come through the projection like every other: no app is registered.
    for (const id of ['native_app_identities', 'native_app_files', 'native_app_passkeys']) {
      expect(checks.find((check) => check.id === id)).toMatchObject({
        source: 'server',
        status: 'skipped',
      })
    }
    expect(doctor.structured.apiUrl).toBe(BASE_URL)
  })

  test('nothing seeded as a secret appears in any result or log line, and every request is a GET but the sign-in test’s', async () => {
    const { user, secrets } = await seed()
    const w = world({ TULA_ADMIN_TOKEN: TEST_ADMIN_TOKEN })
    const client = await connect(w)
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort())
    const outputs: string[] = [JSON.stringify(tools)]
    for (const tool of tools) {
      const result = await call(client, tool.name, args(user.id)[tool.name])
      // With a secret key and no agent key nothing is proposed: a secret key does not ask.
      expect(result.isError).toBe(PROPOSE_TOOL_NAMES.includes(tool.name))
      outputs.push(result.raw)
    }
    // Failures too: an unknown user, a refused parameter.
    outputs.push((await call(client, 'get_user', { userId: 'no-such-user' })).raw)
    outputs.push((await call(client, 'list_audit_entries', { action: 'nothing.like_this' })).raw)
    const everything = [...outputs, w.stderr(), w.stdout()].join('\n')
    for (const secret of secrets) {
      expect(everything).not.toContain(secret)
    }
    expect(everything).not.toContain('otpauth')
    expect(everything).not.toContain('$argon2')
    expect(everything).not.toContain('Bearer ')
    expect(w.stdout()).toBe('')
    expect(w.requests.length).toBeGreaterThan(8)
    // One request is not a read: the sign-in test, which a secret key runs on the admin route.
    expect(w.requests.filter((request) => !request.startsWith('GET '))).toEqual(
      TEST_TOOL_NAMES.map(() => 'POST /v1/admin/sign-in-tests')
    )
    for (const request of w.requests.filter((one) => one.startsWith('GET '))) {
      expect(request).toMatch(
        /^GET \/v1\/(admin\/(settings|users(\/[^/]+(\/(authentication|sessions))?)?|audit-logs|oauth-providers)|instance\/diagnostics|status)$/
      )
    }
  })

  test('draft_settings_change: an edit the config accepts, a weakening named, and the server as it was', async () => {
    await seed()
    const read = async () => ({
      settings: await (await admin('GET', '/v1/admin/settings')).json(),
      providers: await (await admin('GET', '/v1/admin/oauth-providers')).json(),
    })
    const before = await read()
    const w = world()
    const client = await connect(w)
    const draft = await call(client, 'draft_settings_change', {
      settings: [
        { path: 'password.minLength', value: 8 },
        { path: 'app.name', value: 'Northline Two' },
      ],
      providers: [
        { provider: 'google', enabled: false, secretEnv: 'GOOGLE_CLIENT_SECRET' },
        { provider: 'github', clientId: 'Iv1.example', secretEnv: 'GITHUB_CLIENT_SECRET' },
      ],
    })
    expect(draft.isError).toBe(false)
    expect(draft.structured.changed).toBe(false)
    expect(draft.structured.settings).toEqual([
      { path: 'password.minLength', from: expect.any(Number), to: 8, changes: true },
      { path: 'app.name', from: 'Northline', to: 'Northline Two', changes: true },
    ])
    expect(draft.structured.weakened).toEqual(['password.minLength'])
    expect(draft.structured.weakens).toBe(true)
    const entries = draft.structured.providers as {
      provider: string
      configured: boolean
      entry: Record<string, unknown>
    }[]
    expect(entries.map((entry) => [entry.provider, entry.configured])).toEqual([
      ['google', true],
      ['github', false],
    ])
    expect(entries[0]?.entry).toEqual({
      clientId: 'google-client-id.apps.example',
      additionalClientIds: ['1234567890-android.apps.googleusercontent.com'],
      enabled: false,
      clientSecret: { $env: 'GOOGLE_CLIENT_SECRET' },
    })
    // What was drafted is what `tula diff` and `tula apply` read: the config's own parser
    // takes the entries as they are.
    const config = parseConfig({
      environments: {
        dev: {
          providers: Object.fromEntries(entries.map((entry) => [entry.provider, entry.entry])),
        },
      },
    })
    expect(config.environments.dev?.providers?.github?.clientSecret).toEqual({
      $env: 'GITHUB_CLIENT_SECRET',
    })
    // The server holds what it held: the tool read twice and wrote nothing.
    expect(await read()).toEqual(before)
    expect(w.requests).toEqual(['GET /v1/admin/settings', 'GET /v1/admin/oauth-providers'])
    expect(draft.raw + w.stderr()).not.toContain(GOOGLE_SECRET)
    expect(w.stdout()).toBe('')
  })

  test('an error of the API becomes its code', async () => {
    const w = world()
    const client = await connect(w)
    const missing = await call(client, 'get_user', {
      userId: '0198c1de-0000-7000-8000-00000000dead',
    })
    expect(missing.isError).toBe(true)
    expect(missing.structured.error).toEqual({
      code: 'resource.not_found',
      status: 404,
      message: 'Nothing was found.',
    })
  })
})

describe('tula mcp: where its credentials come from', () => {
  test('with nothing configured the read tools say so and the scaffold tools work', async () => {
    const w = world({ TULA_API_URL: undefined, TULA_SECRET_KEY: undefined })
    const client = await connect(w)
    for (const name of [
      ...READ_TOOL_NAMES,
      ...DRAFT_TOOL_NAMES,
      ...PROPOSE_TOOL_NAMES,
      ...TEST_TOOL_NAMES,
    ]) {
      const result = await call(client, name, args('x')[name])
      expect(result.isError).toBe(true)
      expect((result.structured.error as { code: string }).code).toBe('not_configured')
    }
    for (const name of SCAFFOLD_TOOL_NAMES) {
      expect((await call(client, name, args('x')[name])).isError).toBe(false)
    }
    expect(w.requests).toEqual([])
    expect(w.stderr()).toContain('Read tools: not configured')
    expect(w.stderr()).toContain('Propose tools: not configured')
    expect(w.stderr()).toContain('No secret key')
    // No environment was named, so no variable of a "default" environment is suggested.
    const settings = await call(client, 'get_settings')
    expect(w.stderr() + settings.raw).not.toContain('_DEFAULT')
    expect(settings.raw).toContain('TULA_SECRET_KEY')
  })

  test('without an admin token the doctor runs the checks this machine can make', async () => {
    const w = world()
    const client = await connect(w)
    const doctor = await call(client, 'run_doctor')
    expect(doctor.isError).toBe(false)
    expect(w.requests).not.toContain('GET /v1/instance/diagnostics')
  })

  test('a doctor call the client cancels takes its request to the API with it', async () => {
    const w = world()
    let open = 0
    // An API that never answers its status: the request ends only when its signal aborts.
    w.io.fetch = (_url, init) => {
      open += 1
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          open -= 1
          reject(init.signal?.reason)
        })
      })
    }
    const client = await connect(w)
    const cancel = new AbortController()
    const doctor = client
      .callTool({ name: 'run_doctor', arguments: {} }, { signal: cancel.signal })
      .then(
        () => 'answered',
        () => 'cancelled'
      )
    const until = async (count: number) => {
      for (let waited = 0; waited < 500 && open !== count; waited += 1) {
        await Bun.sleep(2)
      }
      expect(open).toBe(count)
    }
    await until(1)
    cancel.abort()
    expect(await doctor).toBe('cancelled')
    await until(0)
  })

  test('the key is read from --secret-key-file and from the named environment’s variables', async () => {
    const fromFile = world({ TULA_SECRET_KEY: undefined }, { 'key.txt': `${SECRET_KEY}\n` })
    const first = await connect(fromFile, { 'secret-key-file': 'key.txt' })
    expect((await call(first, 'get_settings')).isError).toBe(false)

    const named = world({
      TULA_SECRET_KEY: undefined,
      TULA_API_URL: undefined,
      TULA_SECRET_KEY_STAGING: SECRET_KEY,
      TULA_API_URL_STAGING: BASE_URL,
    })
    const second = await connect(named, { env: 'staging' })
    expect((await call(second, 'get_settings')).isError).toBe(false)
    expect((await call(second, 'run_doctor')).structured.apiUrl).toBe(BASE_URL)
  })

  test('a plain http API that is not this machine is refused: nothing is sent, and the tool says why', async () => {
    const w = world({
      TULA_API_URL: 'http://auth.internal.example',
      TULA_ADMIN_TOKEN: TEST_ADMIN_TOKEN,
    })
    const client = await connect(w)
    const settings = await call(client, 'get_settings')
    expect(settings.structured.error).toMatchObject({ code: 'not_configured' })
    expect((settings.structured.error as { message: string }).message).toContain('plain http')
    const doctor = await call(client, 'run_doctor')
    expect(doctor.structured.error).toMatchObject({ code: 'not_configured' })
    expect(w.requests).toEqual([])
  })

  test('a key that is not a secret key is refused without being repeated', async () => {
    const w = world({ TULA_SECRET_KEY: 'tula_pk_dev_publishable0000000000000000000' })
    const client = await connect(w)
    const settings = await call(client, 'get_settings')
    expect(settings.structured.error).toMatchObject({ code: 'not_configured' })
    expect(settings.raw + w.stderr()).not.toContain('publishable0000')
    expect(w.requests).toEqual([])
  })

  test.each(['secret-key-file', 'admin-token-file', 'agent-key-file'])(
    '--%s - is refused: standard input carries the protocol',
    async (option) => {
      const w = world()
      const io = { ...w.io, serve: { input: new PassThrough(), output: new PassThrough() } }
      const code = await runCli(['mcp', `--${option}`, '-'], io, COMMANDS)
      expect(code).toBe(1)
      expect(w.stderr()).toContain('standard input, which carries the protocol')
      expect(w.stdout()).toBe('')
    }
  )

  test('there is no option that takes a secret', async () => {
    const w = world()
    const code = await runCli(['mcp', '--secret-key', SECRET_KEY], w.io, COMMANDS)
    expect(code).toBe(1)
    expect(w.stdout() + w.stderr()).not.toContain(SECRET_KEY)
  })

  test('without the process’s streams the command says so', async () => {
    const w = world()
    expect(await runCli(['mcp'], w.io, COMMANDS)).toBe(1)
    expect(w.stderr()).toContain('standard input and output')
  })
})

describe('tula mcp with an agent key', () => {
  const agentEnv = { TULA_SECRET_KEY: undefined, TULA_AGENT_KEY: AGENT_KEY }

  async function banned(userId: string): Promise<boolean> {
    const user = (await (await admin('GET', `/v1/admin/users/${userId}`)).json()) as {
      bannedAt: string | null
    }
    return user.bannedAt !== null
  }

  /** Everything a proposal could change, as the admin API answers it. */
  async function stateOf(userIds: readonly string[]): Promise<string> {
    const read = async (path: string) => (await admin('GET', path)).json()
    const users = []
    for (const id of userIds) {
      users.push(await read(`/v1/admin/users/${id}`), await read(`/v1/admin/users/${id}/sessions`))
    }
    return JSON.stringify({
      users,
      providers: await read('/v1/admin/oauth-providers'),
      settings: await read('/v1/admin/settings'),
    })
  }

  test('every tool answers; the requests are GETs, the POSTs that ask, one a propose tool, and the sign-in test’s; nothing is changed and no user is left', async () => {
    const { user, secrets, sessionId } = await seed()
    const before = await stateOf([user.id])
    const w = world(agentEnv)
    const client = await connect(w)
    const outputs: string[] = []
    for (const name of TOOL_NAMES) {
      const result = await call(client, name, args(user.id, sessionId)[name])
      expect(result.isError).toBe(false)
      outputs.push(result.raw)
    }
    const writes = w.requests.filter((request) => !request.startsWith('GET '))
    expect(writes.filter((request) => request !== 'POST /v1/agent/sign-in-tests')).toEqual(
      PROPOSE_TOOL_NAMES.map(() => 'POST /v1/agent/proposals')
    )
    expect(writes.filter((request) => request === 'POST /v1/agent/sign-in-tests')).toHaveLength(1)
    expect(PROPOSE_TOOL_NAMES).toHaveLength(4)
    expect(await banned(user.id)).toBe(false)
    expect(await stateOf([user.id])).toBe(before)
    // The sign-in test made a user and deleted it: the environment has the one it had.
    const users = (await (await admin('GET', '/v1/admin/users')).json()) as {
      meta: { totalCount: number }
    }
    expect(users.meta.totalCount).toBe(1)
    const everything = [...outputs, w.stderr(), w.stdout()].join('\n')
    for (const secret of [...secrets, AGENT_KEY]) {
      expect(everything).not.toContain(secret)
    }
    expect(everything).not.toContain('tula_ak_')
    expect(w.stderr()).toContain('Read tools: configured (agent key). Propose tools: configured.')
  })

  test('propose_ban_user: a pending proposal, the user untouched, and the audit log names the agent', async () => {
    const { user } = await seed()
    const client = await connect(world(agentEnv))
    const proposed = await call(client, 'propose_ban_user', { userId: user.id })
    expect(proposed.isError).toBe(false)
    expect(proposed.structured).toMatchObject({
      proposal: {
        operation: 'ban_user',
        target: { type: 'user', id: user.id },
        status: 'pending',
      },
      changed: false,
    })
    expect(await banned(user.id)).toBe(false)
    // Asking again is the same proposal: an agent in a loop does not fill the list.
    const again = await call(client, 'propose_ban_user', { userId: user.id })
    expect((again.structured.proposal as { id: string }).id).toBe(
      (proposed.structured.proposal as { id: string }).id
    )
    const audit = await call(client, 'list_audit_entries', { action: 'proposal.created' })
    const entries = audit.structured.data as {
      actor: { type: string }
      metadata: Record<string, unknown>
    }[]
    expect(entries).toHaveLength(1)
    expect(entries[0]?.actor.type).toBe('agent')
    expect(entries[0]?.metadata).toMatchObject({
      operation: 'ban_user',
      targetType: 'user',
      targetId: user.id,
    })
  })

  // The other reversible operations (ADR 0053): each tool asks and changes nothing, and what
  // a person then approves is what happens.
  test.each([
    ['propose_unban_user', 'unban_user', 'user'],
    ['propose_end_session', 'end_session', 'session'],
    ['propose_disable_oauth_provider', 'disable_oauth_provider', 'oauth_provider'],
  ] as const)(
    '%s: a pending proposal, nothing changed, and an approval carries it out',
    async (tool, operation, type) => {
      const { user, sessionId } = await seed()
      if (operation === 'unban_user') {
        expect((await admin('POST', `/v1/admin/users/${user.id}/ban`)).status).toBe(200)
      }
      const session = sessionId
      const target = { user: user.id, session, oauth_provider: 'google' }[type]
      const before = await stateOf([user.id])
      const w = world(agentEnv)
      const client = await connect(w)
      const proposed = await call(client, tool, args(user.id, session)[tool])
      expect(proposed.isError).toBe(false)
      expect(proposed.structured).toMatchObject({
        proposal: { operation, target: { type, id: target }, status: 'pending' },
        changed: false,
      })
      expect(w.requests.filter((request) => !request.startsWith('GET '))).toEqual([
        'POST /v1/agent/proposals',
      ])
      expect(await stateOf([user.id])).toBe(before)
      // The agent key cannot approve what it asked for.
      const id = (proposed.structured.proposal as { id: string }).id
      const byAgent = await app.request(`/v1/admin/proposals/${id}/approve`, {
        method: 'POST',
        headers: { authorization: `Bearer ${AGENT_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ operation, target: { type, id: target } }),
      })
      expect(byAgent.status).toBe(401)
      expect(await stateOf([user.id])).toBe(before)
      const approved = await admin('POST', `/v1/admin/proposals/${id}/approve`, {
        operation,
        target: { type, id: target },
      })
      expect(approved.status).toBe(200)
      expect(((await approved.json()) as { status: string }).status).toBe('executed')
      expect(await stateOf([user.id])).not.toBe(before)
    }
  )

  // The injection corpus where an outsider can write and an agent reads (a user's name, a
  // session's user agent), for every propose tool: whatever a model made of it, the server
  // changed nothing, because nothing but a person's approval changes anything.
  test.each(INJECTION_CORPUS)(
    'injected text (%s): every propose tool asks, and no write happens without an approval',
    async (_kind, text) => {
      const { user } = await seed()
      const name = text.slice(0, 100).trim()
      const made = await admin('POST', '/v1/admin/users', {
        email: 'injected@northline.app',
        password: PASSWORD,
        firstName: name,
        lastName: name,
      })
      expect(made.status).toBe(201)
      const injected = (await made.json()) as { id: string; firstName: string | null }
      expect(injected.firstName).toBe(name)
      await Sessions.create(deps, tenant, {
        userId: injected.id,
        client: 'ios',
        userAgent: text,
        ipAddress: '203.0.113.9',
      })
      const [open] = await deps.sessions.listActiveByUser(
        tenant.environmentId,
        injected.id,
        deps.clock.now()
      )
      const sessionId = String(open?.id)
      const before = await stateOf([user.id, injected.id])
      const recorded = async () =>
        (
          (await (await admin('GET', '/v1/admin/audit-logs?size=100')).json()) as {
            data: { action: string }[]
          }
        ).data.map((entry) => entry.action)
      const auditBefore = await recorded()
      const w = world(agentEnv)
      const client = await connect(w)
      // The agent reads what was planted, as a model would before it is talked into acting.
      const read = [
        await call(client, 'get_user', { userId: injected.id }),
        await call(client, 'list_user_sessions', { userId: injected.id }),
      ]
      const proposed: Called[] = []
      for (const tool of PROPOSE_TOOL_NAMES) {
        proposed.push(await call(client, tool, args(injected.id, sessionId)[tool]))
      }
      for (const result of proposed) {
        expect(result.isError).toBe(false)
        expect(result.structured.changed).toBe(false)
        expect((result.structured.proposal as { status: string }).status).toBe('pending')
        // A proposal's answer holds ids, closed words and the contract's own sentence: none
        // of the planted text is in it.
        expect(result.raw).not.toContain('approve.invalid')
        expect(result.raw).not.toContain('Ignore all previous')
        expect(result.raw).not.toContain('im_start')
      }
      for (const result of [...read, ...proposed]) {
        expect(result.raw).not.toContain(INJECTED_KEY)
        expect(result.raw.length).toBeLessThan(70_000)
      }
      expect(w.requests.filter((request) => !request.startsWith('GET '))).toEqual(
        PROPOSE_TOOL_NAMES.map(() => 'POST /v1/agent/proposals')
      )
      // No write without an approval: the users, their sessions, the providers and the
      // settings are byte for byte what they were, and all that was recorded is the asking.
      expect(await stateOf([user.id, injected.id])).toBe(before)
      const audit = await recorded()
      expect(audit.length).toBeLessThan(100)
      expect(audit.slice(0, audit.length - auditBefore.length)).toEqual(
        PROPOSE_TOOL_NAMES.map(() => 'proposal.created')
      )
    }
  )
  test('test_signin: every step reported, no user left, and the audit log names the agent', async () => {
    const { user, secrets } = await seed()
    const w = world(agentEnv)
    const client = await connect(w)
    const result = await call(client, 'test_signin')
    expect(result.isError).toBe(false)
    expect(result.structured.outcome).toBe('passed')
    expect(result.structured.cleanup).toBe('deleted')
    const steps = result.structured.steps as { step: string; outcome: string }[]
    expect(steps.map((step) => `${step.step} ${step.outcome}`)).toEqual([
      'sign_up passed',
      'verify_email passed',
      'sign_out passed',
      'sign_in passed',
      'first_factor passed',
      'revoke_session passed',
      'delete_user passed',
    ])
    // Nothing but closed words, numbers and the id of a user that is gone.
    expect(Object.keys(result.structured).sort()).toEqual(['cleanup', 'outcome', 'steps', 'userId'])
    for (const step of steps) {
      expect(Object.keys(step).sort()).toEqual(['durationMs', 'outcome', 'step'])
    }
    const everything = [result.raw, w.stderr(), w.stdout()].join('\n')
    for (const secret of [...secrets, AGENT_KEY]) {
      expect(everything).not.toContain(secret)
    }
    expect(everything).not.toContain('tula.invalid')
    expect(everything).not.toContain('tula-test-')
    expect(everything).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\./)
    // The environment has the user it had, and no mail left the server.
    const users = (await (await admin('GET', '/v1/admin/users')).json()) as {
      data: { id: string }[]
    }
    expect(users.data.map((one) => one.id)).toEqual([user.id])
    expect(JSON.stringify(deps.mailer.outbox)).not.toContain('tula.invalid')
    // The run and the deletion of its user are the agent's, in the audit log a tool reads.
    for (const action of ['sign_in_test.started', 'sign_in_test.finished', 'user.deleted']) {
      const audit = await call(client, 'list_audit_entries', { action })
      const entries = audit.structured.data as { actor: { type: string } }[]
      expect(entries).toHaveLength(1)
      expect(entries[0]?.actor.type).toBe('agent')
    }
    expect(w.requests.filter((request) => !request.startsWith('GET '))).toEqual([
      'POST /v1/agent/sign-in-tests',
    ])
  })

  test('test_signin: a second run inside the minute is refused, and nothing is created', async () => {
    await seed()
    const client = await connect(world(agentEnv))
    expect((await call(client, 'test_signin')).isError).toBe(false)
    const again = await call(client, 'test_signin')
    expect(again.isError).toBe(true)
    expect(again.structured.error).toMatchObject({ code: 'rate_limited', status: 429 })
    const started = await call(client, 'list_audit_entries', { action: 'sign_in_test.started' })
    expect(started.structured.data).toHaveLength(1)
  })

  test('test_signin: a production environment refuses unless its setting says otherwise', async () => {
    const productionKey = 'tula_ak_live_mcptest000000000000000000000000000'
    await seedApiKey(deps, productionKey, { environmentId: TEST_TENANT.productionEnvironmentId })
    const w = world({ TULA_SECRET_KEY: undefined, TULA_AGENT_KEY: productionKey })
    const client = await connect(w)
    const result = await call(client, 'test_signin')
    expect(result.isError).toBe(true)
    expect(result.structured.error).toMatchObject({ code: 'auth.forbidden', status: 403 })
    expect(result.structured.steps).toBeUndefined()
    const started = await call(client, 'list_audit_entries', { action: 'sign_in_test.started' })
    expect(started.structured.data).toEqual([])
  })

  test('with an agent key the secret key is not read, although it is set', async () => {
    const { user } = await seed()
    const seen: (string | null)[] = []
    const w = world({ TULA_AGENT_KEY: AGENT_KEY })
    const inner = w.io.fetch as AdminFetch
    const io: CliIo = {
      ...w.io,
      fetch: (url, init) => {
        seen.push(new Headers(init?.headers).get('authorization'))
        return inner(url, init)
      },
    }
    const client = await connect({ ...w, io })
    for (const name of [
      ...READ_TOOL_NAMES,
      ...DRAFT_TOOL_NAMES,
      ...PROPOSE_TOOL_NAMES,
      ...TEST_TOOL_NAMES,
    ]) {
      await call(client, name, args(user.id)[name])
    }
    expect(seen.length).toBeGreaterThan(5)
    for (const authorization of seen) {
      expect(authorization).not.toBe(`Bearer ${SECRET_KEY}`)
    }
    expect(seen).toContain(`Bearer ${AGENT_KEY}`)
    expect(w.stderr()).toContain('so the secret key was not read')
    expect(w.stderr()).not.toContain(SECRET_KEY)
  })

  test('an agent key that is not one is refused without being repeated, and the secret key does not stand in', async () => {
    const w = world({ TULA_AGENT_KEY: 'tula_sk_dev_notanagentkey00000000000000000000' })
    const client = await connect(w)
    for (const name of ['get_settings', 'propose_ban_user']) {
      const result = await call(client, name, args('0198c1de-0000-7000-8000-00000000dead')[name])
      expect(result.structured.error).toMatchObject({ code: 'not_configured' })
      expect(result.raw).not.toContain('notanagentkey')
    }
    expect(w.stderr()).not.toContain('notanagentkey')
    expect(w.requests).toEqual([])
  })

  test('the key is read from --agent-key-file and from the named environment’s variables', async () => {
    const { user } = await seed()
    const fromFile = world({ TULA_SECRET_KEY: undefined }, { 'agent.txt': `${AGENT_KEY}\n` })
    const first = await connect(fromFile, { 'agent-key-file': 'agent.txt' })
    expect((await call(first, 'propose_ban_user', { userId: user.id })).isError).toBe(false)
    const named = world({
      TULA_SECRET_KEY: undefined,
      TULA_API_URL: undefined,
      TULA_API_URL_STAGING: BASE_URL,
      TULA_AGENT_KEY_STAGING: AGENT_KEY,
    })
    const second = await connect(named, { env: 'staging' })
    expect((await call(second, 'get_settings')).isError).toBe(false)
  })

  test('a proposal for a production environment is refused, and says so by code', async () => {
    const productionKey = 'tula_ak_live_mcptest000000000000000000000000000'
    await seedApiKey(deps, productionKey, { environmentId: TEST_TENANT.productionEnvironmentId })
    const w = world({ TULA_SECRET_KEY: undefined, TULA_AGENT_KEY: productionKey })
    const client = await connect(w)
    const result = await call(client, 'propose_ban_user', {
      userId: '0198c1de-0000-7000-8000-00000000dead',
    })
    expect(result.isError).toBe(true)
    expect(result.structured.error).toMatchObject({ code: 'auth.forbidden', status: 403 })
  })
})

describe('tula mcp: the wire', () => {
  /** Run the real command over a pair of streams, speaking the protocol by hand. */
  function serve(w: World) {
    const input = new PassThrough()
    const output = new PassThrough()
    let wire = ''
    output.on('data', (chunk) => {
      wire += String(chunk)
    })
    let terminate: (() => void) | undefined
    let stoppedListening = false
    const done = runCli(
      ['mcp'],
      {
        ...w.io,
        serve: {
          input,
          output,
          onTerminate: (stop) => {
            terminate = stop
            return () => {
              stoppedListening = true
            }
          },
        },
      },
      COMMANDS
    )
    const send = (message: object) => input.write(`${JSON.stringify(message)}\n`)
    const answer = async (id: number): Promise<Record<string, unknown>> => {
      for (let waited = 0; waited < 200; waited += 1) {
        for (const line of wire.split('\n')) {
          if (line.trim() !== '' && (JSON.parse(line) as { id?: number }).id === id) {
            return JSON.parse(line) as Record<string, unknown>
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      throw new Error(`no answer to ${id}`)
    }
    return {
      input,
      send,
      answer,
      done,
      wire: () => wire,
      terminate: () => terminate?.(),
      stoppedListening: () => stoppedListening,
    }
  }

  const INITIALIZE = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'by-hand', version: '0.0.0' },
    },
  }

  test('standard output carries only protocol messages, and the command ends when input ends', async () => {
    await seed()
    const w = world()
    const run = serve(w)
    run.send(INITIALIZE)
    const hello = await run.answer(1)
    expect((hello.result as { serverInfo: { name: string } }).serverInfo.name).toBe('tula')
    run.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    run.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'list_users', arguments: {} },
    })
    const users = await run.answer(2)
    expect(JSON.stringify(users)).toContain('maya@northline.app')
    // A failing call and a line that is not JSON at all: still nothing but frames.
    run.send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'get_user', arguments: { userId: 'nobody' } },
    })
    await run.answer(3)
    run.input.write('this is not json\n')
    run.send({ jsonrpc: '2.0', id: 4, method: 'tools/list' })
    await run.answer(4)
    run.input.end()
    expect(await run.done).toBe(0)

    const lines = run
      .wire()
      .split('\n')
      .filter((line) => line !== '')
    expect(lines.length).toBeGreaterThanOrEqual(4)
    for (const line of lines) {
      expect((JSON.parse(line) as { jsonrpc: string }).jsonrpc).toBe('2.0')
    }
    // Nothing went through the CLI's own standard output writer either.
    expect(w.stdout()).toBe('')
    expect(w.stderr()).toContain(
      'tula mcp: 17 tools; one changes live data while it runs (test_signin, where the environment allows it). Read tools: configured. Propose tools: not configured.'
    )
    expect(w.stderr()).toContain('tula mcp: list_users ok')
    expect(run.wire() + w.stderr()).not.toContain(SECRET_KEY)
    expect(run.stoppedListening()).toBe(true)
  })

  test('the command ends when the process is asked to stop', async () => {
    const w = world()
    const run = serve(w)
    run.send(INITIALIZE)
    await run.answer(1)
    run.terminate()
    expect(await run.done).toBe(0)
  })
})
