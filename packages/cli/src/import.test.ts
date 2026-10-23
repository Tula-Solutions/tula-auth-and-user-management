import { describe, expect, test } from 'bun:test'
import type { AdminFetch } from '@tula-tech/admin'
import type { Host } from './host'
import { type CliIo, COMMANDS, runCli } from './index'
import { fixture } from './testing/import-fixtures'

const KEY = 'tula_sk_dev_importtest00000000000000000000000'
const OTHER_KEY = 'tula_sk_dev_othertestkey00000000000000000000'
const URL_BASE = 'http://localhost:3003'
const SIGNER =
  'jxspr8Ki0RYycVU8zykbdLGjFQ3McFUH0uiiTvC8pVMXAn210wjLNmdZJzxUECKbm0QsEmYUSDzZvpjeJ9WmXA=='
const PROGRESS = '/work/users.csv.tula-import-progress.json'

/** Files kept in memory, the way the CLI's host reads and writes them. */
function memoryHost(files: Record<string, string>) {
  const sleeps: number[] = []
  const host = {
    readFile: async (path: string) => (Object.hasOwn(files, path) ? (files[path] as string) : null),
    writeSecretFile: async (path: string, text: string) => {
      files[path] = text
    },
    sleep: async (ms: number) => {
      sleeps.push(ms)
    },
  }
  return { host: host as unknown as Host, files, sleeps }
}

interface Request {
  method: string
  path: string
  body: unknown
}

interface Behaviour {
  /** Called for each import call (1-based); a Response replaces the answer. */
  importAnswer?: (call: number) => Response | undefined
  /** Refuse the row of this address with this code. */
  refuse?: Record<string, string>
  /** Answer for the organization routes. */
  organizations?: 'disabled' | 'on'
  /** Slugs that exist already. */
  existingSlugs?: Map<string, string>
  /** Users the lookup finds, by address. */
  users?: Map<string, string>
  /** Roles that do not exist. */
  unknownRoles?: string[]
  /** Pairs `org:user` that are members already. */
  members?: Set<string>
}

/** The users of a run's first import request. */
function sentUsers(run: { api: { imports: () => { body: unknown }[] } }): unknown[] {
  return ((run.api.imports()[0]?.body ?? { users: [] }) as { users: unknown[] }).users
}

function problem(status: number, code: string, detail = 'x', headers: Record<string, string> = {}) {
  return Response.json({ status, code, detail }, { status, headers })
}

/** A stand-in for the admin routes `tula import` calls, with the server's idempotence rules. */
function fakeApi(behaviour: Behaviour = {}) {
  const requests: Request[] = []
  const seen = new Map<string, string>()
  const externalIds = new Map<string, string>()
  let importCalls = 0
  let counter = 0
  const orgs = new Map<string, string>(behaviour.existingSlugs ?? [])
  const fetch: AdminFetch = async (input, init) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ method, path: `${url.pathname}${url.search}`, body })
    if (method === 'POST' && url.pathname === '/v1/admin/users/import') {
      importCalls += 1
      const replaced = behaviour.importAnswer?.(importCalls)
      if (replaced) {
        return replaced
      }
      const inBatch = new Set<string>()
      const results = (body.users as { email: string; externalId?: string }[]).map(
        (user, index) => {
          const key = user.email.toLowerCase()
          const code = behaviour.refuse?.[key]
          if (code) {
            return {
              index,
              status: 'refused',
              code,
              message: 'SERVER TEXT WITH maya@northline.app',
            }
          }
          if (inBatch.has(key)) {
            return { index, status: 'skipped', reason: 'repeated_in_batch' }
          }
          inBatch.add(key)
          if (seen.has(key)) {
            // As the server: the existing user's id, and whether the external id is the row's.
            return {
              index,
              status: 'skipped',
              reason: 'email_exists',
              id: seen.get(key),
              sameExternalId:
                user.externalId !== undefined && externalIds.get(key) === user.externalId,
            }
          }
          counter += 1
          const id = `00000000-0000-7000-8000-${String(counter).padStart(12, '0')}`
          seen.set(key, id)
          if (user.externalId !== undefined) {
            externalIds.set(key, user.externalId)
          }
          return { index, status: 'created', id }
        }
      )
      const count = (status: string) => results.filter((result) => result.status === status).length
      return Response.json({
        results,
        created: count('created'),
        skipped: count('skipped'),
        refused: count('refused'),
      })
    }
    if (url.pathname === '/v1/admin/users' && method === 'GET') {
      const q = url.searchParams.get('q') ?? ''
      const id = behaviour.users?.get(q.toLowerCase()) ?? seen.get(q.toLowerCase())
      return Response.json({
        meta: { totalCount: 1, totalPages: 1, page: 1, perPage: 20 },
        data: id ? [{ id, email: q }] : [],
      })
    }
    if (url.pathname === '/v1/admin/organizations' && method === 'POST') {
      if (behaviour.organizations === 'disabled') {
        return problem(403, 'organization.disabled')
      }
      if (orgs.has(body.slug)) {
        return problem(409, 'organization.slug_taken')
      }
      const id = `org-${orgs.size + 1}`
      orgs.set(body.slug, id)
      return Response.json({ id, name: body.name, slug: body.slug })
    }
    if (url.pathname === '/v1/admin/organizations' && method === 'GET') {
      return Response.json({
        meta: { totalCount: orgs.size, totalPages: 1, page: 1, perPage: 100 },
        data: [...orgs].map(([slug, id]) => ({ id, slug, name: slug })),
      })
    }
    const member = /^\/v1\/admin\/organizations\/([^/]+)\/memberships$/.exec(url.pathname)
    if (member && method === 'POST') {
      if (behaviour.unknownRoles?.includes(body.role)) {
        return problem(422, 'organization.role_unknown')
      }
      if (behaviour.members?.has(`${member[1]}:${body.userId}`)) {
        return problem(409, 'organization.member_exists')
      }
      return Response.json({
        id: 'm',
        organizationId: member[1],
        userId: body.userId,
        role: body.role,
      })
    }
    return problem(404, 'not_found')
  }
  return {
    fetch,
    requests,
    imports: () => requests.filter((r) => r.path === '/v1/admin/users/import'),
  }
}

