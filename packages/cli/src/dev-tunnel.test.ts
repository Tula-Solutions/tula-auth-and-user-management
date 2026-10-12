import { describe, expect, test } from 'bun:test'
import type { AdminFetch } from '@tula/admin'
import { parseDevBlock, tunnelRoutes, withDevBlock } from './dev'
import type { Host, RunOptions, RunResult } from './host'
import { type CliIo, COMMANDS, runCli } from './index'
import { judgeTunnel, tailscaleFunnel } from './tunnel'

const PK = 'tula_pk_dev_devtestpublishable000000000000000000'
const SK = 'tula_sk_dev_devtestsecret00000000000000000000000'
const ENV_ID = '0198c0de-0000-7000-8000-00000000e001'
const CWD = '/work/shop'
const FILE = `${CWD}/.env.local`
const NAME = 'laptop.tail1234.ts.net'
const PUBLIC = `https://${NAME}`
const TARGET = 'http://127.0.0.1:53003'
/** In the resolved Compose file, which the CLI reads: it must never reach a stream. */
const MASTER_KEY = 'canary-master-key-0123456789abcdef0123456789abcdef'

/** What the fake Tailscale client serves on port 443. */
interface Served {
  /** Path to what answers it: a proxy target, or another kind of handler. */
  web: Record<string, { Proxy: string } | { Text: string }>
  funnel: boolean
  /** A TCP forward on the port, with no web endpoint. */
  tcp?: boolean
}

interface FakeOptions {
  files?: Record<string, string>
  /** `tailscale` is not installed. */
  noTailscale?: boolean
  /** What is on port 443 before the run. */
  served?: Served
  /** Routes are opened, and the internet never reaches them. */
  neverPublic?: boolean
  /** How an open command ends, in place of opening. */
  open?: Partial<RunResult> | Error
  /** The close command does nothing. */
  closeFails?: boolean
  /** The close command is interrupted too. */
  closeInterrupted?: boolean
  /** How asking the tool what it serves ends, in place of an answer. */
  status?: Partial<RunResult>
  /** Where Docker says the API is published, when not where the Compose file said. */
  publishedAt?: string
  /** What the stack's `.env` switches on, as Compose resolves it. */
  environment?: Record<string, string | boolean>
  /** A Compose file from before `--tunnel`: its `PUBLIC_URL` is a fixed line. */
  fixedPublicUrl?: boolean
  /** What `docker compose config --format json` prints, in place of the resolved file. */
  config?: string
}

