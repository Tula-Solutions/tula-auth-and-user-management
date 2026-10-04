import { describe, expect, test } from 'bun:test'
import { type AdminFetch, createInstanceClient } from '@tula/admin'
import type { MemoryDiagnostics } from '../../../apps/api/src/adapters/memory/diagnostics'
import { createApp } from '../../../apps/api/src/index'
import { sha256Hex } from '../../../apps/api/src/lib/crypto'
import { createTestDeps, TEST_CONFIG, type TestDeps } from '../../../apps/api/src/testing'
import { type CliIo, COMMANDS, examine, runCli, VERSION } from './index'

const TOKEN = 'k3Zr8vQ1nP5xW7bT2mY9cF4hJ6dL0sAg'
const BASE_URL = 'http://localhost:3003'

interface Run {
  code: number
  stdout: string
  stderr: string
  requests: string[]
}

/** Run the real `tula` entry with the given `fetch`. */
async function tula(args: string[], fetch: AdminFetch, io: Partial<CliIo> = {}): Promise<Run> {
  let stdout = ''
  let stderr = ''
  const requests: string[] = []
  const counted: AdminFetch = (url, init) => {
    requests.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`)
    return fetch(url, init)
  }
  const code = await runCli(
    args,
    {
      stdout: { write: (text) => (stdout += text) },
      stderr: { write: (text) => (stderr += text) },
      env: { TULA_API_URL: BASE_URL, TULA_ADMIN_TOKEN: TOKEN },
      cwd: '/nowhere',
      isTTY: false,
      fetch: counted,
      ...io,
    },
    COMMANDS
  )
  return { code, stdout, stderr, requests }
}

/** The real API in process, with the admin token configured. */
function api(overrides: Partial<TestDeps> = {}) {
  const deps = createTestDeps({
    config: { ...TEST_CONFIG, instanceAdminTokenHash: sha256Hex(TOKEN) },
    ...overrides,
  })
  const app = createApp(deps)
  const fetch: AdminFetch = async (url, init) => app.request(url, init)
  return { deps, fetch, diagnostics: deps.diagnostics as MemoryDiagnostics }
}

describe('tula doctor against the API in process', () => {
  test('a healthy deployment: exit 0, every check listed, nothing failing', async () => {
    const { fetch, deps } = api()
    const run = await tula(['doctor'], fetch, { now: () => deps.clock.now() })
    expect(run.code).toBe(0)
    expect(run.stderr).toBe('')
    for (const id of ['api', 'version', 'database', 'migrations', 'smtp', 'clock', 'local_clock']) {
      expect(run.stdout).toMatch(new RegExp(`\\b${id}\\b`))
    }
    expect(run.stdout).not.toContain('FAIL')
    expect(run.stdout).not.toContain(TOKEN)
    expect(run.requests).toEqual(['GET /v1/status', 'GET /v1/instance/diagnostics'])
  })

  test('a failing dependency: exit 1, the failure and its fix under it', async () => {
    const { fetch, deps, diagnostics } = api()
    diagnostics.smtp = async () => {
      throw new Error('connect ECONNREFUSED relay.internal CANARY')
    }
    const run = await tula(['doctor'], fetch, { now: () => deps.clock.now() })
    expect(run.code).toBe(1)
    const lines = run.stdout.split('\n')
    const failure = lines.findIndex((line) => /FAIL\s+smtp/.test(line))
    expect(failure).toBeGreaterThan(-1)
    expect(lines[failure + 1]).toMatch(/^\s+fix: .*SMTP_URL/)
    expect(run.stdout).toMatch(/1 failed/)
    expect(run.stdout + run.stderr).not.toContain('CANARY')
  })

  test('--json: the checks as data, each with where it ran, and the same exit code', async () => {
    const { fetch, deps, diagnostics } = api()
    diagnostics.redis = async () => {
      throw new Error('down')
    }
    const run = await tula(['doctor', '--json'], fetch, { now: () => deps.clock.now() })
    expect(run.code).toBe(1)
    const report = JSON.parse(run.stdout) as {
      apiUrl: string
      ok: boolean
      checks: { id: string; status: string; source: string; fix?: string }[]
    }
    expect(report.apiUrl).toBe(BASE_URL)
    expect(report.ok).toBe(false)
    expect(report.checks.find((check) => check.id === 'redis')).toMatchObject({
      status: 'fail',
      source: 'server',
    })
    expect(report.checks.find((check) => check.id === 'api')).toMatchObject({
      status: 'ok',
      source: 'cli',
    })
  })

  test('warnings pass, unless --strict', async () => {
    const { fetch, deps } = api()
    // This machine's clock is ten seconds off the server's.
    const now = () => new Date(deps.clock.now().getTime() + 10_000)
    const lenient = await tula(['doctor'], fetch, { now })
    expect(lenient.code).toBe(0)
    expect(lenient.stdout).toMatch(/warn\s+local_clock/)
    expect(lenient.stdout).toMatch(/1 warning/)
    const strict = await tula(['doctor', '--strict'], fetch, { now })
    expect(strict.code).toBe(1)
  })

  test('a server without TULA_ADMIN_TOKEN: a warning that says how to turn the checks on', async () => {
    const deps = createTestDeps()
    const app = createApp(deps)
    const run = await tula(['doctor'], async (url, init) => app.request(url, init), {
      now: () => deps.clock.now(),
    })
    expect(run.code).toBe(0)
    expect(run.stdout).toMatch(/warn\s+server_checks/)
    expect(run.stdout).toContain('TULA_ADMIN_TOKEN')
  })

  test('a wrong token: the server checks fail, and the token is not printed', async () => {
    const { fetch, deps } = api()
    const wrong = 'Zz9y8x7w6v5u4t3s2r1q0p9o8n7m6l5k'
    const run = await tula(['doctor'], fetch, {
      now: () => deps.clock.now(),
      env: { TULA_API_URL: BASE_URL, TULA_ADMIN_TOKEN: wrong },
    })
    expect(run.code).toBe(1)
    expect(run.stdout).toMatch(/FAIL\s+server_checks/)
    expect(run.stdout + run.stderr).not.toContain(wrong)
  })

  test('no token here: the local checks still run, with a warning', async () => {
    const { fetch, deps } = api()
    const run = await tula(['doctor'], fetch, {
      now: () => deps.clock.now(),
      env: { TULA_API_URL: BASE_URL },
    })
    expect(run.code).toBe(0)
    expect(run.stdout).toMatch(/ok\s+api/)
    expect(run.stdout).toMatch(/warn\s+server_checks/)
    expect(run.requests).toEqual(['GET /v1/status'])
  })

  test('the admin token can come from a file, and never from the command line', async () => {
    const { fetch, deps } = api()
    const run = await tula(['doctor', '--admin-token-file', 'token.txt'], fetch, {
      now: () => deps.clock.now(),
      env: { TULA_API_URL: BASE_URL },
      readFile: async () => `${TOKEN}\n`,
    })
    expect(run.code).toBe(0)
    expect(run.stdout).toMatch(/ok\s+database/)

    const refused = await tula(['doctor', '--admin-token', TOKEN], fetch)
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain('TULA_ADMIN_TOKEN')
    expect(refused.stdout + refused.stderr).not.toContain(TOKEN)
    expect(refused.requests).toEqual([])
  })
})

describe('tula doctor against an API that misbehaves', () => {
  const status = () => Response.json({ status: 'ok', version: VERSION })

  test('an API that cannot be reached: one failing check with its fix, exit 1', async () => {
    const run = await tula(['doctor'], async () => {
      throw new TypeError('fetch failed')
    })
    expect(run.code).toBe(1)
    expect(run.stdout).toMatch(/FAIL\s+api/)
    expect(run.stdout).toMatch(/fix: .*TULA_API_URL/)
    expect(run.requests).toEqual(['GET /v1/status'])
  })

  test('no API URL is a usage error', async () => {
    const run = await tula(['doctor'], async () => status(), { env: {} })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('TULA_API_URL')
  })

  test('a server of another version is a warning', async () => {
    const run = await tula(
      ['doctor'],
      async () => Response.json({ status: 'ok', version: '9.9.9' }),
      { env: { TULA_API_URL: BASE_URL } }
    )
    expect(run.stdout).toMatch(/warn\s+version/)
    expect(run.stdout).toContain('9.9.9')
  })

  test('service.unavailable from the instance route is reported as the shared store being down', async () => {
    const run = await tula(['doctor'], async (url) =>
      new URL(url).pathname === '/v1/status'
        ? status()
        : Response.json(
            { status: 503, code: 'service.unavailable', detail: 'unavailable' },
            { status: 503 }
          )
    )
    expect(run.code).toBe(1)
    expect(run.stdout).toMatch(/FAIL\s+server_checks/)
    expect(run.stdout).toContain('REDIS_URL')
  })

  test('control characters in a server’s text never reach the terminal', async () => {
    const run = await tula(['doctor'], async (url) =>
      new URL(url).pathname === '/v1/status'
        ? status()
        : Response.json({
            version: VERSION,
            environment: 'local',
            time: new Date().toISOString(),
            publicUrl: 'http://localhost:3003',
            checks: [
              {
                id: 'smtp\u001b[2J',
                status: 'fail',
                summary: 'gone\u001b]0;owned\u0007',
                fix: 'do\rthis',
                values: ['a\u009bb'],
              },
            ],
          })
    )
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is looked for
    expect(run.stdout).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/)
    expect(run.code).toBe(1)
  })

  /** A server that answers the status and names `publicUrl` as its (skipped) PUBLIC_URL. */
  const naming = (publicUrl: unknown, seen: string[]): AdminFetch => {
    return async (url) => {
      seen.push(url)
      return new URL(url).pathname === '/v1/status'
        ? status()
        : Response.json({
            version: VERSION,
            environment: 'local',
            time: new Date().toISOString(),
            publicUrl,
            checks: [{ id: 'public_url', status: 'skipped', summary: 'loopback' }],
          })
    }
  }

  test('a loopback PUBLIC_URL that is the API URL given here counts as checked', async () => {
    const seen: string[] = []
    const run = await tula(['doctor'], naming(`${BASE_URL}/`, seen))
    expect(run.stdout).toMatch(/ok\s+public_url/)
    expect(new Set(seen.filter((url) => url.endsWith('/v1/status')))).toEqual(
      new Set([`${BASE_URL}/v1/status`])
    )
  })

  // The address comes from the server's answer: a hostile or mistaken server must not be able
  // to make this machine request a port and path of its choosing.
  test.each([
    ['another port, a path and a query', 'http://localhost:9/x?y'],
    ['another loopback port', 'http://localhost:9999'],
    ['another loopback host', 'http://127.0.0.1:3003'],
    ['credentials in front of the API URL', 'http://user:pw@localhost:3003'],
    ['a path under the API URL’s origin', 'http://localhost:3003/internal/admin?drop=1'],
  ])('a PUBLIC_URL the server names is never requested: %s', async (_, publicUrl) => {
    const seen: string[] = []
    const run = await tula(['doctor'], naming(publicUrl, seen))
    for (const url of seen) {
      expect(new URL(url).origin).toBe(BASE_URL)
      expect(['/v1/status', '/v1/instance/diagnostics']).toContain(new URL(url).pathname)
      expect(new URL(url).search).toBe('')
    }
    expect(run.stdout).not.toContain('pw@')
    if (publicUrl.startsWith(`${BASE_URL}/`)) {
      // The same origin: what was asked is `<origin>/v1/status`, never the path it named.
      expect(run.stdout).toMatch(/ok\s+public_url/)
    } else {
      expect(run.stdout).toMatch(/skipped\s+public_url/)
      expect(run.stdout).toContain('--api-url')
      expect(run.code).toBe(0)
    }
  })

  test.each([
    [429, 'rate_limited', 'rate limiting'],
    [500, 'internal', 'could not be read (internal, HTTP 500)'],
  ])(
    'HTTP %i from the instance route is a failing check, not a crash',
    async (code, name, text) => {
      const run = await tula(['doctor'], async (url) =>
        new URL(url).pathname === '/v1/status'
          ? status()
          : Response.json({ status: code, code: name, detail: 'x' }, { status: code })
      )
      expect(run.code).toBe(1)
      expect(run.stdout).toMatch(/FAIL\s+server_checks/)
      expect(run.stdout).toContain(text)
    }
  )

  test('an answer that is not the API’s is a failing check', async () => {
    const run = await tula(['doctor'], async (url) =>
      new URL(url).pathname === '/v1/status' ? status() : new Response('<html>', { status: 200 })
    )
    expect(run.code).toBe(1)
    expect(run.stdout).toMatch(/FAIL\s+server_checks/)
  })

  test('a status page that is not 200 fails the api check with the status', async () => {
    const run = await tula(['doctor'], async () => new Response('', { status: 502 }))
    expect(run.stdout).toContain('HTTP 502')
    expect(run.code).toBe(1)
  })

  test.each([
    ['not a URL', 'not-a-url', 'is not a URL'],
    ['a URL with credentials', 'https://user:pw@auth.example.com', 'without credentials'],
    ['another scheme', 'ftp://auth.example.com', 'http(s)'],
  ])('an API URL that is %s is a usage error', async (_name, url, text) => {
    const run = await tula(['doctor'], async () => status(), { env: { TULA_API_URL: url } })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain(text)
    expect(run.requests).toEqual([])
  })

  test('the admin token is not sent over plain http to another machine', async () => {
    const run = await tula(['doctor'], async () => status(), {
      env: { TULA_API_URL: 'http://auth.example.com', TULA_ADMIN_TOKEN: TOKEN },
    })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('plain http')
    expect(run.requests).toEqual([])
  })

  test.each([
    ['too short', 'short-token'],
    ['a secret key', 'tula_sk_dev_abcdefghijklmnopqrstuvwxyz0123456'],
  ])('an admin token that is %s is refused before any request', async (_name, token) => {
    const run = await tula(['doctor'], async () => status(), {
      env: { TULA_API_URL: BASE_URL, TULA_ADMIN_TOKEN: token },
    })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('TULA_ADMIN_TOKEN')
    expect(run.requests).toEqual([])
  })

  test('--admin-token-file - is refused on a terminal, and reads a pipe otherwise', async () => {
    const typed = await tula(['doctor', '--admin-token-file', '-'], async () => status(), {
      env: { TULA_API_URL: BASE_URL },
      stdinIsTTY: true,
    })
    expect(typed.code).toBe(1)
    expect(typed.stderr).toContain('terminal')

    const unreadable = await tula(['doctor', '--admin-token-file', 'x'], async () => status(), {
      env: { TULA_API_URL: BASE_URL },
      readFile: async () => {
        throw new Error('ENOENT')
      },
    })
    expect(unreadable.code).toBe(1)
    expect(unreadable.stderr).toContain('Could not read the file given as --admin-token-file')

    const nowhere = await tula(['doctor', '--admin-token-file', '-'], async () => status(), {
      env: { TULA_API_URL: BASE_URL },
    })
    expect(nowhere.stderr).toContain('cannot be read here')
  })
})

describe('examine: a run that is abandoned', () => {
  test.each(['/v1/status', '/v1/instance/diagnostics'])(
    'aborting the signal ends the request to %s, and the run answers with a failing check',
    async (hanging) => {
      const real = api()
      let open = 0
      const fetch: AdminFetch = async (url, init) => {
        if (new URL(url).pathname !== hanging) {
          return real.fetch(url, init)
        }
        // Never answers; ends only when its signal aborts.
        open += 1
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            open -= 1
            reject(init.signal?.reason)
          })
        })
      }
      const controller = new AbortController()
      const run = examine({
        apiUrl: BASE_URL,
        instance: createInstanceClient({ baseUrl: BASE_URL, adminToken: TOKEN, fetch }),
        io: {
          stdout: { write: () => {} },
          stderr: { write: () => {} },
          env: {},
          cwd: '/nowhere',
          isTTY: false,
          fetch,
        },
        signal: controller.signal,
      })
      for (let waited = 0; waited < 500 && open === 0; waited += 1) {
        await Bun.sleep(2)
      }
      expect(open).toBe(1)
      controller.abort()
      const report = await run
      expect(open).toBe(0)
      expect(report.checks.at(-1)?.status).toBe('fail')
    }
  )
})