interface Run {
  code: number
  stdout: string
  stderr: string
  all: string
}

async function tula(
  args: string[],
  files: Record<string, string>,
  api = fakeApi(),
  io: Partial<CliIo> = {}
): Promise<
  Run & { api: ReturnType<typeof fakeApi>; sleeps: number[]; files: Record<string, string> }
> {
  const memory = memoryHost(files)
  let stdout = ''
  let stderr = ''
  const code = await runCli(
    args,
    {
      stdout: { write: (text) => (stdout += text) },
      stderr: { write: (text) => (stderr += text) },
      env: { TULA_API_URL: URL_BASE, TULA_SECRET_KEY: KEY },
      cwd: '/work',
      isTTY: false,
      stdinIsTTY: false,
      fetch: api.fetch,
      host: memory.host,
      ...io,
    },
    COMMANDS
  )
  return {
    code,
    stdout,
    stderr,
    all: stdout + stderr,
    api,
    sleeps: memory.sleeps,
    files: memory.files,
  }
}

/** Things that must never appear in any output or in the progress file. */
const FORBIDDEN = [
  'maya@northline.app',
  'jon@northline.app',
  'priya@northline.app',
  'northline.app',
  '$2a$10$',
  '$2b$10$',
  '$argon2id$',
  '9b8ff7c2a1d44e0f8c3b5a6d7e8f9012',
  SIGNER,
  'lSrfV15cpx95',
  '42xEC',
  KEY,
]

/** The text of the progress file a run left, whatever the export was called. */
function progressOf(run: { files: Record<string, string> }): string {
  const name = Object.keys(run.files).find((key) => key.endsWith('.tula-import-progress.json'))
  return name === undefined ? 'MISSING' : (run.files[name] as string)
}

function expectClean(text: string): void {
  for (const secret of FORBIDDEN) {
    expect(text).not.toContain(secret)
  }
}

const SUPABASE = { '/work/users.csv': fixture('supabase-users.csv') }

describe('tula import: the dry run', () => {
  test('prints counts and every refused row with its number, code and a masked address, and sends nothing', async () => {
    const run = await tula(
      ['import', '--from', 'supabase', 'users.csv'],
      { ...SUPABASE },
      fakeApi(),
      {
        env: {},
      }
    )
    // No key and no API URL were needed: nothing was sent.
    expect(run.api.requests).toEqual([])
    expect(run.code).toBe(2)
    expect(run.stdout).toContain('Dry run: supabase export. Nothing was sent.')
    expect(run.stdout).toContain('Users in the file:        7')
    expect(run.stdout).toContain('would be imported:      3')
    expect(run.stdout).toContain('with bcrypt password: 2')
    expect(run.stdout).toContain('without a password:   1')
    expect(run.stdout).toContain('Refused (4):')
    expect(run.stdout).toMatch(/user 4 {2}source\.user_deleted {2}g\*\*\*@\*\*\*\.app/)
    expect(run.stdout).toMatch(/user 5 {2}source\.user_disabled {2}b\*\*\*@\*\*\*\.app/)
    expect(run.stdout).toMatch(/user 6 {2}email\.invalid {2}\(no address\)/)
    expect(run.stdout).toMatch(/user 7 {2}import\.unsupported_algorithm {2}o\*\*\*@\*\*\*\.app/)
    expect(run.stdout).toContain('Run the same command with --yes to import.')
    expect(run.stderr).toBe('')
    expectClean(run.all)
    expect(Object.keys(run.files)).toEqual(['/work/users.csv'])
  })

  test('a clean file exits 0, and --json prints a report with row numbers and masked addresses', async () => {
    const clean = await tula(['import', '--from', 'supabase', 'users.csv'], {
      '/work/users.csv': fixture('supabase-users.json'),
    })
    expect(clean.code).toBe(0)
    const json = await tula(['import', '--from', 'supabase', 'users.csv', '--json'], {
      ...SUPABASE,
    })
    const report = JSON.parse(json.stdout)
    expect(report).toMatchObject({
      provider: 'supabase',
      dryRun: true,
      users: { total: 7, ready: 3, withoutPassword: 1, algorithms: { bcrypt: 2 } },
    })
    expect(report.refused[0]).toMatchObject({ kind: 'user', row: 4, code: 'source.user_deleted' })
    expectClean(json.stdout)
  })

  test('notes, repeated addresses and an unreadable organizations file are reported', async () => {
    const run = await tula(
      [
        'import',
        '--from',
        'clerk',
        'users.csv',
        '--organizations',
        'orgs.json',
        '--memberships',
        'm.json',
      ],
      {
        '/work/users.csv': fixture('clerk-users.csv'),
        '/work/orgs.json': fixture('clerk-organizations.json'),
        '/work/m.json': fixture('clerk-memberships.json'),
      }
    )
    expect(run.stdout).toContain('repeating an address: 1')
    expect(run.stdout).toContain('Organizations:            3')
    expect(run.stdout).toContain('Memberships:              5')
    expect(run.stdout).toContain('Note: 1 user(s) had an authenticator app at Clerk.')
    expect(run.stdout).toContain('organization 3  source.organization_invalid')
    expect(run.stdout).toContain('membership 5  source.membership_invalid')
    expectClean(run.all)
  })

  test('Firebase: the hash parameters are used, and no output holds the signer key, a hash or an address', async () => {
    const run = await tula(
      ['import', '--from', 'firebase', 'fb.json', '--firebase-hash-config', 'cfg.json'],
      {
        '/work/fb.json': fixture('firebase-users.json'),
        '/work/cfg.json': fixture('firebase-hash-config.json'),
      }
    )
    expect(run.stdout).toContain('with firebase_scrypt password: 1')
    expect(run.stdout).toContain('user 2  import.hash_malformed')
    expectClean(run.all)
  })
})