function fakeHost(options: FakeOptions = {}) {
  const files = new Map(Object.entries(options.files ?? {}))
  const calls: { command: string[]; options: RunOptions }[] = []
  let served: Served = options.served ?? { web: {}, funnel: false }
  const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '', timedOut: false })

  function tailscale(command: readonly string[]): RunResult {
    if (options.noTailscale) {
      throw Object.assign(new Error('spawn tailscale ENOENT'), { code: 'ENOENT' })
    }
    const args = command.slice(1)
    if (args.join(' ') === 'funnel status --json') {
      if (options.status) {
        return { ...ok(), ...options.status }
      }
      const key = `${NAME}:443`
      const any = Object.keys(served.web).length > 0
      return ok(
        JSON.stringify({
          ...((any || served.tcp) && {
            TCP: { '443': served.tcp ? { TCPForward: '127.0.0.1:5432' } : { HTTPS: true } },
          }),
          ...(any && { Web: { [key]: { Handlers: served.web } } }),
          ...(any && served.funnel && { AllowFunnel: { [key]: true } }),
        })
      )
    }
    if (args.at(-1) === 'off') {
      if (options.closeInterrupted) {
        throw Object.assign(new Error('interrupted'), { code: 'ABORT' })
      }
      if (!options.closeFails) {
        served = { web: {}, funnel: false }
      }
      return ok()
    }
    if (options.open instanceof Error) {
      throw options.open
    }
    if (options.open) {
      return { ...ok(), ...options.open }
    }
    const path = args.find((arg) => arg.startsWith('--set-path='))?.slice('--set-path='.length)
    served = {
      web: { ...served.web, [path ?? '/']: { Proxy: args.at(-1) as string } },
      funnel: !options.neverPublic,
    }
    return ok('Available on the internet:\n')
  }

  const host: Host = {
    async run(command, runOptions) {
      calls.push({ command: [...command], options: runOptions })
      if (command[0] === 'tailscale') {
        return tailscale(command)
      }
      const line = command.join(' ')
      if (line.includes('config --services')) {
        return ok('postgres\nredis\nmailpit\nmigrate\napi\n')
      }
      if (line.includes('config --format json')) {
        return ok(
          options.config ??
            JSON.stringify({
              services: {
                api: {
                  environment: {
                    TULA_MASTER_KEY: MASTER_KEY,
                    PUBLIC_URL: options.fixedPublicUrl
                      ? 'http://localhost:53003'
                      : (runOptions.env?.TULA_PUBLIC_URL ?? 'http://localhost:53003'),
                    OAUTH_MOCK_PROVIDER: 'false',
                    SMS_PROVIDER: 'none',
                    ...options.environment,
                  },
                  ports: [
                    { mode: 'ingress', host_ip: '127.0.0.1', target: 3003, published: '53003' },
                  ],
                },
              },
            })
        )
      }
      if (line.includes('seed.ts')) {
        return ok(`seed: development environment ${ENV_ID}\n`)
      }
      if (line.includes('create-api-key.ts')) {
        return ok(`${line.includes('--kind publishable') ? PK : SK}\n`)
      }
      if (line.includes('port api')) {
        return ok(`${options.publishedAt ?? '127.0.0.1:53003'}\n`)
      }
      if (line.startsWith('git check-ignore')) {
        return ok('.env.local\n')
      }
      return ok()
    },
    readFile: async (path) => files.get(path) ?? null,
    writeSecretFile: async (path, text) => void files.set(path, text),
    createSecretFile: async (path, text) => void files.set(path, text),
    removeFile: async (path) => files.delete(path),
    restrictFile: async () => false,
    sleep: async () => {},
  }
  const lines = () => calls.map((call) => call.command.join(' '))
  return {
    host,
    files,
    calls,
    lines,
    served: () => served,
    tailscale: () => lines().filter((line) => line.startsWith('tailscale ')),
    changes: () =>
      lines().filter((line) => line.startsWith('tailscale ') && !line.includes('status')),
    docker: (part: string) => calls.filter((call) => call.command.join(' ').includes(part)),
  }
}

const healthyApi: AdminFetch = async (url, init) => {
  if (new URL(url).pathname === '/v1/ready') {
    return Response.json({ status: 'ready', checks: {} })
  }
  return new Headers(init?.headers).get('authorization') === `Bearer ${SK}`
    ? Response.json({ settings: {}, revision: 0, managedBy: null })
    : Response.json({ status: 401, code: 'auth.invalid_key', detail: 'no' }, { status: 401 })
}

async function tula(args: string[], io: Partial<CliIo>) {
  let stdout = ''
  let stderr = ''
  const code = await runCli(
    args,
    {
      stdout: { write: (text) => (stdout += text) },
      stderr: { write: (text) => (stderr += text) },
      env: {},
      cwd: CWD,
      isTTY: false,
      fetch: healthyApi,
      ...io,
    },
    COMMANDS
  )
  return { code, stdout, stderr, all: stdout + stderr }
}

const ROUTES = tunnelRoutes(TARGET, ENV_ID)
const OURS: Served = {
  web: Object.fromEntries(ROUTES.map((route) => [route.path, { Proxy: route.target }])),
  funnel: true,
}

