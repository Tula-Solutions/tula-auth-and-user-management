import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs, UsageError } from './args'
import { type CliIo, type Command, EXIT, runCli } from './framework'
import { COMMANDS, main, VERSION } from './index'
import { createOutput, shouldUseColor } from './output'
import { createFakeApi, type FakeApi } from './testing/fake-api'

const BASE_URL = 'https://auth.example.test'
const SECRET_KEY = 'tula_sk_dev_cliunit0000000000000000000000000000'
const GOOGLE_SECRET = 'google-secret-unit-Mn44-do-not-print'

let dir: string
let api: FakeApi
let files = 0

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tula-cli-unit-'))
  api = createFakeApi(BASE_URL)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function configFile(environments: Record<string, unknown>, name?: string): Promise<string> {
  files += 1
  const path = join(dir, name ?? `tula-${files}.config.ts`)
  await writeFile(path, `export default ${JSON.stringify({ environments })}\n`)
  return path
}

interface Run {
  code: number
  stdout: string
  stderr: string
}

async function tula(
  args: string[],
  io: Partial<CliIo> = {},
  commands: readonly Command[] = COMMANDS
): Promise<Run> {
  let stdout = ''
  let stderr = ''
  const code = await runCli(
    args,
    {
      stdout: { write: (text) => (stdout += text) },
      stderr: { write: (text) => (stderr += text) },
      env: {
        TULA_API_URL: BASE_URL,
        TULA_SECRET_KEY: SECRET_KEY,
        GOOGLE_CLIENT_SECRET: GOOGLE_SECRET,
      },
      cwd: dir,
      isTTY: false,
      fetch: api.fetch,
      ...io,
    },
    commands
  )
  return { code, stdout, stderr }
}

const writes = () => api.requests.filter((request) => !request.startsWith('GET '))
const google = { clientId: 'g-client', clientSecret: { $env: 'GOOGLE_CLIENT_SECRET' } }