describe('tula import --yes', () => {
  test('imports, writes a progress file with ids and counts only, and prints no secret', async () => {
    const run = await tula(['import', '--from', 'supabase', 'users.csv', '--yes'], { ...SUPABASE })
    expect(run.code).toBe(2)
    expect(run.api.imports()).toHaveLength(1)
    const sent = sentUsers(run) as { email: string; password?: { hash: string } }[]
    expect(sent.map((user) => user.email)).toEqual([
      'maya@northline.app',
      'jon@northline.app',
      'priya@northline.app',
    ])
    expect(sent[0]?.password?.hash).toStartWith('$2a$10$')
    expect(run.stdout).toContain('Users created:            3')
    expect(run.stdout).toContain('Users refused:            4')
    expect(run.stdout).toContain('Done, with 4 refused items.')
    const progress = JSON.parse(progressOf(run))
    expect(progress).toMatchObject({
      version: 1,
      provider: 'supabase',
      doneThrough: 3,
      batches: 1,
      counts: { created: 3, skipped: 0, refused: 0 },
      refused: [],
      userIds: {},
    })
    expect(progress.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(progress.target).toMatch(/^[0-9a-f]{16}$/)
    expectClean(run.all)
    expectClean(progressOf(run))
  })

  test('a server refusal is kept by row and code, shown in its own words with a masked address', async () => {
    const api = fakeApi({ refuse: { 'jon@northline.app': 'import.hash_parameters_too_weak' } })
    const run = await tula(
      ['import', '--from', 'supabase', 'users.csv', '--yes'],
      { ...SUPABASE },
      api
    )
    expect(run.stdout).toMatch(/user 2 {2}import\.hash_parameters_too_weak {2}j\*\*\*@\*\*\*\.app/)
    expect(run.stdout).toContain('below the server’s minimum')
    // The server's own message, which here quotes an address, is never printed or kept.
    expect(run.all).not.toContain('SERVER TEXT')
    expect(JSON.parse(progressOf(run)).refused).toEqual([
      { row: 2, code: 'import.hash_parameters_too_weak' },
    ])
    expectClean(run.all)
    expectClean(progressOf(run))
  })

  test('a code the server invents is kept as "unknown" rather than written to the file', async () => {
    const api = fakeApi({ refuse: { 'jon@northline.app': 'Evil Code!' } })
    const run = await tula(
      ['import', '--from', 'supabase', 'users.csv', '--yes'],
      { ...SUPABASE },
      api
    )
    expect(JSON.parse(progressOf(run)).refused).toEqual([{ row: 2, code: 'unknown' }])
  })

  test('running again over a finished import sends nothing; --fresh sends all and the server skips them', async () => {
    const files = { ...SUPABASE }
    const first = await tula(['import', '--from', 'supabase', 'users.csv', '--yes'], files)
    const second = await tula(
      ['import', '--from', 'supabase', 'users.csv', '--yes'],
      first.files,
      fakeApi()
    )
    expect(second.api.requests).toEqual([])
    expect(second.stdout).toContain('Users created:            3')
    const api = fakeApi()
    await api.fetch(`${URL_BASE}/v1/admin/users/import`, {
      method: 'POST',
      body: JSON.stringify({ users: [{ email: 'maya@northline.app' }] }),
    })
    const fresh = await tula(
      ['import', '--from', 'supabase', 'users.csv', '--yes', '--fresh'],
      first.files,
      api
    )
    expect(fresh.stdout).toContain('Users created:            2')
    expect(fresh.stdout).toContain('Users skipped:            1')
  })

  test('a custom progress file name is used', async () => {
    const run = await tula(
      ['import', '--from', 'supabase', 'users.csv', '--yes', '--progress-file', 'p.json'],
      { ...SUPABASE }
    )
    expect(Object.keys(run.files).sort()).toEqual(['/work/p.json', '/work/users.csv'])
  })

  test('--json after an import prints the result with no secret', async () => {
    const run = await tula(['import', '--from', 'supabase', 'users.csv', '--yes', '--json'], {
      ...SUPABASE,
    })
    const report = JSON.parse(run.stdout)
    expect(report.dryRun).toBe(false)
    expect(report.result).toMatchObject({ created: 3, skipped: 0, refusedByServer: 0 })
    expectClean(run.all)
  })

  test('without a key nothing is sent, and the message says what to set', async () => {
    const run = await tula(
      ['import', '--from', 'supabase', 'users.csv', '--yes'],
      { ...SUPABASE },
      fakeApi(),
      {
        env: { TULA_API_URL: URL_BASE },
      }
    )
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('No secret key')
    expect(run.api.requests).toEqual([])
  })
})

function bigSupabase(count: number, extra = ''): string {
  const users = Array.from({ length: count }, (_, i) => ({
    id: `id-${i}`,
    email: `user${i}@example.test`,
    encrypted_password: '$2a$10$NDhuqUZcBQ/LFla5qSAXXezYn7yAR/RITInkyddwtdh1ANBpFw7hS',
    email_confirmed_at: '2024-01-01T00:00:00Z',
    raw_user_meta_data: extra === '' ? {} : { blob: extra },
  }))
  return JSON.stringify(users)
}

describe('batches', () => {
  test('1,200 users go in batches of 500, 500 and 200, in order', async () => {
    const run = await tula(['import', '--from', 'supabase', 'users.json', '--yes'], {
      '/work/users.json': bigSupabase(1200),
    })
    const sizes = run.api
      .imports()
      .map((request) => (request.body as { users: unknown[] }).users.length)
    expect(sizes).toEqual([500, 500, 200])
    expect(run.code).toBe(0)
    expect(JSON.parse(progressOf(run))).toMatchObject({
      doneThrough: 1200,
      batches: 3,
      counts: { created: 1200 },
    })
    expect(run.stderr).toContain('Imported 1200 of 1200 users (batch 3).')
  })

  test('--batch-size is honoured, and above 500 is refused', async () => {
    const run = await tula(
      ['import', '--from', 'supabase', 'users.json', '--yes', '--batch-size', '100'],
      {
        '/work/users.json': bigSupabase(250),
      }
    )
    expect(run.api.imports()).toHaveLength(3)
    const bad = await tula(['import', '--from', 'supabase', 'users.json', '--batch-size', '501'], {
      '/work/users.json': bigSupabase(1),
    })
    expect(bad.code).toBe(1)
    expect(bad.stderr).toContain('--batch-size takes a whole number from 1 to 500')
  })

  test('a server that answers with the wrong number of results stops the run', async () => {
    const api = fakeApi({
      importAnswer: () => Response.json({ results: [], created: 0, skipped: 0, refused: 0 }),
    })
    const run = await tula(
      ['import', '--from', 'supabase', 'users.csv', '--yes'],
      { ...SUPABASE },
      api
    )
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('different number of results')
    expect(progressOf(run)).toBe('MISSING')
  })
})

describe('the rate limit and failures', () => {
  test('a 429 waits for Retry-After and tries the same batch again', async () => {
    const api = fakeApi({
      importAnswer: (call) =>
        call === 1 ? problem(429, 'rate_limited', 'slow down', { 'Retry-After': '3' }) : undefined,
    })
    const run = await tula(
      ['import', '--from', 'supabase', 'users.csv', '--yes'],
      { ...SUPABASE },
      api
    )
    expect(run.sleeps).toEqual([3000])
    expect(api.imports()).toHaveLength(2)
    expect(run.stderr).toContain('The rate limit was reached; waiting 3s before importing.')
    expect(run.stdout).toContain('Users created:            3')
  })

  test('a Retry-After longer than the cap is waited only as long as the cap', async () => {
    const answer = (call: number) =>
      call === 1 ? problem(429, 'rate_limited', 'slow', { 'Retry-After': '9999' }) : undefined
    const byDefault = await tula(
      ['import', '--from', 'supabase', 'users.csv', '--yes'],
      { ...SUPABASE },
      fakeApi({ importAnswer: answer })
    )
    expect(byDefault.sleeps).toEqual([120_000])
    const capped = await tula(
      ['import', '--from', 'supabase', 'users.csv', '--yes', '--max-wait', '5'],
      { ...SUPABASE },
      fakeApi({ importAnswer: answer })
    )
    expect(capped.sleeps).toEqual([5000])
  })

  test('a 429 with no Retry-After waits a short backoff', async () => {
    const api = fakeApi({
      importAnswer: (call) => (call === 1 ? problem(429, 'rate_limited') : undefined),
    })
    const run = await tula(
      ['import', '--from', 'supabase', 'users.csv', '--yes'],
      { ...SUPABASE },
      api
    )
    expect(run.sleeps).toEqual([2000])
  })

  test('a server that stays down stops the run with the progress kept; the next run continues after it', async () => {
    let down = true
    const api = fakeApi({
      importAnswer: (call) => (down && call > 1 ? problem(503, 'internal') : undefined),
    })
    const files = { '/work/users.json': bigSupabase(5) }
    const first = await tula(
      ['import', '--from', 'supabase', 'users.json', '--yes', '--batch-size', '2'],
      files,
      api
    )
    expect(first.code).toBe(1)
    expect(first.sleeps).toEqual([2000, 4000, 6000, 8000, 10_000])
    expect(first.stderr).toContain(
      'Stopped. The progress file keeps what was done (2 users answered)'
    )
    expect(JSON.parse(progressOf(first))).toMatchObject({
      doneThrough: 2,
      batches: 1,
    })
    down = false
    const before = api.imports().length
    const second = await tula(
      ['import', '--from', 'supabase', 'users.json', '--yes', '--batch-size', '2'],
      first.files,
      api
    )
    expect(second.stderr).toContain('Continuing from the progress file (after user row 2).')
    const resent = api
      .imports()
      .slice(before)
      .flatMap((r) => (r.body as { users: { email: string }[] }).users)
    expect(resent.map((user) => user.email)).toEqual([
      'user2@example.test',
      'user3@example.test',
      'user4@example.test',
    ])
    expect(second.code).toBe(0)
    expect(second.stdout).toContain('Users created:            5')
  })

  test('no answer at all is retried like a 5xx', async () => {
    let calls = 0
    const api = fakeApi()
    const flaky: AdminFetch = async (url, init) => {
      calls += 1
      if (calls === 1) {
        throw new Error('connect ECONNREFUSED')
      }
      return api.fetch(url, init)
    }
    const run = await tula(
      ['import', '--from', 'supabase', 'users.csv', '--yes'],
      { ...SUPABASE },
      api,
      {
        fetch: flaky,
      }
    )
    expect(run.code).toBe(2)
    expect(run.sleeps).toEqual([2000])
    expect(run.stderr).toContain('The server did not answer (no response)')
  })

  describe('a batch whose answer was lost after the server committed it (TULA-126)', () => {
    /** A fetch that lets the server do the import and then loses the answer, on these calls. */
    function losing(api: ReturnType<typeof fakeApi>, lost: number[]): AdminFetch {
      let imports = 0
      return async (url, init) => {
        const answer = await api.fetch(url, init)
        if (init?.method === 'POST' && String(url).endsWith('/v1/admin/users/import')) {
          imports += 1
          if (lost.includes(imports)) {
            throw new Error('socket hang up')
          }
        }
        return answer
      }
    }

    test('the users the first attempt made are counted as created, not skipped', async () => {
      const api = fakeApi()
      const run = await tula(
        ['import', '--from', 'supabase', 'users.csv', '--yes'],
        { ...SUPABASE },
        api,
        { fetch: losing(api, [1]) }
      )
      expect(run.api.imports()).toHaveLength(2)
      expect(run.stdout).toContain('Users created:            3')
      expect(run.stdout).toContain('Users skipped:            0')
      expect(JSON.parse(progressOf(run)).counts).toMatchObject({ created: 3, skipped: 0 })
    })

    test('a user who was there before stays skipped in the same retried batch', async () => {
      const api = fakeApi()
      const first = await tula(
        ['import', '--from', 'supabase', 'users.csv', '--yes'],
        { ...SUPABASE },
        api
      )
      expect(first.stdout).toContain('Users created:            3')
      // Another export of the same people with other source ids: the addresses exist, the
      // external ids differ, so a retried batch must not call them its own work.
      const other = SUPABASE['/work/users.csv'].replace(/^([0-9a-f-]{36}),/gm, 'x$1,')
      const run = await tula(
        ['import', '--from', 'supabase', 'again.csv', '--yes'],
        { '/work/again.csv': other },
        api,
        { fetch: losing(api, [1]) }
      )
      expect(run.api.imports().length).toBeGreaterThanOrEqual(3)
      expect(run.stdout).toContain('Users created:            0')
    })

    test('a duplicate answered without a retry is skipped even with the same external id', async () => {
      const first = await tula(['import', '--from', 'supabase', 'users.csv', '--yes'], {
        ...SUPABASE,
      })
      const second = await tula(
        ['import', '--from', 'supabase', 'users.csv', '--yes', '--fresh'],
        first.files,
        first.api
      )
      expect(second.stdout).toContain('Users created:            0')
      expect(second.stdout).toContain('Users skipped:            3')
    })

    test('Clerk members are paired by the recorded ids, with no lookup by address', async () => {
      const api = fakeApi()
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
          'm.json',
        ],
        {
          '/work/users.csv': fixture('clerk-users.csv'),
          '/work/orgs.json': fixture('clerk-organizations.json'),
          '/work/m.json': fixture('clerk-memberships.json'),
        },
        api,
        { fetch: losing(api, [1]) }
      )
      expect(run.stdout).toContain('Users created:            3')
      expect(run.stdout).toContain('Memberships:              3 added')
      expect(run.api.requests.filter((r) => r.path.startsWith('/v1/admin/users?'))).toEqual([])
      expect(Object.keys(JSON.parse(progressOf(run)).userIds).sort()).toEqual([
        'user_2aaa',
        'user_2bbb',
        'user_2ccc',
      ])
    })

    test('an older server that sends no id keeps the old behaviour: skipped, found by address', async () => {
      const api = fakeApi()
      const lossy = losing(api, [1])
      const old: AdminFetch = async (url, init) => {
        const answer = await lossy(url, init)
        if (!String(url).endsWith('/v1/admin/users/import')) {
          return answer
        }
        const body = (await answer.json()) as {
          results: { id?: string; sameExternalId?: boolean }[]
        }
        for (const entry of body.results) {
          if (entry.sameExternalId !== undefined) {
            delete entry.id
            delete entry.sameExternalId
          }
        }
        return Response.json(body)
      }
      const run = await tula(
        ['import', '--from', 'supabase', 'users.csv', '--yes'],
        { ...SUPABASE },
        api,
        { fetch: old }
      )
      expect(run.stdout).toContain('Users skipped:            3')
    })
  })

  test('a refusal that is not worth retrying (a wrong key) stops at once', async () => {
    const api = fakeApi({ importAnswer: () => problem(401, 'auth.unauthenticated') })
    const run = await tula(
      ['import', '--from', 'supabase', 'users.csv', '--yes'],
      { ...SUPABASE },
      api
    )
    expect(run.code).toBe(1)
    expect(run.sleeps).toEqual([])
    expect(api.imports()).toHaveLength(1)
    expect(run.stderr).toContain('Stopped.')
  })

  test('an error that quotes the key is redacted', async () => {
    const api = fakeApi({ importAnswer: () => problem(400, 'validation.failed', `bad key ${KEY}`) })
    const run = await tula(
      ['import', '--from', 'supabase', 'users.csv', '--yes'],
      { ...SUPABASE },
      api
    )
    expect(run.all).not.toContain(KEY)
    expect(run.all).toContain('[redacted]')
  })
})

