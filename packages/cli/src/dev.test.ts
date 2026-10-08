import { describe, expect, test } from 'bun:test'
import { constants } from 'node:fs'
import { mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AdminFetch } from '@tula/admin'
import { parseDevBlock, withDevBlock, withoutDevBlock } from './dev'
import type { Host, RunOptions, RunResult } from './host'
import { type CliIo, COMMANDS, runCli } from './index'
import { createProcessHost } from './process-host'

const PK = 'tula_pk_dev_devtestpublishable000000000000000000'
const SK = 'tula_sk_dev_devtestsecret00000000000000000000000'
const ENV_ID = '0198c0de-0000-7000-8000-00000000e001'
const CWD = '/work/shop'

interface FakeHostOptions {
  files?: Record<string, string>
  /** Answer a command in the default's place; `undefined` falls through. */
  answer?: (command: readonly string[]) => Partial<RunResult> | Error | undefined
}

/** A host with no Docker: it answers `docker compose` the way a healthy project does. */
function fakeHost(options: FakeHostOptions = {}) {
  const files = new Map(Object.entries(options.files ?? {}))
  const calls: { command: string[]; options: RunOptions }[] = []
  const modes = new Map<string, string>()
  let minted = 0
  const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '', timedOut: false })
  const host: Host = {
    async run(command, runOptions) {
      calls.push({ command: [...command], options: runOptions })
      const custom = options.answer?.(command)
      if (custom instanceof Error) {
        throw custom
      }
      if (custom) {
        return { ...ok(), ...custom }
      }
      const line = command.join(' ')
      if (line.includes('config --services')) {
        return ok('postgres\nredis\nmailpit\nmigrate\napi\n')
      }
      if (line.includes('seed.ts')) {
        return ok(
          `seed: workspace w\nseed: project p\nseed: development environment ${ENV_ID}\nseed: production environment 0198c0de-0000-7000-8000-00000000e002\n`
        )
      }
      if (line.includes('create-api-key.ts')) {
        minted += 1
        return ok(`${line.includes('--kind publishable') ? PK : SK}\n`)
      }
      if (line.includes('port api')) {
        return ok('127.0.0.1:53003\n')
      }
      if (line.includes('port mailpit')) {
        return ok('127.0.0.1:58025\n')
      }
      if (line.startsWith('git check-ignore')) {
        return ok('.env.local\n')
      }
      return ok()
    },
    readFile: async (path) => files.get(path) ?? null,
    writeSecretFile: async (path, text) => {
      files.set(path, text)
      modes.set(path, '0600')
    },
    createSecretFile: async (path, text) => {
      files.set(path, text)
      modes.set(path, '0600')
    },
    removeFile: async (path) => files.delete(path),
    restrictFile: async (path) => {
      const wider = files.has(path) && modes.get(path) !== '0600'
      if (files.has(path)) {
        modes.set(path, '0600')
      }
      return wider
    },
    sleep: async () => {},
  }
  return {
    host,
    files,
    calls,
    modes,
    minted: () => minted,
    lines: () => calls.map((c) => c.command.join(' ')),
  }
}

interface Run {
  code: number
  stdout: string
  stderr: string
}

/** An API that is ready and accepts `SK` (and nothing else). */
const healthyApi: AdminFetch = async (url, init) => {
  const { pathname } = new URL(url)
  if (pathname === '/v1/ready') {
    return Response.json({ status: 'ready', checks: {} })
  }
  const key = new Headers(init?.headers).get('authorization')
  return key === `Bearer ${SK}`
    ? Response.json({ settings: {}, revision: 0, managedBy: null })
    : Response.json({ status: 401, code: 'auth.invalid_key', detail: 'no' }, { status: 401 })
}

async function tula(args: string[], io: Partial<CliIo>): Promise<Run> {
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
  return { code, stdout, stderr }
}