describe('parseArgs', () => {
  const options = {
    env: { type: 'string', short: 'e', description: '' },
    yes: { type: 'boolean', short: 'y', description: '' },
  } as const

  test.each([
    [['--env', 'prod'], { env: 'prod' }, []],
    [['--env=prod'], { env: 'prod' }, []],
    [['-e', 'prod', '-y'], { env: 'prod', yes: true }, []],
    [['--yes', 'extra'], { yes: true }, ['extra']],
    [['--', '--env', 'x'], {}, ['--env', 'x']],
    [['-'], {}, ['-']],
    [['--env=a=b'], { env: 'a=b' }, []],
  ] as [string[], Record<string, unknown>, string[]][])('%p', (argv, flags, positionals) => {
    expect(parseArgs(argv, options)).toEqual({ flags, positionals } as never)
  })

  test.each([
    [['--nope'], 'Unknown option --nope.'],
    [['-x'], 'Unknown option -x.'],
    [['--env'], '--env needs a value.'],
    [['--env', '--yes'], '--env needs a value.'],
    [['--yes=1'], '--yes takes no value.'],
    [['--constructor'], 'Unknown option --constructor.'],
  ] as [string[], string][])('%p is refused: %s', (argv, message) => {
    expect(() => parseArgs(argv, options)).toThrow(new UsageError(message))
  })

  test.each([
    ['--secret-key', ['--secret-key', SECRET_KEY]],
    ['--secret-key=…', [`--secret-key=${SECRET_KEY}`]],
    ['--token', ['--token', SECRET_KEY]],
  ])('%s does not exist, the error says why, and the value is not repeated', (_name, argv) => {
    let message = ''
    try {
      parseArgs(argv, options)
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('shell history')
    expect(message).toContain('--secret-key-file')
    expect(message).not.toContain(SECRET_KEY)
  })

  test('an unknown option’s value is never repeated', () => {
    expect(() => parseArgs([`--password=${SECRET_KEY}`], options)).toThrow(
      'Unknown option --password.'
    )
  })
})

describe('output', () => {
  test.each([
    ['a terminal', { isTTY: true }, {}, true],
    ['a pipe', { isTTY: false }, {}, false],
    ['NO_COLOR', { isTTY: true }, { NO_COLOR: '1' }, false],
    ['an empty NO_COLOR', { isTTY: true }, { NO_COLOR: '' }, true],
    ['a dumb terminal', { isTTY: true }, { TERM: 'dumb' }, false],
  ])('colour on %s', (_name, sink, env, expected) => {
    expect(shouldUseColor({ write: () => {}, ...sink }, env)).toBe(expected)
  })

  test('styles wrap text only when colour is on', () => {
    const plain = createOutput({ write: () => {} }, { write: () => {} }, {})
    expect(plain.style.green('x')).toBe('x')
    const coloured = createOutput({ write: () => {}, isTTY: true }, { write: () => {} }, {})
    expect(coloured.style.green('x')).toBe('\u001b[32mx\u001b[39m')
    expect(coloured.style.red('x')).toContain('\u001b[31m')
    expect(coloured.style.yellow('x')).toContain('\u001b[33m')
    expect(coloured.style.dim('x')).toContain('\u001b[2m')
    expect(coloured.style.bold('x')).toContain('\u001b[1m')
    // Each stream decides for itself: standard error here is not a terminal.
    expect(coloured.errorStyle.red('x')).toBe('x')
  })

  test('a registered secret is replaced in everything written afterwards, on both streams', () => {
    let out = ''
    let err = ''
    const output = createOutput({ write: (t) => (out += t) }, { write: (t) => (err += t) }, {})
    const pem =
      '-----BEGIN PRIVATE KEY-----\nMIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkw\n-----END PRIVATE KEY-----'
    output.redact(SECRET_KEY)
    output.redact(pem)
    output.redact('abc')
    output.line(`key ${SECRET_KEY} abc`)
    output.error(`failed: Bearer ${SECRET_KEY}`)
    output.error('line MIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkw of a key')
    output.line()
    expect(out).toBe('key [redacted] abc\n\n')
    expect(err).toBe('failed: Bearer [redacted]\nline [redacted] of a key\n')
  })
})

describe('runCli', () => {
  test('--version prints the version, which is the package’s', async () => {
    const manifest = (await Bun.file(join(import.meta.dir, '../package.json')).json()) as {
      version: string
    }
    expect(VERSION).toBe(manifest.version)
    expect(await tula(['--version'])).toEqual({ code: 0, stdout: `${VERSION}\n`, stderr: '' })
  })

  test('--help lists the commands; no command at all is an error with the same list', async () => {
    const help = await tula(['--help'])
    expect(help.code).toBe(0)
    expect(help.stdout).toContain('Usage: tula <command> [options]')
    expect(help.stdout).toContain('diff ')
    expect(help.stdout).toContain('apply')
    expect((await tula([])).code).toBe(1)
  })

  test('a command’s --help shows its usage, options and exit codes', async () => {
    const help = await tula(['diff', '--help'])
    expect(help.code).toBe(0)
    expect(help.stdout).toContain('Usage: tula diff')
    expect(help.stdout).toContain('-e, --env <name>')
    expect(help.stdout).toContain('--secret-key-file <path>')
    expect(help.stdout).toContain('Exit codes: 0 no changes, 2 changes pending, 1 an error.')
    expect(api.requests).toEqual([])
  })

  test('an unknown command is an error; an option in its place is not repeated', async () => {
    const unknown = await tula(['frobnicate'])
    expect(unknown.code).toBe(1)
    expect(unknown.stderr).toContain('"frobnicate" is not a tula command')
    const option = await tula([`--secret-key=${SECRET_KEY}`, 'diff'])
    expect(option.code).toBe(1)
    expect(option.stderr).not.toContain(SECRET_KEY)
  })

  test('a command takes options only', async () => {
    const run = await tula(['diff', 'prod'])
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('takes no arguments')
  })

  test('a command slots in as an object, and what it throws becomes a message and exit 1', async () => {
    const hello: Command = {
      name: 'hello',
      summary: 'Say hello.',
      usage: 'tula hello',
      options: { loud: { type: 'boolean', description: 'Shout.' } },
      run: async ({ output, flags }) => {
        if (flags.loud) {
          throw new TypeError(`boom with ${SECRET_KEY}`)
        }
        output.line('hello')
        return EXIT.ok
      },
    }
    expect(await tula(['hello'], {}, [hello])).toEqual({ code: 0, stdout: 'hello\n', stderr: '' })
    const failed = await tula(['hello', '--loud'], {}, [hello])
    expect(failed.code).toBe(1)
    expect(failed.stderr).toContain('unexpected failure (TypeError: boom')
    const thrown = await tula(['hello'], {}, [{ ...hello, run: () => Promise.reject('a string') }])
    expect(thrown.stderr).toContain('unexpected failure (an unknown error)')
  })

  test('main runs the same commands with the process’s own surroundings', async () => {
    let stdout = ''
    const code = await main(['--version'], { stdout: { write: (text) => (stdout += text) } })
    expect(code).toBe(0)
    expect(stdout).toBe(`${VERSION}\n`)
  })
})

describe('the target', () => {
  test('the URL and key of the named environment win over the general ones', async () => {
    const config = await configFile({ 'prod-eu': {}, dev: {} })
    const other = createFakeApi('https://eu.example.test')
    const run = await tula(['diff', '--config', config, '--env', 'prod-eu'], {
      fetch: other.fetch,
      env: {
        TULA_API_URL: BASE_URL,
        TULA_SECRET_KEY: 'tula_sk_dev_generalkey0000000000000000000000',
        TULA_API_URL_PROD_EU: 'https://eu.example.test/',
        TULA_SECRET_KEY_PROD_EU: SECRET_KEY,
      },
    })
    expect(run.code).toBe(2)
    expect(run.stdout).toContain('Environment "prod-eu" at https://eu.example.test')
    expect(other.headers[0]?.get('authorization')).toBe(`Bearer ${SECRET_KEY}`)
    expect(other.headers[0]?.get('user-agent')).toBe(`tula-cli/${VERSION}`)
  })

  test('--api-url wins over the environment', async () => {
    const config = await configFile({ dev: {} })
    const run = await tula(['diff', '--config', config, '--api-url', BASE_URL], {
      env: { TULA_API_URL: 'https://wrong.example.test', TULA_SECRET_KEY: SECRET_KEY },
    })
    expect(run.code).toBe(2)
  })

  test('the key can come from a file or from standard input, trimmed', async () => {
    const config = await configFile({ dev: {} })
    const asked: string[] = []
    const fromFile = await tula(['diff', '--config', config, '--secret-key-file', 'key.txt'], {
      env: { TULA_API_URL: BASE_URL },
      readFile: async (path) => {
        asked.push(path)
        return `${SECRET_KEY}\n`
      },
    })
    expect(fromFile.code).toBe(2)
    expect(asked).toEqual(['key.txt'])
    expect(api.headers.at(-1)?.get('authorization')).toBe(`Bearer ${SECRET_KEY}`)
    const fromStdin = await tula(['diff', '--config', config, '--secret-key-file', '-'], {
      env: { TULA_API_URL: BASE_URL },
      readStdin: async () => ` ${SECRET_KEY} \n`,
    })
    expect(fromStdin.code).toBe(2)
  })

  test.each([
    ['a file that cannot be read', ['--secret-key-file', 'missing.txt'], 'Could not read the file'],
    [
      'standard input that cannot be read',
      ['--secret-key-file', '-'],
      'Could not read the secret key from standard input',
    ],
  ])('%s is an error that names no path content', async (_name, flags, message) => {
    const config = await configFile({ dev: {} })
    const run = await tula(['diff', '--config', config, ...flags], {
      readFile: () => Promise.reject(new Error('ENOENT')),
      readStdin: () => Promise.reject(new Error('closed')),
    })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain(message)
    expect(api.requests).toEqual([])
  })

  test('where nothing can read a key file, the option says so', async () => {
    const config = await configFile({ dev: {} })
    const run = await tula(['diff', '--config', config, '--secret-key-file', 'key.txt'])
    expect(run.stderr).toContain('--secret-key-file cannot be read here')
  })

  test.each([
    [
      'no key',
      { TULA_API_URL: BASE_URL },
      'No secret key: set TULA_SECRET_KEY (or TULA_SECRET_KEY_DEV)',
    ],
    ['a blank key', { TULA_API_URL: BASE_URL, TULA_SECRET_KEY: '  ' }, 'No secret key'],
    [
      'no URL',
      { TULA_SECRET_KEY: SECRET_KEY },
      'No API URL: set TULA_API_URL (or TULA_API_URL_DEV)',
    ],
    [
      'a publishable key',
      { TULA_API_URL: BASE_URL, TULA_SECRET_KEY: 'tula_pk_dev_abcdefghijklmnopqrstuvwx' },
      'client.publishable_key',
    ],
    [
      'a URL that is not one',
      { TULA_API_URL: 'auth.example.test', TULA_SECRET_KEY: SECRET_KEY },
      'client.invalid_url',
    ],
  ])('%s stops the run before any request', async (_name, env, message) => {
    const config = await configFile({ dev: {} })
    const run = await tula(['diff', '--config', config], { env })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain(message)
    expect(api.requests).toEqual([])
  })

  test('the default config file is tula.config.ts in the working directory', async () => {
    await configFile({ dev: { settings: { app: { name: 'Default file' } } } }, 'tula.config.ts')
    const run = await tula(['diff'])
    expect(run.code).toBe(2)
    expect(run.stdout).toContain('"Default file"')
    const missing = await tula(['diff', '--config', 'elsewhere.config.ts'])
    expect(missing.code).toBe(1)
    expect(missing.stderr).toContain('There is no config file at')
  })

  test('with several environments the name is required, and an unknown one lists them', async () => {
    const config = await configFile({ dev: {}, prod: {} })
    expect((await tula(['diff', '--config', config])).stderr).toContain(
      'say which with --env <name>'
    )
    expect((await tula(['diff', '--config', config, '--env', 'staging'])).stderr).toContain(
      'It has: dev, prod.'
    )
  })
})

describe('diff', () => {
  test('prints every kind of change, the kept fields, providers and warnings', async () => {
    api.revision = 4
    api.settings.urls.allowedOrigins = ['https://old.example.test', 'https://keep.example.test']
    api.settings.mfa.policy = 'required'
    api.settings.sessions.profiles.old = structuredClone(api.settings.sessions.profiles.web)
    ;(api.settings as unknown as Record<string, unknown>).future = { feature: true }
    api.managedBy = {
      tool: 'terraform',
      configHash: `sha256:${'0'.repeat(64)}`,
      at: 'x',
      revision: 4,
    }
    api.providers.set('github', {
      clientId: 'gh',
      teamId: null,
      keyId: null,
      enabled: true,
      secret: 's',
    })
    api.providers.set('apple', {
      clientId: 'a',
      teamId: 'T',
      keyId: 'K',
      enabled: true,
      secret: 's',
    })
    const config = await configFile({
      dev: {
        settings: {
          app: { name: 'Northline' },
          urls: { allowedOrigins: ['https://keep.example.test', 'https://new.example.test'] },
          sessions: { profiles: { kiosk: { idleTimeout: '5m' } } },
        },
        providers: {
          google,
          github: {
            clientId: 'gh-2',
            clientSecret: { $env: 'GITHUB_CLIENT_SECRET' },
            enabled: false,
          },
          apple: {
            clientId: 'a',
            teamId: 'T',
            keyId: 'K',
            privateKey: { $env: 'APPLE_PRIVATE_KEY' },
          },
        },
      },
    })
    const run = await tula(['diff', '--config', config])
    expect(run.code).toBe(2)
    expect(run.stdout).toContain(`Environment "dev" at ${BASE_URL} (settings revision 4)`)
    expect(run.stdout).toContain('  ~ app.name: "Tula" → "Northline"')
    expect(run.stdout).toContain(
      '  ~ urls.allowedOrigins: +"https://new.example.test" -"https://old.example.test"'
    )
    expect(run.stdout).toContain('  ~ mfa.policy: "required" → "optional"')
    expect(run.stdout).toContain('  + sessions.profiles.kiosk: {')
    expect(run.stdout).toContain('…')
    expect(run.stdout).toContain('  - sessions.profiles.old: {')
    expect(run.stdout).toContain('  - future: {"feature":true}')
    expect(run.stdout).toContain('  ~ managed-by record: another tool is on record')
    expect(run.stdout).toContain('  kept as on the server (not in the file): password')
    expect(run.stdout).toContain('  = apple: unchanged')
    expect(run.stdout).toContain(
      '  ~ github: update (clientId "gh" → "gh-2", enabled true → false, secret set from $GITHUB_CLIENT_SECRET)'
    )
    expect(run.stdout).toContain(
      '  + google: create (clientId "g-client", enabled true, secret set from $GOOGLE_CLIENT_SECRET)'
    )
    expect(run.stdout).toContain('  ! weakens security: mfa.policy')
    expect(run.stdout).toContain('  ! another tool is on record as managing these settings')
    expect(run.stdout).toContain(
      '  ! the server has settings this version of tula does not know (future)'
    )
    expect(writes()).toEqual([])
  })

  test('drift is warned about even when the file has changed since it was last applied', async () => {
    api.revision = 5
    api.managedBy = {
      tool: 'tula-apply',
      configHash: `sha256:${'0'.repeat(64)}`,
      at: 'x',
      revision: 3,
    }
    const config = await configFile({ dev: {} })
    const run = await tula(['diff', '--config', config])
    expect(run.code).toBe(2)
    expect(run.stdout).toContain(
      '  ! the settings were changed outside the config file since the last apply'
    )
  })

  test('switching a provider on keeps the stored secret, and says so', async () => {
    api.providers.set('google', {
      clientId: 'g-client',
      teamId: null,
      keyId: null,
      enabled: false,
      secret: 's',
    })
    const config = await configFile({ dev: { providers: { google } } })
    const run = await tula(['diff', '--config', config])
    expect(run.stdout).toContain('  ~ google: update (enabled false → true, stored secret kept)')
  })

  test('on a terminal the plan is coloured, and NO_COLOR turns that off', async () => {
    const config = await configFile({ dev: { settings: { app: { name: 'Northline' } } } })
    const env = { TULA_API_URL: BASE_URL, TULA_SECRET_KEY: SECRET_KEY }
    let coloured = ''
    await runCli(
      ['diff', '--config', config],
      {
        stdout: { write: (t) => (coloured += t), isTTY: true },
        stderr: { write: () => {} },
        env,
        cwd: dir,
        isTTY: true,
        fetch: api.fetch,
      },
      COMMANDS
    )
    expect(coloured).toContain('\u001b[33m  ~ app.name')
    let plain = ''
    await runCli(
      ['diff', '--config', config],
      {
        stdout: { write: (t) => (plain += t), isTTY: true },
        stderr: { write: () => {} },
        env: { ...env, NO_COLOR: '1' },
        cwd: dir,
        isTTY: true,
        fetch: api.fetch,
      },
      COMMANDS
    )
    expect(plain).not.toContain('\u001b[')
  })

  test('an older server that reports no manager is diffed on its settings alone', async () => {
    api.legacy = true
    const config = await configFile({ dev: {} })
    const run = await tula(['diff', '--config', config, '--json'])
    expect(run.code).toBe(0)
    expect(JSON.parse(run.stdout)).toMatchObject({
      changes: false,
      managedBy: { supported: false, pending: false },
      warnings: [],
    })
  })
})

describe('apply', () => {
  test('records the config as the manager, and sends no marker to a server without one', async () => {
    const config = await configFile({ dev: { settings: { app: { name: 'Northline' } } } })
    expect((await tula(['apply', '--config', config, '-y'])).code).toBe(0)
    expect(api.managedBy).toMatchObject({ tool: 'tula-apply', revision: 1 })
    expect(api.managedBy?.configHash).toMatch(/^sha256:[0-9a-f]{64}$/)

    api = createFakeApi(BASE_URL)
    api.legacy = true
    expect((await tula(['apply', '--config', config, '-y'])).code).toBe(0)
    const put = api.headers[api.requests.indexOf('PUT /v1/admin/settings')]
    expect(put?.get('if-match')).toBe('"0"')
    expect(put?.has('x-tula-managed-by')).toBe(false)
  })

  test('at a terminal a yes applies, and the question names the target', async () => {
    const config = await configFile({ dev: { settings: { app: { name: 'Northline' } } } })
    const run = await tula(['apply', '--config', config], {
      isTTY: true,
      prompt: async () => ' YES ',
    })
    expect(run.code).toBe(0)
    expect(api.settings.app.name).toBe('Northline')
  })

  test('a terminal without a way to ask is treated as no terminal', async () => {
    const config = await configFile({ dev: { settings: { app: { name: 'Northline' } } } })
    const run = await tula(['apply', '--config', config], { isTTY: true })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('pass --yes')
  })

  test('--rotate-secrets writes the secret of a provider that did not change', async () => {
    api.providers.set('google', {
      clientId: 'g-client',
      teamId: null,
      keyId: null,
      enabled: true,
      secret: 'old',
    })
    const config = await configFile({ dev: { providers: { google } } })
    await tula(['apply', '--config', config, '-y'])
    expect(api.providers.get('google')?.secret).toBe('old')
    const run = await tula(['apply', '--config', config, '-y', '--rotate-secrets'])
    expect(run.code).toBe(0)
    expect(api.providers.get('google')?.secret).toBe(GOOGLE_SECRET)
    expect(run.stdout + run.stderr).not.toContain(GOOGLE_SECRET)
  })

  test('Apple is written with its team, key id and private key', async () => {
    const config = await configFile({
      dev: {
        providers: {
          apple: {
            clientId: 'a',
            teamId: 'T',
            keyId: 'K',
            privateKey: { $env: 'APPLE_PRIVATE_KEY' },
          },
        },
      },
    })
    const run = await tula(['apply', '--config', config, '-y'], {
      env: {
        TULA_API_URL: BASE_URL,
        TULA_SECRET_KEY: SECRET_KEY,
        APPLE_PRIVATE_KEY: 'pem-content-do-not-print',
      },
    })
    expect(run.code).toBe(0)
    expect(api.providers.get('apple')).toEqual({
      clientId: 'a',
      teamId: 'T',
      keyId: 'K',
      enabled: true,
      secret: 'pem-content-do-not-print',
    })
  })

  test('when providers go first, a revision that moved is caught before any of them is written', async () => {
    const config = await configFile({
      dev: {
        settings: { signIn: { methods: { password: { enabled: false } } } },
        providers: { google },
      },
    })
    const run = await tula(['apply', '--config', config], {
      isTTY: true,
      prompt: async () => {
        api.revision = 9
        return 'yes'
      },
    })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('changed by someone else after this plan was made')
    expect(writes()).toEqual([])
  })

  test('and if it moves after that look, the replace is refused and the report says what was written', async () => {
    const config = await configFile({
      dev: {
        settings: { signIn: { methods: { password: { enabled: false } } } },
        providers: { google },
      },
    })
    api.intercept = (method, path) => {
      if (method === 'PUT' && path.endsWith('/google')) {
        // A colleague saves right after the provider is written.
        queueMicrotask(() => {
          api.revision = 9
        })
      }
      return undefined
    }
    const run = await tula(['apply', '--config', config, '-y'])
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('changed by someone else after this plan was made')
    expect(run.stderr).toContain('Applied before the failure:\n  provider google: create')
    expect(run.stderr).toContain('Not applied:\n  settings: replace')
    expect(run.stderr).toContain('Run `tula apply` again to finish')
    expect(api.settings.signIn.methods.password.enabled).toBe(true)
  })

  test('--expect-revision must be a revision', async () => {
    const config = await configFile({ dev: {} })
    const run = await tula(['apply', '--config', config, '-y', '--expect-revision', 'latest'])
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('--expect-revision takes a revision number')
    expect(api.requests).toEqual([])
  })

  test('--json reports a failure as data: what was applied, what failed, what was not', async () => {
    const config = await configFile({
      dev: { settings: { app: { name: 'Northline' } }, providers: { google } },
    })
    api.intercept = (method, path) =>
      method === 'PUT' && path.endsWith('/google')
        ? Response.json(
            { status: 429, code: 'rate_limited', detail: 'Too many requests.' },
            { status: 429 }
          )
        : undefined
    const run = await tula(['apply', '--config', config, '-y', '--json'])
    expect(run.code).toBe(1)
    expect(JSON.parse(run.stdout)).toMatchObject({
      applied: ['settings: replace'],
      failed: 'provider google: create',
      notApplied: [],
      revisionAfter: 1,
    })
    expect(run.stderr).toContain('rate_limited')

    api.intercept = undefined
    const nothing = await tula(['apply', '--config', config, '-y', '--json'])
    expect(nothing.code).toBe(0)
    expect(JSON.parse(nothing.stdout)).toMatchObject({
      applied: ['provider google: create'],
      failed: null,
    })
    const noop = await tula(['apply', '--config', config, '-y', '--json'])
    expect(JSON.parse(noop.stdout)).toMatchObject({ changes: false, applied: [], failed: null })
  })
})