describe('the progress file is bound to its export and its API', () => {
  test('another export, another key, a corrupt file and --fresh', async () => {
    const first = await tula(['import', '--from', 'supabase', 'users.csv', '--yes'], {
      ...SUPABASE,
    })
    const otherExport = await tula(['import', '--from', 'supabase', 'users.csv', '--yes'], {
      ...first.files,
      '/work/users.csv': `${fixture('supabase-users.csv')}\n`,
    })
    expect(otherExport.code).toBe(1)
    expect(otherExport.stderr).toContain('belongs to a different export')
    expect(otherExport.api.requests).toEqual([])
    const otherProvider = await tula(
      ['import', '--from', 'clerk', 'users.csv', '--yes'],
      first.files
    )
    expect(otherProvider.stderr).toContain('belongs to a different export')
    const otherKey = await tula(
      ['import', '--from', 'supabase', 'users.csv', '--yes'],
      first.files,
      fakeApi(),
      {
        env: { TULA_API_URL: URL_BASE, TULA_SECRET_KEY: OTHER_KEY },
      }
    )
    expect(otherKey.stderr).toContain('different API or secret key')
    expect(otherKey.api.requests).toEqual([])
    const corrupt = await tula(['import', '--from', 'supabase', 'users.csv', '--yes'], {
      ...SUPABASE,
      [PROGRESS]: '{"version":1,"hash":"$2b$10$secretsecretsecret"}',
    })
    expect(corrupt.code).toBe(1)
    expect(corrupt.stderr).toContain('not one this version of `tula import` wrote')
    expect(corrupt.all).not.toContain('secretsecret')
    expect(corrupt.api.requests).toEqual([])
    const fresh = await tula(['import', '--from', 'supabase', 'users.csv', '--yes', '--fresh'], {
      ...SUPABASE,
      [PROGRESS]: 'garbage',
    })
    expect(fresh.code).toBe(2)
    expect(fresh.api.imports()).toHaveLength(1)
    expect(JSON.parse(progressOf(fresh)).version).toBe(1)
  })
})

