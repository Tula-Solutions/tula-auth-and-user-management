import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AdminFetch } from '@tula-tech/admin'
import { DEFAULT_ENVIRONMENT_SETTINGS } from '@tula-tech/contract'
import { createApp } from '../../../apps/api/src/index'
import * as Flows from '../../../apps/api/src/modules/flow/service'
import { USER_IMPORT_RATE_LIMIT } from '../../../apps/api/src/modules/user/router'
import {
  createTestDeps,
  seedApiKey,
  TEST_TENANT,
  type TestDeps,
} from '../../../apps/api/src/testing'
import type { Host } from './host'
import { type CliIo, COMMANDS, runCli } from './index'
import { createProcessHost } from './process-host'
import { fixture } from './testing/import-fixtures'

// `tula import` against the real API in process: memory adapters, real argon2/bcrypt/scrypt
// verification, the real rate limiter and the real organization routes. The fixtures are the
// same files the unit tests parse; here the server reads what the parsers wrote, and a user
// signs in with the password the old provider's hash was made from.

const SECRET_KEY = 'tula_sk_dev_importreal000000000000000000000000'
const BASE_URL = 'http://localhost:3003'
const tenant = {
  projectId: TEST_TENANT.projectId,
  environmentId: TEST_TENANT.environmentId,
  apiKeyId: 'key_1',
}
const web: Flows.ClientContext = {
  client: 'web',
  userAgent: 'Mozilla/5.0',
  ipAddress: '203.0.113.7',
  originAllowed: true,
}

let deps: TestDeps
let app: ReturnType<typeof createApp>
let dir: string
const printed: string[] = []
/** Every progress file any test left, read before its directory was removed. */
const progressFiles: string[] = []

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
  await seedApiKey(deps, SECRET_KEY)
  app = createApp(deps)
  dir = await mkdtemp(join(tmpdir(), 'tula-import-test-'))
})

afterEach(async () => {
  for (const name of await readdir(dir)) {
    if (name.endsWith('.tula-import-progress.json')) {
      progressFiles.push(await readFile(join(dir, name), 'utf8'))
    }
  }
  await rm(dir, { recursive: true, force: true })
})

interface Run {
  code: number
  stdout: string
  stderr: string
  sleeps: number[]
  requests: string[]
}

async function put(name: string, text: string): Promise<void> {
  await writeFile(join(dir, name), text)
}

async function tula(
  args: string[],
  options: {
    intercept?: (method: string, path: string, call: number) => Response | undefined
    /** Let the API handle the request, commit it, and lose the answer (the call that fails). */
    lose?: (method: string, path: string, call: number) => boolean
    env?: Record<string, string>
  } = {}
): Promise<Run> {
  let stdout = ''
  let stderr = ''
  const sleeps: number[] = []
  const requests: string[] = []
  const counts = new Map<string, number>()
  const fetch: AdminFetch = async (url, init) => {
    const method = init?.method ?? 'GET'
    const path = url.slice(BASE_URL.length)
    requests.push(`${method} ${path}`)
    const call = (counts.get(`${method} ${path}`) ?? 0) + 1
    counts.set(`${method} ${path}`, call)
    const replaced = options.intercept?.(method, path, call)
    if (replaced) {
      return replaced
    }
    const answer = await app.request(url, init)
    if (options.lose?.(method, path, call)) {
      throw new Error('socket hang up')
    }
    return answer
  }
  // The real host, with waiting replaced by moving the API's own clock: the rate limiter's
  // window passes without the test sleeping for a minute.
  const host: Host = {
    ...createProcessHost({}),
    sleep: async (ms: number) => {
      sleeps.push(ms)
      deps.clock.advance(ms)
    },
  }
  const code = await runCli(
    args,
    {
      stdout: { write: (text) => (stdout += text) },
      stderr: { write: (text) => (stderr += text) },
      env: { TULA_API_URL: BASE_URL, TULA_SECRET_KEY: SECRET_KEY, ...options.env },
      cwd: dir,
      isTTY: false,
      fetch,
      host,
    } satisfies CliIo,
    COMMANDS
  )
  printed.push(stdout, stderr)
  return { code, stdout, stderr, sleeps, requests }
}

async function admin(path: string, init: RequestInit = {}): Promise<Response> {
  return app.request(path, {
    ...init,
    headers: {
      authorization: `Bearer ${SECRET_KEY}`,
      'content-type': 'application/json',
      ...init.headers,
    },
  })
}