describe('the block tula dev manages in .env.local', () => {
  const vars = { TULA_API_URL: 'http://localhost:3003', TULA_SECRET_KEY: SK }

  test('is added after what the file already has, and read back', () => {
    const text = withDevBlock('MY_OWN=1\n', vars)
    expect(text.startsWith('MY_OWN=1\n')).toBe(true)
    expect(parseDevBlock(text)).toEqual(vars)
  })

  test('is replaced in place, leaving every other line alone', () => {
    const first = withDevBlock('A=1\n', vars)
    const second = withDevBlock(`${first}B=2\n`, { TULA_API_URL: 'http://localhost:9' })
    expect(second).toContain('A=1\n')
    expect(second).toContain('B=2\n')
    expect(parseDevBlock(second)).toEqual({ TULA_API_URL: 'http://localhost:9' })
    expect(second.match(/tula:dev:start/g)).toHaveLength(1)
  })

  // A line of the user's own that quotes the end marker, above the block: the block must
  // still be found, or every run adds another one.
  test('a line that mentions the end marker before the block does not hide the block', () => {
    const mine = '# my note: the block ends at # tula:dev:end\n# tula:dev:end\nA=1\n'
    const first = withDevBlock(mine, vars)
    expect(parseDevBlock(first)).toEqual(vars)
    const second = withDevBlock(first, { TULA_API_URL: 'http://localhost:9' })
    expect(second.match(/^# tula:dev:start$/gm)).toHaveLength(1)
    expect(second.startsWith(mine)).toBe(true)
    expect(parseDevBlock(second)).toEqual({ TULA_API_URL: 'http://localhost:9' })
    expect(withoutDevBlock(second)).toBe(mine)
  })

  test('a marker inside a line of the user’s is not a marker', () => {
    const mine = 'NOTE="see # tula:dev:start"\nA=1\n'
    expect(parseDevBlock(mine)).toBeNull()
    const text = withDevBlock(mine, vars)
    expect(text.startsWith(mine)).toBe(true)
    expect(parseDevBlock(text)).toEqual(vars)
    expect(withoutDevBlock(text)).toBe(mine)
  })

  test('is removed without touching the rest', () => {
    expect(withoutDevBlock(withDevBlock('A=1\n', vars))).toBe('A=1\n')
    expect(withoutDevBlock('A=1\n')).toBe('A=1\n')
    expect(parseDevBlock('A=1\n')).toBeNull()
  })
})

describe('tula dev', () => {
  test('migrates, seeds, starts the API, mints two keys, writes them and prints the URLs', async () => {
    const fake = fakeHost()
    const run = await tula(['dev'], { host: fake.host })
    expect(run.code).toBe(0)
    const lines = fake.lines()
    const index = (part: string) => lines.findIndex((line) => line.includes(part))
    expect(index('docker compose version')).toBe(0)
    expect(index('run --rm migrate')).toBeGreaterThan(index('config --services'))
    expect(index('seed.ts')).toBeGreaterThan(index('run --rm migrate'))
    expect(index('up -d api')).toBeGreaterThan(index('seed.ts'))
    expect(index('--kind publishable')).toBeGreaterThan(index('up -d api'))
    expect(lines.filter((line) => line.includes('create-api-key.ts'))).toHaveLength(2)
    expect(lines.find((line) => line.includes('--kind secret'))).toContain(
      `--environment ${ENV_ID}`
    )

    const written = fake.files.get(`${CWD}/.env.local`) ?? ''
    expect(parseDevBlock(written)).toEqual({
      TULA_API_URL: 'http://localhost:53003',
      TULA_ENVIRONMENT_ID: ENV_ID,
      TULA_PUBLISHABLE_KEY: PK,
      TULA_SECRET_KEY: SK,
      VITE_TULA_API_URL: 'http://localhost:53003',
      VITE_TULA_PUBLISHABLE_KEY: PK,
      NEXT_PUBLIC_TULA_PUBLISHABLE_KEY: PK,
    })
    expect(fake.modes.get(`${CWD}/.env.local`)).toBe('0600')

    expect(run.stdout).toContain('http://localhost:53003')
    expect(run.stdout).toContain('http://localhost:53003/v1/docs')
    expect(run.stdout).toContain('http://localhost:58025')
    expect(run.stdout).toContain(PK)
    // The secret key is in the file, not on the screen.
    expect(run.stdout + run.stderr).not.toContain(SK)
    expect(run.stdout).toContain('.env.local')
  })

  test('every spawn has a timeout and none goes through a shell', async () => {
    const fake = fakeHost()
    await tula(['dev'], { host: fake.host })
    for (const call of fake.calls) {
      expect(call.options.timeoutMs).toBeGreaterThan(0)
      expect(['docker', 'git']).toContain(call.command[0] as string)
    }
  })

  test('--show-keys prints the secret key', async () => {
    const run = await tula(['dev', '--show-keys'], { host: fakeHost().host })
    expect(run.stdout).toContain(SK)
  })

  test('a second run reuses the keys it wrote: nothing is minted', async () => {
    const fake = fakeHost()
    await tula(['dev'], { host: fake.host })
    const before = fake.files.get(`${CWD}/.env.local`)
    expect(fake.minted()).toBe(2)
    const again = await tula(['dev'], { host: fake.host })
    expect(again.code).toBe(0)
    expect(fake.minted()).toBe(2)
    expect(fake.files.get(`${CWD}/.env.local`)).toBe(before)
    expect(again.stdout).toContain('reused')
  })

  test('two runs leave one block when a line of the user’s mentions the end marker', async () => {
    const mine = '# tula:dev:end is where the block stops\nFOO=bar\n'
    const fake = fakeHost({ files: { [`${CWD}/.env.local`]: mine } })
    await tula(['dev'], { host: fake.host })
    const again = await tula(['dev'], { host: fake.host })
    expect(again.code).toBe(0)
    const text = fake.files.get(`${CWD}/.env.local`) ?? ''
    expect(text.match(/^# tula:dev:start$/gm)).toHaveLength(1)
    expect(text.startsWith(mine)).toBe(true)
    expect(fake.minted()).toBe(2)
    expect(again.stdout).toContain('reused')
  })

  test('a file left readable by others is closed even when nothing in it changes', async () => {
    const path = `${CWD}/.env.local`
    const fake = fakeHost()
    const first = await tula(['dev'], { host: fake.host })
    expect(first.stderr).not.toContain('readable by other')
    const before = fake.files.get(path)
    fake.modes.set(path, '0644')

    const again = await tula(['dev'], { host: fake.host })
    expect(again.code).toBe(0)
    expect(fake.files.get(path)).toBe(before)
    expect(fake.modes.get(path)).toBe('0600')
    expect(again.stderr.match(/readable by other/g)).toHaveLength(1)

    const third = await tula(['dev'], { host: fake.host })
    expect(third.stderr).not.toContain('readable by other')
  })

  test('a file of the user’s own with a wider mode is closed when the keys are added', async () => {
    const path = `${CWD}/.env.local`
    const fake = fakeHost({ files: { [path]: 'FOO=bar\n' } })
    fake.modes.set(path, '0644')
    const run = await tula(['dev'], { host: fake.host })
    expect(fake.modes.get(path)).toBe('0600')
    expect(run.stderr).not.toContain('readable by other')
  })

  test('lines the user wrote are never touched, and a key of their own is respected', async () => {
    const mine = 'tula_sk_dev_mineminemineminemineminemineminemine00'
    const fake = fakeHost({
      files: { [`${CWD}/.env.local`]: `# mine\nFOO=bar\nTULA_SECRET_KEY=${mine}\n` },
    })
    const run = await tula(['dev'], { host: fake.host })
    expect(run.code).toBe(0)
    const text = fake.files.get(`${CWD}/.env.local`) ?? ''
    expect(text.startsWith(`# mine\nFOO=bar\nTULA_SECRET_KEY=${mine}\n`)).toBe(true)
    expect(parseDevBlock(text)?.TULA_SECRET_KEY).toBeUndefined()
    expect(fake.lines().some((line) => line.includes('--kind secret'))).toBe(false)
    expect(run.stdout + run.stderr).not.toContain(mine)
  })

  test('keys the stack no longer accepts are reported with the fix, not replaced', async () => {
    const stale = withDevBlock('', {
      TULA_PUBLISHABLE_KEY: PK,
      TULA_SECRET_KEY: 'tula_sk_dev_stalestalestalestalestalestalestale0',
    })
    const fake = fakeHost({ files: { [`${CWD}/.env.local`]: stale } })
    const run = await tula(['dev'], { host: fake.host })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('--rotate-keys')
    expect(fake.files.get(`${CWD}/.env.local`)).toBe(stale)
    expect(fake.minted()).toBe(0)

    const rotated = await tula(['dev', '--rotate-keys'], { host: fake.host })
    expect(rotated.code).toBe(0)
    expect(parseDevBlock(fake.files.get(`${CWD}/.env.local`) ?? '')?.TULA_SECRET_KEY).toBe(SK)
  })

  test('--project-name is passed to every compose call', async () => {
    const fake = fakeHost()
    await tula(['dev', '--project-name', 'shop-test'], { host: fake.host })
    const compose = fake
      .lines()
      .filter((line) => line.startsWith('docker compose') && !line.includes('version'))
    expect(compose.length).toBeGreaterThan(4)
    for (const line of compose) {
      expect(line.startsWith('docker compose -p shop-test ')).toBe(true)
    }
  })

  test('Docker missing: says how to get it', async () => {
    const missing = Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' })
    const run = await tula(['dev'], { host: fakeHost({ answer: () => missing }).host })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('Docker')
    expect(run.stderr).toContain('https://docs.docker.com/get-docker/')
  })

  test('the Docker daemon not running: says to start it', async () => {
    const fake = fakeHost({
      answer: (command) =>
        command.includes('config')
          ? {
              code: 1,
              stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock.',
            }
          : undefined,
    })
    const run = await tula(['dev'], { host: fake.host })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('Docker is not running')
  })

  test('no Compose file, or one without an api service: says where tula dev belongs', async () => {
    const none = await tula(['dev'], {
      host: fakeHost({
        answer: (command) =>
          command.includes('config')
            ? { code: 1, stderr: 'no configuration file provided: not found' }
            : undefined,
      }).host,
    })
    expect(none.code).toBe(1)
    expect(none.stderr).toContain('create-tula')

    const noApi = await tula(['dev'], {
      host: fakeHost({
        answer: (command) =>
          command.includes('--services') ? { stdout: 'postgres\nredis\n' } : undefined,
      }).host,
    })
    expect(noApi.code).toBe(1)
    expect(noApi.stderr).toContain('api')
  })

  test('a failing migration stops the run and shows the tail of what Docker said', async () => {
    const fake = fakeHost({
      answer: (command) =>
        command.includes('migrate')
          ? { code: 1, stderr: 'line 1\nrelation "x" already exists\n' }
          : undefined,
    })
    const run = await tula(['dev'], { host: fake.host })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('migrations')
    expect(run.stderr).toContain('already exists')
    expect(fake.lines().some((line) => line.includes('seed.ts'))).toBe(false)
  })

  test('a step that runs past its timeout is reported as such', async () => {
    const fake = fakeHost({
      answer: (command) =>
        command.includes('migrate') ? { code: null, timedOut: true } : undefined,
    })
    const run = await tula(['dev'], { host: fake.host })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('timed out')
  })

  test('an API that never becomes ready fails with the logs command', async () => {
    const run = await tula(['dev', '--timeout', '3'], {
      host: fakeHost().host,
      fetch: async () => new Response('', { status: 503 }),
    })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('docker compose logs api')
  })

  test('a minted key that is not a key is refused and never printed', async () => {
    const junk = 'error: something odd CANARY-output'
    const fake = fakeHost({
      answer: (command) =>
        command.join(' ').includes('--kind secret') ? { stdout: junk } : undefined,
    })
    const run = await tula(['dev'], { host: fake.host })
    expect(run.code).toBe(1)
    expect(run.stdout + run.stderr).not.toContain('CANARY')
  })

  test('warns when .env.local is not ignored by git', async () => {
    const fake = fakeHost({
      answer: (command) => (command[0] === 'git' ? { code: 1 } : undefined),
    })
    const run = await tula(['dev'], { host: fake.host })
    expect(run.code).toBe(0)
    expect(run.stderr).toContain('.gitignore')
  })

  test('Ctrl-C during a step says how to continue or stop', async () => {
    const aborted = Object.assign(new Error('interrupted'), { code: 'ABORT' })
    const run = await tula(['dev'], {
      host: fakeHost({ answer: (command) => (command.includes('migrate') ? aborted : undefined) })
        .host,
    })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('Interrupted')
    expect(run.stderr).toContain('tula dev down')
  })

  test('a failure of the host itself is reported, not swallowed', async () => {
    const run = await tula(['dev'], {
      host: fakeHost({ answer: () => new Error('EPERM spawn') }).host,
    })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('unexpected failure')
  })

  test('a seed that reports no environment, or an API that publishes no port, stops the run', async () => {
    const noEnvironment = await tula(['dev'], {
      host: fakeHost({
        answer: (command) =>
          command.join(' ').includes('seed.ts') ? { stdout: 'seed: nothing\n' } : undefined,
      }).host,
    })
    expect(noEnvironment.code).toBe(1)
    expect(noEnvironment.stderr).toContain('development environment')

    const noPort = await tula(['dev'], {
      host: fakeHost({
        answer: (command) => (command.join(' ').includes('port api') ? { code: 1 } : undefined),
      }).host,
    })
    expect(noPort.code).toBe(1)
    expect(noPort.stderr).toContain('does not publish')
  })

  test('an API that answers something other than "wrong key" to the key check is an error', async () => {
    const fake = fakeHost({
      files: {
        [`${CWD}/.env.local`]: withDevBlock('', { TULA_PUBLISHABLE_KEY: PK, TULA_SECRET_KEY: SK }),
      },
    })
    const run = await tula(['dev'], {
      host: fake.host,
      fetch: async (url) =>
        new URL(url).pathname === '/v1/ready'
          ? Response.json({ status: 'ready' })
          : Response.json({ status: 500, code: 'internal', detail: 'x' }, { status: 500 }),
    })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('internal')
    expect(fake.minted()).toBe(0)
  })

  test('a key of the user’s own that the stack refuses is warned about and left alone', async () => {
    const mine = 'tula_sk_dev_refusedrefusedrefusedrefusedrefused00'
    const fake = fakeHost({ files: { [`${CWD}/.env.local`]: `TULA_SECRET_KEY="${mine}"\n` } })
    const run = await tula(['dev'], { host: fake.host })
    expect(run.code).toBe(0)
    expect(run.stderr).toContain('not accepted')
    expect(fake.files.get(`${CWD}/.env.local`)?.startsWith(`TULA_SECRET_KEY="${mine}"\n`)).toBe(
      true
    )
    expect(run.stdout + run.stderr).not.toContain(mine)
  })

  test.each([
    [['dev', '--timeout', 'soon'], '--timeout'],
    [['dev', '--project-name', 'Bad Name'], '--project-name'],
    [['dev', '--volumes'], 'tula dev down'],
  ])('%j is a usage error', async (args, text) => {
    const fake = fakeHost()
    const run = await tula(args, { host: fake.host })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain(text)
    expect(fake.calls).toHaveLength(0)
  })

  test('survives what is optional: no Mailpit port, no git, an API that is slow to answer', async () => {
    const fake = fakeHost({
      answer: (command) =>
        command.join(' ').includes('port mailpit') || command[0] === 'git'
          ? Object.assign(new Error('missing'), { code: 'ENOENT' })
          : undefined,
    })
    let asked = 0
    const run = await tula(['dev'], {
      host: fake.host,
      fetch: async (url, init) => {
        if (new URL(url).pathname === '/v1/ready') {
          asked += 1
          if (asked === 1) {
            throw new TypeError('fetch failed')
          }
        }
        return healthyApi(url, init)
      },
    })
    expect(run.code).toBe(0)
    expect(asked).toBe(2)
    expect(run.stdout).not.toContain('Mailpit')
    expect(run.stderr).toBe('')
  })

  test('needs a host: without one it is a usage error', async () => {
    const run = await tula(['dev'], {})
    expect(run.code).toBe(1)
  })
})

describe('tula dev down', () => {
  test('stops the stack and keeps the data and the keys', async () => {
    const files = { [`${CWD}/.env.local`]: withDevBlock('A=1\n', { TULA_SECRET_KEY: SK }) }
    const fake = fakeHost({ files })
    const run = await tula(['dev', 'down'], { host: fake.host })
    expect(run.code).toBe(0)
    expect(fake.lines()).toContain('docker compose down')
    expect(fake.files.get(`${CWD}/.env.local`)).toBe(files[`${CWD}/.env.local`])
  })

  test('--volumes asks first; "no" changes nothing', async () => {
    const fake = fakeHost()
    const run = await tula(['dev', 'down', '--volumes'], {
      host: fake.host,
      isTTY: true,
      prompt: async () => 'n',
    })
    expect(run.code).toBe(1)
    expect(fake.lines().some((line) => line.includes('down'))).toBe(false)
  })

  test('--volumes without a terminal needs --yes', async () => {
    const fake = fakeHost()
    const run = await tula(['dev', 'down', '--volumes'], { host: fake.host })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('--yes')
    expect(fake.lines().some((line) => line.includes('down'))).toBe(false)
  })

  test('--volumes --yes wipes the data and removes the keys it wrote, nothing else', async () => {
    const fake = fakeHost({
      files: { [`${CWD}/.env.local`]: withDevBlock('A=1\n', { TULA_SECRET_KEY: SK }) },
    })
    const run = await tula(['dev', 'down', '--volumes', '--yes', '--project-name', 'shop-test'], {
      host: fake.host,
    })
    expect(run.code).toBe(0)
    expect(fake.lines()).toContain('docker compose -p shop-test down --volumes')
    expect(fake.files.get(`${CWD}/.env.local`)).toBe('A=1\n')
  })

  test('an unknown subcommand is a usage error', async () => {
    const run = await tula(['dev', 'up'], { host: fakeHost().host })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('tula dev')
  })
})

describe('tula dev and a .env.local that is not a regular file (F1)', () => {
  test.if(process.platform !== 'win32')(
    'a named pipe at .env.local is refused at once, never read',
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'tula-dev-pipe-'))
      const pipe = join(cwd, '.env.local')
      try {
        // One process, with a timeout of its own.
        expect(Bun.spawnSync(['mkfifo', pipe], { timeout: 5_000 }).exitCode).toBe(0)
        // No Docker, but the real file system: the read is the real host's.
        const real = createProcessHost({})
        const host: Host = { ...fakeHost().host, readFile: real.readFile }
        let timer: ReturnType<typeof setTimeout> | undefined
        const work = tula(['dev'], { host, cwd })
        const run = await Promise.race([
          work,
          new Promise<'hung'>((resolve) => {
            timer = setTimeout(() => resolve('hung'), 2_000)
          }),
        ])
        clearTimeout(timer)
        if (run === 'hung') {
          // Let the read go, so the test leaves nothing waiting.
          const writer = await open(pipe, constants.O_WRONLY | constants.O_NONBLOCK).catch(
            () => undefined
          )
          await writer?.close()
          await work.catch(() => undefined)
          throw new Error('tula dev waited on the named pipe')
        }
        expect(run.code).toBe(1)
        expect(run.stderr).toContain('.env.local is not a regular file')
      } finally {
        await rm(cwd, { recursive: true, force: true })
      }
    }
  )
})