describe('a resume is only of the same import', () => {
  test('--allow-passwordless after a run without it is another import, not a resume that skips rows', async () => {
    const first = await tula(['import', '--from', 'supabase', 'users.csv', '--yes'], {
      ...SUPABASE,
    })
    const again = await tula(
      ['import', '--from', 'supabase', 'users.csv', '--yes', '--allow-passwordless'],
      first.files
    )
    expect(again.code).toBe(1)
    expect(again.stderr).toContain('belongs to a different export')
    expect(again.api.requests).toEqual([])
    const fresh = await tula(
      ['import', '--from', 'supabase', 'users.csv', '--yes', '--allow-passwordless', '--fresh'],
      first.files
    )
    expect(sentUsers(fresh)).toHaveLength(4)
  })

  test('other Firebase parameters are another import too', async () => {
    const args = ['import', '--from', 'firebase', 'fb.json', '--yes']
    const files = { '/work/fb.json': fixture('firebase-users.json') }
    const env = (rounds: string) => ({
      env: { TULA_API_URL: URL_BASE, TULA_SECRET_KEY: KEY, TULA_FIREBASE_SIGNER_KEY: SIGNER },
      args: ['--firebase-rounds', rounds, '--firebase-mem-cost', '14'],
    })
    const first = await tula([...args, ...env('8').args], files, fakeApi(), { env: env('8').env })
    const second = await tula([...args, ...env('9').args], first.files, fakeApi(), {
      env: env('9').env,
    })
    expect(second.stderr).toContain('belongs to a different export')
  })
})