async function users(): Promise<{ id: string; email: string | null }[]> {
  const body = (await (await admin('/v1/admin/users?size=100')).json()) as {
    data: { id: string; email: string | null }[]
  }
  return body.data
}

const signIn = async (identifier: string, password: string) => {
  const { attempt } = await Flows.signIn(deps, tenant, { identifier }, web)
  return Flows.submitPassword(
    deps,
    tenant,
    { id: attempt.id, secret: attempt.attemptSecret },
    password,
    web
  )
}

/** The progress file of a run, parsed. */
async function progress(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(dir, `${name}.tula-import-progress.json`), 'utf8'))
}

describe('tula import against the real API', () => {
  test('Supabase: a user signs in with the password their bcrypt hash was made from', async () => {
    await put('users.csv', fixture('supabase-users.csv'))
    const dry = await tula(['import', '--from', 'supabase', 'users.csv'])
    expect(dry.requests).toEqual([])
    const run = await tula(['import', '--from', 'supabase', 'users.csv', '--yes'])
    expect(run.code).toBe(2)
    expect(run.requests).toEqual(['POST /v1/admin/users/import'])
    expect((await users()).map((user) => user.email).sort()).toEqual([
      'jon@northline.app',
      'maya@northline.app',
      'priya@northline.app',
    ])
    const signedIn = await signIn('maya@northline.app', 'correct-horse-1')
    expect(signedIn.tokens).toBeDefined()
    const wrong = await signIn('maya@northline.app', 'correct-horse-2').catch((error) => error)
    expect(wrong).toBeInstanceOf(Error)
    const kept = await progress('users.csv')
    expect(kept).toMatchObject({ doneThrough: 3, counts: { created: 3, skipped: 0, refused: 0 } })
    expect(JSON.stringify(kept)).not.toContain('northline')
    expect(JSON.stringify(kept)).not.toContain('$2a$')
  })

  test('running the same import again, from scratch, creates nobody twice', async () => {
    await put('users.csv', fixture('supabase-users.csv'))
    await tula(['import', '--from', 'supabase', 'users.csv', '--yes'])
    const again = await tula(['import', '--from', 'supabase', 'users.csv', '--yes', '--fresh'])
    expect(again.stdout).toContain('Users created:            0')
    expect(again.stdout).toContain('Users skipped:            3')
    expect(await users()).toHaveLength(3)
  })

  test('Firebase: scrypt hashes with the project parameters from a file; the user signs in', async () => {
    await put('fb.json', fixture('firebase-users.json'))
    await put('cfg.txt', fixture('firebase-hash-config.txt'))
    const run = await tula([
      'import',
      '--from',
      'firebase',
      'fb.json',
      '--yes',
      '--firebase-hash-config',
      'cfg.txt',
    ])
    expect(run.stdout).toContain('Users created:            2')
    expect((await signIn('maya@northline.app', 'user1password')).tokens).toBeDefined()
    expect(
      await signIn('maya@northline.app', 'user1passwor').catch((error) => error)
    ).toBeInstanceOf(Error)
  })

  test('Auth0: the support export of hashes is joined to the users', async () => {
    await put('users.ndjson', fixture('auth0-users.ndjson'))
    await put('hashes.ndjson', fixture('auth0-password-hashes.ndjson'))
    const run = await tula([
      'import',
      '--from',
      'auth0',
      'users.ndjson',
      '--yes',
      '--password-hashes',
      'hashes.ndjson',
    ])
    expect(run.stdout).toContain('Users created:            4')
    expect((await signIn('maya@northline.app', 'correct-horse-1')).tokens).toBeDefined()
    expect((await signIn('ines@northline.app', 'correct-horse-3')).tokens).toBeDefined()
  })

  test('better-auth: the argon2 and bcrypt users sign in; the scrypt user is refused with the reason', async () => {
    await put('user.json', fixture('better-auth-user.json'))
    await put('account.json', fixture('better-auth-account.json'))
    const run = await tula([
      'import',
      '--from',
      'better-auth',
      'user.json',
      '--accounts',
      'account.json',
      '--yes',
    ])
    expect(run.stdout).toContain('Users created:            3')
    expect(run.stdout).toContain('scrypt')
    expect((await signIn('jon@northline.app', 'argon-pass-1')).tokens).toBeDefined()
    expect((await signIn('ines@northline.app', 'correct-horse-3')).tokens).toBeDefined()
    expect((await users()).map((user) => user.email)).not.toContain('maya@northline.app')
  })

  test('the server’s own refusal of a hash is reported by row and code', async () => {
    await put(
      'users.json',
      JSON.stringify([
        {
          id: 'a',
          email: 'weak@example.test',
          encrypted_password: '$2a$04$NDhuqUZcBQ/LFla5qSAXXezYn7yAR/RITInkyddwtdh1ANBpFw7hS',
        },
        { id: 'b', email: 'fine@example.test' },
      ])
    )
    const run = await tula(['import', '--from', 'supabase', 'users.json', '--yes'])
    expect(run.code).toBe(2)
    expect(run.stdout).toMatch(/user 1 {2}import\.hash_parameters_too_weak {2}w\*\*\*@\*\*\*\.test/)
    expect(await progress('users.json')).toMatchObject({
      refused: [{ row: 1, code: 'import.hash_parameters_too_weak' }],
      counts: { created: 1, refused: 1 },
    })
  })

  test('the real rate limit: the 21st call is told to wait, waits, and the import finishes', async () => {
    const total = USER_IMPORT_RATE_LIMIT + 5
    await put(
      'many.json',
      JSON.stringify(
        Array.from({ length: total }, (_, index) => ({
          id: `u${index}`,
          email: `u${index}@example.test`,
        }))
      )
    )
    const run = await tula([
      'import',
      '--from',
      'supabase',
      'many.json',
      '--yes',
      '--batch-size',
      '1',
    ])
    expect(run.code).toBe(0)
    expect(run.sleeps.length).toBeGreaterThanOrEqual(1)
    expect(run.sleeps[0]).toBeGreaterThan(0)
    expect(run.sleeps[0]).toBeLessThanOrEqual(120_000)
    expect(run.stderr).toContain('The rate limit was reached; waiting')
    expect(await users()).toHaveLength(total)
  })

  test('an interrupted import continues from the progress file and sends only what is left', async () => {
    await put(
      'many.json',
      JSON.stringify(
        Array.from({ length: 6 }, (_, index) => ({
          id: `u${index}`,
          email: `u${index}@example.test`,
        }))
      )
    )
    const down = (method: string, path: string, call: number) =>
      method === 'POST' && path === '/v1/admin/users/import' && call > 2
        ? Response.json(
            { status: 503, code: 'service.unavailable', detail: 'down' },
            { status: 503 }
          )
        : undefined
    const first = await tula(
      ['import', '--from', 'supabase', 'many.json', '--yes', '--batch-size', '2'],
      {
        intercept: down,
      }
    )
    expect(first.code).toBe(1)
    expect(await users()).toHaveLength(4)
    expect(await progress('many.json')).toMatchObject({ doneThrough: 4, batches: 2 })
    const second = await tula([
      'import',
      '--from',
      'supabase',
      'many.json',
      '--yes',
      '--batch-size',
      '2',
    ])
    expect(second.code).toBe(0)
    expect(second.requests).toEqual(['POST /v1/admin/users/import'])
    expect(await users()).toHaveLength(6)
    expect(second.stdout).toContain('Users created:            6')
  })

  test('a lost answer after the server committed the batch: the retry counts those users as created', async () => {
    await put(
      'many.json',
      JSON.stringify([
        { id: 'u0', email: 'u0@example.test' },
        { id: 'u1', email: 'u1@example.test' },
        { id: 'u2', email: 'u2@example.test' },
      ])
    )
    const run = await tula(['import', '--from', 'supabase', 'many.json', '--yes'], {
      lose: (method, path, call) =>
        method === 'POST' && path === '/v1/admin/users/import' && call === 1,
    })
    expect(run.code).toBe(0)
    expect(
      run.requests.filter((request) => request === 'POST /v1/admin/users/import')
    ).toHaveLength(2)
    expect(run.stderr).toContain('The server did not answer (no response)')
    expect(run.stdout).toContain('Users created:            3')
    expect(run.stdout).toContain('Users skipped:            0')
    expect(await progress('many.json')).toMatchObject({ counts: { created: 3, skipped: 0 } })
    expect(await users()).toHaveLength(3)
  })

  test('Clerk after a lost answer: members are paired by the recorded ids, not by address', async () => {
    deps.environmentSettings.seed(TEST_TENANT.environmentId, {
      revision: 1,
      settings: {
        ...DEFAULT_ENVIRONMENT_SETTINGS,
        organizations: { ...DEFAULT_ENVIRONMENT_SETTINGS.organizations, enabled: true },
      },
    })
    await put('users.csv', fixture('clerk-users.csv'))
    await put('orgs.json', fixture('clerk-organizations.json'))
    await put('members.json', fixture('clerk-memberships.json'))
    const run = await tula(
      [
        'import',
        '--from',
        'clerk',
        'users.csv',
        '--yes',
        '--organizations',
        'orgs.json',
        '--memberships',
        'members.json',
      ],
      {
        lose: (method, path, call) =>
          method === 'POST' && path === '/v1/admin/users/import' && call === 1,
      }
    )
    // The file repeats one address: that row is skipped by the server, the other three are new.
    expect(run.stdout).toContain('Users created:            3')
    expect(run.stdout).toContain('Users skipped:            1')
    expect(run.stdout).toContain('Memberships:              3 added, 0 already members, 1 failed')
    expect(run.requests.filter((request) => request.startsWith('GET /v1/admin/users'))).toEqual([])
  })

  test('Clerk: users, organizations and memberships through the admin routes', async () => {
    deps.environmentSettings.seed(TEST_TENANT.environmentId, {
      revision: 1,
      settings: {
        ...DEFAULT_ENVIRONMENT_SETTINGS,
        organizations: { ...DEFAULT_ENVIRONMENT_SETTINGS.organizations, enabled: true },
      },
    })
    await put('users.csv', fixture('clerk-users.csv'))
    await put('orgs.json', fixture('clerk-organizations.json'))
    await put('members.json', fixture('clerk-memberships.json'))
    const args = [
      'import',
      '--from',
      'clerk',
      'users.csv',
      '--yes',
      '--organizations',
      'orgs.json',
      '--memberships',
      'members.json',
    ]
    const run = await tula(args)
    expect(run.stdout).toContain('Organizations:            2 created, 0 already there, 0 failed')
    expect(run.stdout).toContain('Memberships:              3 added, 0 already members, 1 failed')
    const orgs = (await (await admin('/v1/admin/organizations')).json()) as {
      data: { id: string; slug: string }[]
    }
    expect(orgs.data.map((org) => org.slug).sort()).toEqual(['northline-labs', 'okafor-sons'])
    const labs = orgs.data.find((org) => org.slug === 'northline-labs')
    const members = (await (
      await admin(`/v1/admin/organizations/${labs?.id}/memberships`)
    ).json()) as {
      data: { role: string }[]
    }
    expect(members.data.map((member) => member.role).sort()).toEqual(['admin', 'member'])
    expect((await signIn('maya@northline.app', 'correct-horse-1')).tokens).toBeDefined()
    // From scratch: users are skipped, organizations are found by slug, members already are.
    const again = await tula([...args, '--fresh'])
    expect(again.stdout).toContain('Users created:            0')
    expect(again.stdout).toContain('Organizations:            0 created, 2 already there, 0 failed')
    expect(again.stdout).toContain('Memberships:              0 added, 3 already members, 1 failed')
  })

  test('Clerk with organizations switched off: the users are kept and the message says what to do', async () => {
    await put('users.csv', fixture('clerk-users.csv'))
    await put('orgs.json', fixture('clerk-organizations.json'))
    const run = await tula([
      'import',
      '--from',
      'clerk',
      'users.csv',
      '--yes',
      '--organizations',
      'orgs.json',
    ])
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('Organizations are switched off in this environment')
    expect(await users()).toHaveLength(3)
  })

  test('nothing any run printed, and no file it wrote, holds a hash, a signer key or a whole address', async () => {
    expect(progressFiles.length).toBeGreaterThan(5)
    for (const text of progressFiles) {
      expect(text).not.toMatch(/@/)
      expect(text).not.toMatch(/\$2[aby]\$|\$argon2/)
    }
    for (const text of printed) {
      expect(text).not.toContain(SECRET_KEY)
      expect(text).not.toMatch(/\$2[aby]\$|\$argon2/)
      expect(text).not.toContain('jxspr8Ki0RYycVU8')
      expect(text).not.toMatch(/[a-z0-9._-]+@(northline\.app|example\.test)/i)
    }
  })
})