describe('tula dev --tunnel', () => {
  test('opens the tunnel, starts the API under its address and writes it to the block', async () => {
    const mine = '# mine\nFOO=bar\n'
    const fake = fakeHost({ files: { [FILE]: mine } })
    const run = await tula(['dev', '--tunnel'], { host: fake.host })
    expect(run.code).toBe(0)

    // Everything goes to the API; the two paths Apple and Android ask for at a domain's
    // root go to the development environment's own files.
    expect(fake.changes()).toEqual([
      `tailscale funnel --bg --yes --https=443 ${TARGET}`,
      `tailscale funnel --bg --yes --https=443 --set-path=/.well-known/apple-app-site-association ${TARGET}/v1/environments/${ENV_ID}/.well-known/apple-app-site-association`,
      `tailscale funnel --bg --yes --https=443 --set-path=/.well-known/assetlinks.json ${TARGET}/v1/environments/${ENV_ID}/.well-known/assetlinks.json`,
    ])
    // The API gets the address from the one command that starts it, and from nowhere else.
    const [up] = fake.docker('up -d api')
    expect(up?.options.env).toEqual({ TULA_PUBLIC_URL: PUBLIC })
    for (const call of fake.calls.filter(
      (entry) => entry !== up && entry.command[0] === 'docker'
    )) {
      if (!call.command.includes('config')) {
        expect(call.options.env).toBeUndefined()
      }
    }

    const written = fake.files.get(FILE) ?? ''
    expect(written.startsWith(mine)).toBe(true)
    expect(parseDevBlock(written)).toEqual({
      TULA_API_URL: 'http://localhost:53003',
      TULA_ENVIRONMENT_ID: ENV_ID,
      TULA_PUBLISHABLE_KEY: PK,
      TULA_SECRET_KEY: SK,
      VITE_TULA_API_URL: 'http://localhost:53003',
      VITE_TULA_PUBLISHABLE_KEY: PK,
      NEXT_PUBLIC_TULA_PUBLISHABLE_KEY: PK,
      TULA_PUBLIC_URL: PUBLIC,
      TULA_ISSUER: `${PUBLIC}/v1/environments/${ENV_ID}`,
      TULA_TUNNEL_TARGET: TARGET,
    })

    expect(run.stdout).toContain(`Public address   ${PUBLIC}`)
    // What it did not do is said: the settings are the developer's to change.
    expect(run.stdout).toContain(`passkeys: { rpId: '${NAME}' }`)
    expect(run.stdout).toContain(`allowedOrigins: ['${PUBLIC}'`)
    expect(run.stdout).toContain('No setting of the environment was changed')
    expect(run.stdout).toContain('Not checked')
    expect(run.all).not.toContain(SK)
    expect(run.all).not.toContain(MASTER_KEY)
  })

  test('says before anything is started that the mock provider and the SMS inbox cannot be on', async () => {
    const fake = fakeHost()
    const run = await tula(['dev', '--tunnel'], { host: fake.host })
    const said = run.stdout.indexOf('OAUTH_MOCK_PROVIDER')
    expect(said).toBeGreaterThan(-1)
    expect(run.stdout.slice(said)).toContain('SMS_PROVIDER=dev')
    expect(said).toBeLessThan(run.stdout.indexOf('Starting the database'))
  })

  test('every command is an argument vector with a timeout, and none carries a credential or rewrites the Host header', async () => {
    const fake = fakeHost()
    await tula(['dev', '--tunnel'], { host: fake.host })
    await tula(['dev', 'down'], { host: fake.host })
    const tailscale = fake.calls.filter((call) => call.command[0] === 'tailscale')
    expect(tailscale.length).toBeGreaterThan(4)
    for (const call of fake.calls) {
      expect(call.options.timeoutMs).toBeGreaterThan(0)
      expect(['docker', 'git', 'tailscale']).toContain(call.command[0] as string)
    }
    for (const { command, options } of tailscale) {
      // One word of the vector is one argument: nothing a shell would have to split.
      for (const argument of command) {
        expect(argument).not.toMatch(/[\s;|&$`'"<>]/)
        // The development-only routes answer a loopback `Host` only: a tunnel that
        // rewrote the header would hand them to the internet.
        expect(argument).not.toMatch(/host-?header|rewrite|insecure/i)
        expect(argument).not.toMatch(/auth-?key|token|password|secret|login|config|socket/i)
      }
      expect(options.env).toBeUndefined()
      // Where a request goes is this machine by address, over plain http, on the API's port.
      const target = command.find((argument) => argument.includes('://'))
      if (target) {
        expect(target.startsWith(`${TARGET}`)).toBe(true)
      }
    }
  })

  test('a second run opens nothing, starts nothing new and writes nothing', async () => {
    const fake = fakeHost()
    await tula(['dev', '--tunnel'], { host: fake.host })
    const before = fake.files.get(FILE)
    const opened = fake.changes().length
    const again = await tula(['dev', '--tunnel'], { host: fake.host })
    expect(again.code).toBe(0)
    expect(fake.changes()).toHaveLength(opened)
    expect(fake.files.get(FILE)).toBe(before)
    expect(fake.docker('up -d api')[1]?.options.env).toEqual({ TULA_PUBLIC_URL: PUBLIC })
    expect(again.stdout).toContain(PUBLIC)
  })

  test('a route that went missing is opened again, and only that one', async () => {
    const fake = fakeHost({ served: { web: { '/': { Proxy: TARGET } }, funnel: true } })
    const run = await tula(['dev', '--tunnel'], { host: fake.host })
    expect(run.code).toBe(0)
    expect(fake.changes()).toHaveLength(2)
    expect(fake.changes().every((line) => line.includes('--set-path=/.well-known/'))).toBe(true)
  })

  test('a missing binary is said with how to install it, and nothing is started or written', async () => {
    const fake = fakeHost({ noTailscale: true })
    const run = await tula(['dev', '--tunnel'], { host: fake.host })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('`tailscale` was not found')
    expect(run.stderr).toContain('https://tailscale.com/download')
    expect(fake.files.has(FILE)).toBe(false)
    expect(fake.docker('migrate')).toHaveLength(0)
    expect(fake.docker('up -d api')).toHaveLength(0)
  })

  test('a tunnel that reports no address in time is closed again, and nothing is written', async () => {
    const fake = fakeHost({ neverPublic: true })
    const run = await tula(['dev', '--tunnel'], { host: fake.host })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('did not report a public address')
    expect(run.stderr).toContain('.env.local was not changed')
    expect(fake.served().web).toEqual({})
    expect(fake.changes().at(-1)).toBe('tailscale funnel --yes --https=443 off')
    expect(fake.files.has(FILE)).toBe(false)
    expect(fake.docker('up -d api')).toHaveLength(0)
  })

  test('a tool that does not come back is given up on by its timeout, with the same words', async () => {
    const fake = fakeHost({ open: { code: null, timedOut: true } })
    const run = await tula(['dev', '--tunnel'], { host: fake.host })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('did not report a public address')
    expect(fake.files.has(FILE)).toBe(false)
    expect(fake.docker('up -d api')).toHaveLength(0)
  })

  test('what the tool says when it refuses is cleaned before it is printed', async () => {
    const fake = fakeHost({
      open: { code: 1, stderr: 'Funnel not available\u001b[2J\u{202E}; see the admin console\n' },
    })
    const run = await tula(['dev', '--tunnel'], { host: fake.host })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('Funnel not available')
    expect(run.stderr).not.toContain('\u001b[2J')
    expect(run.stderr).not.toContain('\u{202E}')
    expect(fake.files.has(FILE)).toBe(false)
  })

  test.each<[string, Served]>([
    ['another server', { web: { '/': { Proxy: 'http://127.0.0.1:8080' } }, funnel: true }],
    [
      'a path of somebody’s own beside ours',
      { web: { ...OURS.web, '/blog': { Proxy: 'http://127.0.0.1:4000' } }, funnel: true },
    ],
    ['a file or a text', { web: { '/': { Text: 'hello' } }, funnel: false }],
    ['a TCP forward', { web: {}, funnel: false, tcp: true }],
  ])(
    'a port that already serves %s is refused and left exactly as it was',
    async (_name, served) => {
      const fake = fakeHost({ served })
      const run = await tula(['dev', '--tunnel'], { host: fake.host })
      expect(run.code).toBe(1)
      expect(run.stderr).toContain('already serves something else')
      expect(fake.changes()).toEqual([])
      expect(fake.served()).toEqual(served)
      expect(fake.files.has(FILE)).toBe(false)
      expect(fake.docker('up -d api')).toHaveLength(0)
    }
  )

  test.each<[string, Record<string, string | boolean>, string]>([
    ['the mock OAuth provider', { OAUTH_MOCK_PROVIDER: 'true' }, 'OAUTH_MOCK_PROVIDER'],
    [
      'the mock OAuth provider, as YAML reads it',
      { OAUTH_MOCK_PROVIDER: true },
      'OAUTH_MOCK_PROVIDER',
    ],
    ['the mock OAuth provider, spelt 1', { OAUTH_MOCK_PROVIDER: '1' }, 'OAUTH_MOCK_PROVIDER'],
    ['the development SMS inbox', { SMS_PROVIDER: 'dev' }, 'SMS_PROVIDER=dev'],
  ])(
    'with %s on, it stops before anything is started, opened or written',
    async (_name, environment, word) => {
      const fake = fakeHost({ environment })
      const run = await tula(['dev', '--tunnel'], { host: fake.host })
      expect(run.code).toBe(1)
      expect(run.stderr).toContain(word)
      expect(run.stderr).toContain('refuses to start')
      expect(run.stderr).toContain('does not change your lines')
      expect(fake.tailscale()).toEqual([])
      expect(fake.docker('migrate')).toHaveLength(0)
      expect(fake.docker('up -d api')).toHaveLength(0)
      expect(fake.files.has(FILE)).toBe(false)
      expect(run.all).not.toContain(MASTER_KEY)
    }
  )

  test('a real sender is not the inbox: SMS_PROVIDER=twilio does not stop it', async () => {
    const fake = fakeHost({ environment: { SMS_PROVIDER: 'twilio' } })
    expect((await tula(['dev', '--tunnel'], { host: fake.host })).code).toBe(0)
  })

  test('a Compose file with a fixed PUBLIC_URL is not edited: the line to write is said', async () => {
    const fake = fakeHost({ fixedPublicUrl: true })
    const run = await tula(['dev', '--tunnel'], { host: fake.host })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the Compose file's own syntax
      'PUBLIC_URL: ${TULA_PUBLIC_URL:-http://localhost:${API_PORT:-3003}}'
    )
    expect(fake.tailscale()).toEqual([])
    expect(fake.docker('migrate')).toHaveLength(0)
    expect(fake.files.has(FILE)).toBe(false)
  })

  test.each([
    ['not JSON', `not json ${MASTER_KEY}`],
    ['no api service', JSON.stringify({ services: {} })],
  ])(
    'a resolved Compose file that cannot be read (%s) stops it, and is never shown',
    async (_name, config) => {
      const fake = fakeHost({ config })
      const run = await tula(['dev', '--tunnel'], { host: fake.host })
      expect(run.code).toBe(1)
      expect(run.stderr).toContain('could not be read')
      expect(run.all).not.toContain(MASTER_KEY)
      expect(fake.tailscale()).toEqual([])
    }
  )

  test('an API port that is not published on a fixed port stops it', async () => {
    const config = JSON.stringify({
      services: {
        api: {
          environment: { PUBLIC_URL: 'https://tula-dev-tunnel-probe.invalid' },
          ports: [{ target: 3003 }],
        },
      },
    })
    const fake = fakeHost({ config })
    const run = await tula(['dev', '--tunnel'], { host: fake.host })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('fixed port')
    expect(fake.tailscale()).toEqual([])
  })

  test('an API that does not come up under the address: the tunnel this run opened is closed, nothing written', async () => {
    const fake = fakeHost()
    const down: AdminFetch = async () => Response.json({}, { status: 503 })
    const run = await tula(['dev', '--tunnel', '--timeout', '1'], { host: fake.host, fetch: down })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('did not become ready')
    expect(run.stderr).toContain('The tunnel this run opened was closed again')
    expect(fake.served().web).toEqual({})
    expect(fake.files.has(FILE)).toBe(false)
  })

  test('a tunnel that was already open is not closed by a run that fails', async () => {
    const fake = fakeHost({ served: OURS })
    const down: AdminFetch = async () => Response.json({}, { status: 503 })
    const run = await tula(['dev', '--tunnel', '--timeout', '1'], { host: fake.host, fetch: down })
    expect(run.code).toBe(1)
    expect(fake.changes()).toEqual([])
    expect(fake.served()).toEqual(OURS)
  })

  test('interrupted while the tunnel is being opened: what was opened is closed', async () => {
    const interrupted = Object.assign(new Error('interrupted'), { code: 'ABORT' })
    const fake = fakeHost({
      served: { web: { '/': { Proxy: TARGET } }, funnel: true },
      open: interrupted,
    })
    const run = await tula(['dev', '--tunnel'], { host: fake.host })
    expect(run.code).not.toBe(0)
    expect(fake.changes().at(-1)).toBe('tailscale funnel --yes --https=443 off')
    expect(fake.served().web).toEqual({})
    expect(fake.files.has(FILE)).toBe(false)
    expect(run.stderr).toContain('Interrupted')
    expect(run.stderr).toContain('closed again')
  })

  describe('a tunnel that could not be closed after a failed opening is never left unsaid', () => {
    const interrupted = Object.assign(new Error('interrupted'), { code: 'ABORT' })
    const BY_HAND = 'tailscale funnel --https=443 off'

    test.each<[string, FakeOptions]>([
      ['interrupted, and the close does nothing', { open: interrupted, closeFails: true }],
      ['interrupted, and interrupted again', { open: interrupted, closeInterrupted: true }],
      ['refused, and the close is interrupted', { open: { code: 1 }, closeInterrupted: true }],
      ['no address, and the close is interrupted', { neverPublic: true, closeInterrupted: true }],
    ])('%s', async (_name, options) => {
      const fake = fakeHost({
        served: { web: { '/': { Proxy: TARGET } }, funnel: true },
        ...options,
      })
      const run = await tula(['dev', '--tunnel'], { host: fake.host })
      expect(run.code).not.toBe(0)
      expect(run.stderr).toContain(BY_HAND)
      expect(run.stderr).not.toContain('closed again')
      expect(fake.files.has(FILE)).toBe(false)
      expect(fake.docker('up -d')).toEqual([])
    })
  })

  test.each<[string, Partial<RunResult>, string]>([
    ['does not answer', { code: null, timedOut: true }, 'did not answer'],
    [
      'fails, with words of its own',
      { code: 1, stderr: 'Logged out.\u001b[31m\n' },
      'Is this machine signed in',
    ],
    ['prints what cannot be read', { stdout: 'Funnel off' }, 'cannot read'],
  ])(
    'a tool that %s when asked what it serves stops the run before the stack is touched',
    async (_name, status, words) => {
      const fake = fakeHost({ status })
      const run = await tula(['dev', '--tunnel'], { host: fake.host })
      expect(run.code).toBe(1)
      expect(run.stderr).toContain(words)
      expect(run.stderr).not.toContain('\u001b[31m')
      expect(fake.changes()).toEqual([])
      expect(fake.docker('migrate')).toHaveLength(0)
      expect(fake.files.has(FILE)).toBe(false)
    }
  )

  test('an API published elsewhere than the tunnel was pointed: closed again, nothing written', async () => {
    const fake = fakeHost({ publishedAt: '127.0.0.1:53999' })
    const run = await tula(['dev', '--tunnel'], { host: fake.host })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('another port')
    expect(fake.served().web).toEqual({})
    expect(fake.files.has(FILE)).toBe(false)
  })

  test('--tunnel does not belong to `down`', async () => {
    const fake = fakeHost()
    const run = await tula(['dev', 'down', '--tunnel'], { host: fake.host })
    expect(run.code).not.toBe(0)
    expect(fake.calls).toEqual([])
  })
})

describe('a tunnel does not outlive what it was opened for', () => {
  test('`tula dev` without --tunnel closes it and starts the API on its local address again', async () => {
    const mine = 'FOO=bar\n'
    const fake = fakeHost({ files: { [FILE]: mine } })
    await tula(['dev', '--tunnel'], { host: fake.host })
    const run = await tula(['dev'], { host: fake.host })
    expect(run.code).toBe(0)
    expect(fake.changes().at(-1)).toBe('tailscale funnel --yes --https=443 off')
    expect(fake.served().web).toEqual({})
    // No address in the environment: the Compose file's own default (loopback) applies.
    expect(fake.docker('up -d api')[1]?.options.env).toBeUndefined()
    const text = fake.files.get(FILE) ?? ''
    expect(text.startsWith(mine)).toBe(true)
    const block = parseDevBlock(text) ?? {}
    expect(
      Object.keys(block).filter((name) => /^TULA_(PUBLIC_URL|ISSUER|TUNNEL)/.test(name))
    ).toEqual([])
    expect(block.TULA_SECRET_KEY).toBe(SK)
    expect(run.stdout).toContain('The tunnel was closed')
    expect(run.stdout).not.toContain(PUBLIC)
  })

  test('a plain run that never had a tunnel does not start the tunnel’s tool', async () => {
    const fake = fakeHost({ served: OURS })
    await tula(['dev'], { host: fake.host })
    await tula(['dev', 'down'], { host: fake.host })
    expect(fake.tailscale()).toEqual([])
    expect(fake.served()).toEqual(OURS)
  })

  test('`tula dev down` closes it before the stack stops, and takes the address out of the block', async () => {
    const mine = 'FOO=bar\n'
    const fake = fakeHost({ files: { [FILE]: mine } })
    await tula(['dev', '--tunnel'], { host: fake.host })
    const run = await tula(['dev', 'down'], { host: fake.host })
    expect(run.code).toBe(0)
    const lines = fake.lines()
    expect(lines.indexOf('tailscale funnel --yes --https=443 off')).toBeLessThan(
      lines.findIndex((line) => line.includes('compose down'))
    )
    expect(fake.served().web).toEqual({})
    const text = fake.files.get(FILE) ?? ''
    expect(text.startsWith(mine)).toBe(true)
    expect(parseDevBlock(text)).toEqual({
      TULA_API_URL: 'http://localhost:53003',
      TULA_ENVIRONMENT_ID: ENV_ID,
      TULA_PUBLISHABLE_KEY: PK,
      TULA_SECRET_KEY: SK,
      VITE_TULA_API_URL: 'http://localhost:53003',
      VITE_TULA_PUBLISHABLE_KEY: PK,
      NEXT_PUBLIC_TULA_PUBLISHABLE_KEY: PK,
    })
    expect(run.all).not.toContain(SK)
  })

  test('`tula dev down --volumes` closes it too', async () => {
    const fake = fakeHost()
    await tula(['dev', '--tunnel'], { host: fake.host })
    const run = await tula(['dev', 'down', '--volumes', '--yes'], { host: fake.host })
    expect(run.code).toBe(0)
    expect(fake.served().web).toEqual({})
    expect(parseDevBlock(fake.files.get(FILE) ?? '')).toBeNull()
  })

  test('a tunnel that cannot be closed is said, with the command, and the stack still stops', async () => {
    const fake = fakeHost({ closeFails: true })
    await tula(['dev', '--tunnel'], { host: fake.host })
    const run = await tula(['dev', 'down'], { host: fake.host })
    expect(run.code).toBe(0)
    expect(run.stderr).toContain('could not be closed')
    expect(run.stderr).toContain('tailscale funnel --https=443 off')
    expect(fake.docker('compose down')).toHaveLength(1)
  })

  test('the tool gone since the tunnel was opened: the same warning, never a failed stop', async () => {
    const block = withDevBlock('', {
      TULA_ENVIRONMENT_ID: ENV_ID,
      TULA_PUBLIC_URL: PUBLIC,
      TULA_TUNNEL_TARGET: TARGET,
    })
    const fake = fakeHost({ files: { [FILE]: block }, noTailscale: true })
    const run = await tula(['dev', 'down'], { host: fake.host })
    expect(run.code).toBe(0)
    expect(run.stderr).toContain('could not be closed')
    expect(fake.docker('compose down')).toHaveLength(1)
  })

  test('what the port serves now is somebody else’s: it is left alone and said', async () => {
    const block = withDevBlock('', {
      TULA_ENVIRONMENT_ID: ENV_ID,
      TULA_PUBLIC_URL: PUBLIC,
      TULA_TUNNEL_TARGET: TARGET,
    })
    const theirs: Served = { web: { '/': { Proxy: 'http://127.0.0.1:8080' } }, funnel: true }
    const fake = fakeHost({ files: { [FILE]: block }, served: theirs })
    const run = await tula(['dev', 'down'], { host: fake.host })
    expect(run.code).toBe(0)
    expect(fake.changes()).toEqual([])
    expect(fake.served()).toEqual(theirs)
    expect(run.stderr).toContain('left alone')
  })

  test.each([
    ['a target that is not this machine', { TULA_TUNNEL_TARGET: 'http://example.com:80' }],
    ['a target with something after the port', { TULA_TUNNEL_TARGET: `${TARGET}/x --flag` }],
    ['no environment', { TULA_ENVIRONMENT_ID: 'nope' }],
  ])('a block that was edited (%s) starts no command built from it', async (_name, edited) => {
    const block = withDevBlock('', {
      TULA_ENVIRONMENT_ID: ENV_ID,
      TULA_PUBLIC_URL: PUBLIC,
      TULA_TUNNEL_TARGET: TARGET,
      ...edited,
    })
    const fake = fakeHost({ files: { [FILE]: block }, served: OURS })
    await tula(['dev', 'down'], { host: fake.host })
    expect(fake.tailscale()).toEqual([])
  })
})

describe('the Tailscale Funnel adapter', () => {
  const key = `${NAME}:443`

  test('nothing configured is nothing served', () => {
    expect(tailscaleFunnel.readStatus('{}')).toEqual({ endpoints: [], taken: false })
    expect(tailscaleFunnel.readStatus('')).toEqual({ endpoints: [], taken: false })
  })

  test('reads the public name, whether the internet reaches it, and where each path goes', () => {
    const status = tailscaleFunnel.readStatus(
      JSON.stringify({
        TCP: { '443': { HTTPS: true }, '8443': { HTTPS: true } },
        Web: {
          'LAPTOP.tail1234.ts.net:443': {
            Handlers: { '/': { Proxy: TARGET }, '/docs': { Path: '/srv/docs' } },
          },
          [`${NAME}:8443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:9' } } },
        },
        AllowFunnel: { 'LAPTOP.tail1234.ts.net:443': true },
      })
    )
    expect(status).toEqual({
      endpoints: [{ host: NAME, public: true, routes: { '/': TARGET, '/docs': null } }],
      taken: false,
    })
  })

  test.each([
    ['not JSON', 'Funnel is not enabled'],
    ['a list', '[]'],
  ])('what cannot be read is not guessed at: %s', (_name, stdout) => {
    expect(tailscaleFunnel.readStatus(stdout)).toBeNull()
  })

  test.each([
    [
      'a name that is no tailnet’s',
      { Web: { 'evil.example:443': { Handlers: { '/': { Proxy: TARGET } } } } },
    ],
    [
      'a name with a line break',
      { Web: { 'a.ts.net\nX=1:443': { Handlers: { '/': { Proxy: TARGET } } } } },
    ],
    ['a session in the foreground', { Foreground: { abc: { TCP: { '443': { HTTPS: true } } } } }],
    ['a TCP forward', { TCP: { '443': { TCPForward: '127.0.0.1:22' } } }],
  ])('the port counts as taken, and no name is taken from it: %s', (_name, config) => {
    const status = tailscaleFunnel.readStatus(JSON.stringify(config))
    expect(status).toEqual({ endpoints: [], taken: true })
    expect(judgeTunnel(status as NonNullable<typeof status>, ROUTES)).toEqual({ kind: 'foreign' })
  })

  test('ours is every path going where this project sends it, and nothing else', () => {
    const routes = Object.fromEntries(ROUTES.map((route) => [route.path, route.target]))
    const ours = { host: NAME, public: true, routes }
    expect(judgeTunnel({ endpoints: [ours], taken: false }, ROUTES)).toEqual({
      kind: 'ours',
      host: NAME,
      public: true,
      missing: [],
    })
    expect(judgeTunnel({ endpoints: [], taken: false }, ROUTES)).toEqual({ kind: 'absent' })
    for (const other of [
      { ...ours, routes: { ...routes, '/': 'http://127.0.0.1:1' } },
      { ...ours, routes: { ...routes, '/': 'http://localhost:53003' } },
      { ...ours, routes: { ...routes, '/mine': TARGET } },
      { ...ours, routes: { ...routes, '/': null } },
    ]) {
      expect(judgeTunnel({ endpoints: [other], taken: false }, ROUTES).kind).toBe('foreign')
    }
    expect(
      judgeTunnel({ endpoints: [ours, { ...ours, host: `b.${NAME}` }], taken: false }, ROUTES).kind
    ).toBe('foreign')
    expect(key).toBe(`${NAME}:443`)
  })
})