describe('Firebase parameters', () => {
  const files = () => ({ '/work/fb.json': fixture('firebase-users.json') })

  test('the parameters go once with the batch that needs them, and nowhere else', async () => {
    const run = await tula(
      ['import', '--from', 'firebase', 'fb.json', '--yes', '--firebase-hash-config', 'cfg.txt'],
      { ...files(), '/work/cfg.txt': fixture('firebase-hash-config.txt') }
    )
    const body = run.api.imports()[0]?.body as {
      firebaseScrypt: unknown
      users: { password?: unknown }[]
    }
    expect(body.firebaseScrypt).toEqual({
      signerKey: SIGNER,
      saltSeparator: 'Bw==',
      rounds: 8,
      memCost: 14,
    })
    expect(body.users).toHaveLength(2)
    expectClean(run.all)
    expectClean(progressOf(run))
  })

  test('the signer key may come from the environment, and the numbers from flags', async () => {
    const run = await tula(
      [
        'import',
        '--from',
        'firebase',
        'fb.json',
        '--yes',
        '--firebase-rounds',
        '8',
        '--firebase-mem-cost',
        '14',
      ],
      files(),
      fakeApi(),
      {
        env: {
          TULA_API_URL: URL_BASE,
          TULA_SECRET_KEY: KEY,
          TULA_FIREBASE_SIGNER_KEY: SIGNER,
          TULA_FIREBASE_SALT_SEPARATOR: 'Bw==',
        },
      }
    )
    expect(run.api.imports()[0]?.body).toMatchObject({
      firebaseScrypt: { signerKey: SIGNER, rounds: 8 },
    })
    expectClean(run.all)
  })

  test('a URL-safe signer key in the environment is sent in the standard alphabet', async () => {
    const urlSafe = SIGNER.replaceAll('+', '-').replaceAll('/', '_')
    const run = await tula(
      [
        'import',
        '--from',
        'firebase',
        'fb.json',
        '--yes',
        '--firebase-rounds',
        '8',
        '--firebase-mem-cost',
        '14',
      ],
      files(),
      fakeApi(),
      { env: { TULA_API_URL: URL_BASE, TULA_SECRET_KEY: KEY, TULA_FIREBASE_SIGNER_KEY: urlSafe } }
    )
    expect(run.api.imports()[0]?.body).toMatchObject({ firebaseScrypt: { signerKey: SIGNER } })
  })

  test('an error from the server that quotes the signer key is redacted', async () => {
    const api = fakeApi({
      importAnswer: () => problem(400, 'validation.failed', `signer ${SIGNER}`),
    })
    const run = await tula(
      ['import', '--from', 'firebase', 'fb.json', '--yes', '--firebase-hash-config', 'cfg.json'],
      { ...files(), '/work/cfg.json': fixture('firebase-hash-config.json') },
      api
    )
    expect(run.all).not.toContain(SIGNER)
    expect(run.all).toContain('[redacted]')
  })

  test('rounds and mem_cost are needed, a missing hash config is an error up front, and the key is not an option', async () => {
    const noNumbers = await tula(['import', '--from', 'firebase', 'fb.json'], files(), fakeApi(), {
      env: { TULA_FIREBASE_SIGNER_KEY: SIGNER },
    })
    expect(noNumbers.stderr).toContain('rounds and mem_cost are needed')
    expectClean(noNumbers.all)
    const none = await tula(['import', '--from', 'firebase', 'fb.json'], files())
    expect(none.stderr).toContain('--firebase-hash-config')
    const flag = await tula(
      ['import', '--from', 'firebase', 'fb.json', '--signer-key', SIGNER],
      files()
    )
    expect(flag.code).toBe(1)
    expect(flag.all).not.toContain(SIGNER)
    const passwordless = await tula(
      ['import', '--from', 'firebase', 'fb.json', '--allow-passwordless'],
      files()
    )
    expect(passwordless.stdout).toContain('without a password:   3')
  })
})

