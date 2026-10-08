import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import type { AdminFetch } from '@tula/admin'
import { READ_TOOL_NAMES, SCAFFOLD_TOOL_NAMES, TOOL_NAMES } from '@tula/mcp'
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
import { buildMcpServer } from './commands/mcp'
import { type CliIo, COMMANDS, runCli } from './index'
import { createOutput } from './output'

// `tula mcp` against the real API in process (memory adapters, `fetch` handed straight to the
// app): every read tool, with an account that has one of everything secret, and a search of
// every result and log line for all of it.

const SECRET_KEY = 'tula_sk_dev_mcptest0000000000000000000000000000'
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
  return { user, secrets }
}

const args = (userId: string): Record<string, Record<string, unknown>> => ({
  list_users: { query: 'maya' },
  get_user: { userId },
  list_user_sessions: { userId },
  list_audit_entries: { size: 100 },
  get_settings: {},
  list_oauth_providers: {},
  run_doctor: {},
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
      callbackUrl: 'http://localhost:3003/v1/oauth/callback/google',
      updatedAt: expect.any(String),
    })

    const doctor = await call(client, 'run_doctor')
    expect(doctor.isError).toBe(false)
    const checks = doctor.structured.checks as { id: string; source: string; status: string }[]
    expect(checks.some((check) => check.source === 'cli')).toBe(true)
    expect(checks.some((check) => check.source === 'server')).toBe(true)
    expect(doctor.structured.apiUrl).toBe(BASE_URL)
  })

  test('nothing seeded as a secret appears in any result or log line, and every request is a GET', async () => {
    const { user, secrets } = await seed()
    const w = world({ TULA_ADMIN_TOKEN: TEST_ADMIN_TOKEN })
    const client = await connect(w)
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort())
    const outputs: string[] = [JSON.stringify(tools)]
    for (const tool of tools) {
      const result = await call(client, tool.name, args(user.id)[tool.name])
      expect(result.isError).toBe(false)
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
    for (const request of w.requests) {
      expect(request).toMatch(
        /^GET \/v1\/(admin\/(settings|users(\/[^/]+(\/(authentication|sessions))?)?|audit-logs|oauth-providers)|instance\/diagnostics|status)$/
      )
    }
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
    for (const name of READ_TOOL_NAMES) {
      const result = await call(client, name, args('x')[name])
      expect(result.isError).toBe(true)
      expect((result.structured.error as { code: string }).code).toBe('not_configured')
    }
    for (const name of SCAFFOLD_TOOL_NAMES) {
      expect((await call(client, name, args('x')[name])).isError).toBe(false)
    }
    expect(w.requests).toEqual([])
    expect(w.stderr()).toContain('Read tools: not configured')
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

  test.each(['secret-key-file', 'admin-token-file'])(
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
    expect(w.stderr()).toContain('tula mcp: 11 tools, all read-only. Read tools: configured.')
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