describe('organizations and memberships (Clerk)', () => {
  const clerk = (extra: Record<string, string> = {}) => ({
    '/work/users.csv': fixture('clerk-users.csv'),
    '/work/orgs.json': fixture('clerk-organizations.json'),
    '/work/m.json': fixture('clerk-memberships.json'),
    ...extra,
  })
  const args = [
    'import',
    '--from',
    'clerk',
    'users.csv',
    '--yes',
    '--organizations',
    'orgs.json',
    '--memberships',
    'm.json',
  ]

  test('users, then organizations, then members, found by id or by address', async () => {
    const run = await tula(args, clerk())
    const writes = run.api.requests.filter(
      (r) => r.method === 'POST' && r.path !== '/v1/admin/users/import'
    )
    expect(writes.map((r) => r.path)).toEqual([
      '/v1/admin/organizations',
      '/v1/admin/organizations',
      '/v1/admin/organizations/org-1/memberships',
      '/v1/admin/organizations/org-1/memberships',
      '/v1/admin/organizations/org-2/memberships',
    ])
    expect(writes[0]?.body).toEqual({ name: 'Northline Labs', slug: 'northline-labs' })
    expect(writes[2]?.body).toMatchObject({ role: 'admin' })
    expect(writes[3]?.body).toMatchObject({ role: 'member' })
    expect(run.stdout).toContain('Organizations:            2 created, 0 already there, 0 failed')
    expect(run.stdout).toContain('Memberships:              3 added, 0 already members, 1 failed')
    expect(run.stdout).toContain('membership 4  source.member_user_missing')
    expect(run.stdout).toContain('organization 3  source.organization_invalid')
    expect(run.code).toBe(2)
    const progress = JSON.parse(progressOf(run))
    expect(Object.keys(progress.userIds).sort()).toEqual(['user_2aaa', 'user_2bbb', 'user_2ccc'])
    expect(progress.organizations).toMatchObject({ cursor: 3, created: 2 })
    expect(progress.memberships).toMatchObject({ cursor: 5, added: 3 })
    expectClean(run.all)
    expectClean(progressOf(run))
  })

  test('a second run over a finished import changes nothing', async () => {
    const first = await tula(args, clerk())
    const second = await tula(args, first.files)
    expect(second.api.requests).toEqual([])
  })

  test('users that already existed are found by address; organizations and members that exist are counted', async () => {
    const members = new Set<string>()
    const api = fakeApi({
      existingSlugs: new Map([['northline-labs', 'org-existing']]),
      members,
    })
    const earlier = await api.fetch(`${URL_BASE}/v1/admin/users/import`, {
      method: 'POST',
      body: JSON.stringify({
        users: [
          { email: 'maya@northline.app', emailVerified: true },
          { email: 'jon@northline.app', emailVerified: true },
        ],
      }),
    })
    const created = (await earlier.json()) as { results: { id: string }[] }
    members.add(`org-existing:${created.results[0]?.id}`)
    // The users file is imported by an earlier run, so every row is skipped (no ids).
    const run = await tula(args, clerk(), api, {})
    expect(run.stdout).toContain('Organizations:            1 created, 1 already there, 0 failed')
    expect(run.stdout).toContain('1 already members')
  })

  test('a role the environment does not have is a failed membership, not a failed run', async () => {
    const api = fakeApi({ unknownRoles: ['member'] })
    const run = await tula(args, clerk(), api)
    expect(run.stdout).toContain('organization.role_unknown')
    expect(run.stdout).toContain('The role does not exist in the environment.')
    expect(run.stdout).toContain('Memberships:              2 added, 0 already members, 2 failed')
  })

  test('an environment with organizations off stops with what to do, and the users are kept', async () => {
    const api = fakeApi({ organizations: 'disabled' })
    const run = await tula(args, clerk(), api)
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('Organizations are switched off in this environment')
    expect(JSON.parse(progressOf(run))).toMatchObject({
      counts: { created: 3 },
      organizations: { cursor: 0 },
    })
  })

  test('a slug taken by something not found is a failed organization', async () => {
    const api = fakeApi()
    const lying: AdminFetch = async (url, init) => {
      if (String(url).endsWith('/v1/admin/organizations') && init?.method === 'POST') {
        return problem(409, 'organization.slug_taken')
      }
      return api.fetch(url, init)
    }
    const run = await tula(args, clerk(), api, { fetch: lying })
    expect(run.stdout).toContain('organization.slug_taken')
    expect(run.stdout).toContain('Organizations:            0 created, 0 already there, 2 failed')
  })

  test('another failure on an organization is recorded with its code', async () => {
    const api = fakeApi()
    const refusing: AdminFetch = async (url, init) =>
      String(url).endsWith('/v1/admin/organizations') && init?.method === 'POST'
        ? problem(422, 'validation.failed')
        : api.fetch(url, init)
    const run = await tula(args, clerk(), api, { fetch: refusing })
    expect(JSON.parse(progressOf(run)).organizations.failed).toEqual([
      { row: 1, code: 'validation.failed' },
      { row: 2, code: 'validation.failed' },
    ])
    expect(run.stdout).toContain('source.organization_missing')
  })
})

describe('options and files', () => {
  test('--from and the file are required, and a provider is one of five', async () => {
    expect((await tula(['import', 'users.csv'], SUPABASE)).stderr).toContain(
      '--from names the provider'
    )
    expect((await tula(['import', '--from', 'okta', 'users.csv'], SUPABASE)).stderr).toContain(
      'one of clerk, auth0, firebase, supabase, better-auth'
    )
    expect((await tula(['import', '--from', 'supabase'], SUPABASE)).stderr).toContain(
      'Name the export file'
    )
  })

  test('an option of another provider is refused before a file is read', async () => {
    const run = await tula(
      ['import', '--from', 'supabase', 'users.csv', '--accounts', 'a.json'],
      SUPABASE
    )
    expect(run.stderr).toContain('--accounts is not used with --from supabase')
    const firebase = await tula(
      ['import', '--from', 'clerk', 'users.csv', '--firebase-rounds', '8'],
      SUPABASE
    )
    expect(firebase.stderr).toContain('--firebase-rounds is only used with --from firebase')
  })

  test('a missing file is named by its option, and a host that cannot read files says so', async () => {
    const missing = await tula(
      ['import', '--from', 'auth0', 'users.csv', '--password-hashes', 'nope.ndjson'],
      {
        '/work/users.csv': fixture('auth0-users.ndjson'),
      }
    )
    expect(missing.stderr).toContain('The file given as --password-hashes does not exist.')
    const none = await tula(['import', '--from', 'supabase', 'nope.csv'], {})
    expect(none.stderr).toContain('The file given as the export file does not exist.')
    const noHost = await tula(['import', '--from', 'supabase', 'users.csv'], SUPABASE, fakeApi(), {
      host: undefined,
    })
    expect(noHost.stderr).toContain('This run cannot read files.')
  })

  test('Auth0 with its password hash export imports the hashes', async () => {
    const run = await tula(
      ['import', '--from', 'auth0', 'users.ndjson', '--yes', '--password-hashes', 'h.ndjson'],
      {
        '/work/users.ndjson': fixture('auth0-users.ndjson'),
        '/work/h.ndjson': fixture('auth0-password-hashes.ndjson'),
      }
    )
    const sent = sentUsers(run) as { password?: { algorithm: string } }[]
    expect(sent.filter((user) => user.password?.algorithm === 'bcrypt')).toHaveLength(3)
    expectClean(run.all)
    expectClean(progressOf(run))
  })

  test('better-auth: scrypt users are refused with the reason, and the guide names --allow-passwordless', async () => {
    const run = await tula(
      ['import', '--from', 'better-auth', 'user.json', '--accounts', 'account.json'],
      {
        '/work/user.json': fixture('better-auth-user.json'),
        '/work/account.json': fixture('better-auth-account.json'),
      }
    )
    expect(run.stdout).toMatch(
      /user 1 {2}import\.unsupported_algorithm {2}m\*\*\*@\*\*\*\.app {2}The password is hashed with scrypt/
    )
    expectClean(run.all)
  })

  test('the help lists the command and its options', async () => {
    const help = await tula(['import', '--help'], {})
    expect(help.stdout).toContain('--progress-file')
    expect(help.stdout).toContain('--allow-passwordless')
    const general = await tula(['--help'], {})
    expect(general.stdout).toContain('import')
  })
})
