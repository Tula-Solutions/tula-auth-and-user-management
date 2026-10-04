import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AdminFetch } from '@tula/admin'
import type { EnvironmentConfigInput } from '@tula/config'
import { createApp } from '../../../apps/api/src/index'
import { createTestDeps, seedApiKey, type TestDeps } from '../../../apps/api/src/testing'
import { type CliIo, COMMANDS, runCli } from './index'

// The real `tula` entry (`runCli` with its real commands) against the real API in process:
// memory adapters, `fetch` handed straight to the app, and a config file on disk that is
// loaded the way an operator's is. Every run's output is kept, and the last test checks that
// no secret that passed through any of them was ever printed.

const SECRET_KEY = 'tula_sk_dev_clitest0000000000000000000000000000'
const BASE_URL = 'http://localhost:3003'
const GOOGLE_SECRET = 'google-client-secret-Zx81-do-not-print'
const GITHUB_SECRET = 'github-client-secret-Qp27-do-not-print'

/** A real P-256 key in PKCS#8 PEM, as Apple's `.p8` file holds: the API checks that it is one. */
async function applePrivateKey(): Promise<{ pem: string; body: string }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
  ])
  const body = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString(
    'base64'
  )
  return { pem: `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`, body }
}

const APPLE = await applePrivateKey()
const APPLE_KEY = APPLE.pem
const SECRETS = [SECRET_KEY, GOOGLE_SECRET, GITHUB_SECRET, APPLE.pem, APPLE.body]

let deps: TestDeps
let app: ReturnType<typeof createApp>
let dir: string
let files = 0
const everythingPrinted: string[] = []

beforeEach(async () => {
  deps = createTestDeps()
  await seedApiKey(deps, SECRET_KEY)
  app = createApp(deps)
  dir = await mkdtemp(join(tmpdir(), 'tula-cli-test-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** A reference to a secret, as `env('NAME')` produces it. */
const env = (name: string) => ({ $env: name })

/**
 * Write a config file. A plain object export, so the file needs no import and can live in a
 * temp directory; `loadConfig` validates it exactly as it does `defineConfig`'s result.
 */
async function configFile(environments: Record<string, unknown>): Promise<string> {
  files += 1
  const path = join(dir, `tula-${files}.config.ts`)
  await writeFile(path, `export default ${JSON.stringify({ environments })}\n`)
  return path
}

const dev = (environment: EnvironmentConfigInput | Record<string, unknown>) =>
  configFile({ dev: environment })

interface Run {
  code: number
  stdout: string
  stderr: string
  /** Every request the run made, e.g. `PUT /v1/admin/settings`. */
  requests: string[]
}

interface RunOptions {
  env?: Record<string, string>
  isTTY?: boolean
  prompt?: CliIo['prompt']
  /** Answer a request in the API's place. */
  intercept?: (method: string, path: string) => Response | undefined
}

async function tula(args: string[], options: RunOptions = {}): Promise<Run> {
  let stdout = ''
  let stderr = ''
  const requests: string[] = []
  const fetch: AdminFetch = async (url, init) => {
    const method = init?.method ?? 'GET'
    const path = url.slice(BASE_URL.length)
    requests.push(`${method} ${path}`)
    return options.intercept?.(method, path) ?? app.request(url, init)
  }
  const code = await runCli(
    args,
    {
      stdout: { write: (text) => (stdout += text) },
      stderr: { write: (text) => (stderr += text) },
      env: {
        TULA_API_URL: BASE_URL,
        TULA_SECRET_KEY: SECRET_KEY,
        GOOGLE_CLIENT_SECRET: GOOGLE_SECRET,
        GITHUB_CLIENT_SECRET: GITHUB_SECRET,
        APPLE_PRIVATE_KEY: APPLE_KEY,
        ...options.env,
      },
      cwd: dir,
      isTTY: options.isTTY ?? false,
      prompt: options.prompt,
      fetch,
    },
    COMMANDS
  )
  everythingPrinted.push(stdout, stderr)
  return { code, stdout, stderr, requests }
}

const writes = (run: Run) => run.requests.filter((request) => !request.startsWith('GET '))

interface State {
  revision: number
  settings: {
    app: { name: string }
    mfa: { policy: string }
    signIn: { methods: { password: { enabled: boolean } } }
  }
  managedBy: { tool: string; drifted: boolean; revision: number } | null
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

async function state(): Promise<State> {
  return (await (await admin('/v1/admin/settings')).json()) as State
}

async function providers(): Promise<
  Record<string, { configured: boolean; enabled: boolean; clientId: string | null }>
> {
  const body = (await (await admin('/v1/admin/oauth-providers')).json()) as {
    data: { provider: string; configured: boolean; enabled: boolean; clientId: string | null }[]
  }
  return Object.fromEntries(body.data.map((entry) => [entry.provider, entry]))
}

/** Change the settings the way a person in the dashboard would: no marker. */
async function editByHand(name: string): Promise<void> {
  const current = await state()
  const res = await admin('/v1/admin/settings', {
    method: 'PUT',
    headers: { 'if-match': `"${current.revision}"` },
    body: JSON.stringify({ ...current.settings, app: { name } }),
  })
  expect(res.status).toBe(200)
}

describe('tula diff / tula apply against the API', () => {
  test('a change is planned (exit 2), applied, and then there is nothing left (exit 0)', async () => {
    const config = await dev({
      settings: { app: { name: 'Northline' }, mfa: { policy: 'required' } },
    })

    const before = await tula(['diff', '--config', config])
    expect(before.code).toBe(2)
    expect(before.stdout).toContain('~ app.name: "Tula" → "Northline"')
    expect(before.stdout).toContain('~ mfa.policy: "optional" → "required"')
    expect(before.stdout).toContain('Changes pending')
    expect(writes(before)).toEqual([])
    expect((await state()).revision).toBe(0)

    const applied = await tula(['apply', '--config', config, '--yes'])
    expect(applied.code).toBe(0)
    expect(applied.stdout).toContain('done  settings: replace')
    expect(applied.stdout).toContain('Applied 1 change. Settings are at revision 1.')
    expect(writes(applied)).toEqual(['PUT /v1/admin/settings'])
    const now = await state()
    expect(now.settings.app.name).toBe('Northline')
    expect(now.settings.mfa.policy).toBe('required')
    expect(now.managedBy).toMatchObject({ tool: 'tula-apply', revision: 1, drifted: false })

    const after = await tula(['diff', '--config', config])
    expect(after.code).toBe(0)
    expect(after.stdout).toContain('No changes')
  })

  test('a second apply changes nothing and writes nothing', async () => {
    const config = await dev({
      settings: { app: { name: 'Northline' } },
      providers: { google: { clientId: 'g-client', clientSecret: env('GOOGLE_CLIENT_SECRET') } },
    })
    const first = await tula(['apply', '--config', config, '--yes'])
    expect(first.code).toBe(0)
    expect(writes(first)).toEqual([
      'PUT /v1/admin/settings',
      'PUT /v1/admin/oauth-providers/google',
    ])

    const second = await tula(['apply', '--config', config, '--yes'])
    expect(second.code).toBe(0)
    expect(second.stdout).toContain('No changes')
    expect(writes(second)).toEqual([])
    expect((await state()).revision).toBe(1)
  })

  test('settings changed by someone else between the plan and the write are never overwritten', async () => {
    const config = await dev({ settings: { app: { name: 'From the file' } } })
    // The plan is on screen; while the operator reads it, a colleague saves in the dashboard.
    const run = await tula(['apply', '--config', config], {
      isTTY: true,
      prompt: async () => {
        await editByHand('Saved by a colleague')
        return 'yes'
      },
    })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('changed by someone else after this plan was made')
    expect(run.stderr).toContain('Run `tula diff` again')
    const now = await state()
    expect(now.settings.app.name).toBe('Saved by a colleague')
    expect(now.revision).toBe(1)
  })

  test('--expect-revision refuses a plan made against an older revision, before any write', async () => {
    const config = await dev({ settings: { app: { name: 'From the file' } } })
    await editByHand('Saved by a colleague')
    const run = await tula(['apply', '--config', config, '--yes', '--expect-revision', '0'])
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('The settings are at revision 1, not 0')
    expect(writes(run)).toEqual([])
    expect(
      (await tula(['apply', '--config', config, '--yes', '--expect-revision', '1'])).code
    ).toBe(0)
  })

  test('a document the server refuses is shown with its code and the field’s path', async () => {
    // Valid for the file's schema; refused by the server, which alone knows there is no
    // provider to sign in with.
    const config = await dev({
      settings: { signIn: { methods: { password: { enabled: false } } } },
    })
    const run = await tula(['apply', '--config', config, '--yes'])
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('validation.failed')
    expect(run.stderr).toContain('HTTP 422')
    expect(run.stderr).toContain('signIn.methods: at least one sign-in method must stay enabled')
    expect(run.stderr).toContain('Not applied:\n  settings: replace')
    expect((await state()).revision).toBe(0)
  })

  test('a provider is enabled before the settings switch the password off', async () => {
    const config = await dev({
      settings: { signIn: { methods: { password: { enabled: false } } } },
      providers: { google: { clientId: 'g-client', clientSecret: env('GOOGLE_CLIENT_SECRET') } },
    })
    const run = await tula(['apply', '--config', config, '--yes'])
    expect(run.code).toBe(0)
    expect(writes(run)).toEqual(['PUT /v1/admin/oauth-providers/google', 'PUT /v1/admin/settings'])
    expect((await state()).settings.signIn.methods.password.enabled).toBe(false)
    expect((await providers()).google).toMatchObject({
      configured: true,
      enabled: true,
      clientId: 'g-client',
    })
  })

  test('and the other way round: the password comes back before the provider is deleted', async () => {
    const start = await dev({
      settings: { signIn: { methods: { password: { enabled: false } } } },
      providers: { google: { clientId: 'g-client', clientSecret: env('GOOGLE_CLIENT_SECRET') } },
    })
    expect((await tula(['apply', '--config', start, '--yes'])).code).toBe(0)

    const back = await dev({})
    const run = await tula(['apply', '--config', back, '--yes', '--prune'])
    expect(run.code).toBe(0)
    expect(writes(run)).toEqual([
      'PUT /v1/admin/settings',
      'DELETE /v1/admin/oauth-providers/google',
    ])
    expect((await providers()).google?.configured).toBe(false)
  })

  test('a provider the file leaves out is left alone, and deleted only with --prune', async () => {
    const both = await dev({
      providers: {
        google: { clientId: 'g-client', clientSecret: env('GOOGLE_CLIENT_SECRET') },
        github: { clientId: 'gh-client', clientSecret: env('GITHUB_CLIENT_SECRET') },
      },
    })
    expect((await tula(['apply', '--config', both, '--yes'])).code).toBe(0)

    const onlyGoogle = await dev({
      providers: { google: { clientId: 'g-client', clientSecret: env('GOOGLE_CLIENT_SECRET') } },
    })
    const kept = await tula(['apply', '--config', onlyGoogle, '--yes'])
    expect(kept.code).toBe(0)
    expect(kept.stdout).toContain('= github: unmanaged')
    expect(writes(kept).filter((request) => request.includes('oauth-providers'))).toEqual([])
    expect((await providers()).github?.configured).toBe(true)

    const pruning = await tula(['diff', '--config', onlyGoogle, '--prune'])
    expect(pruning.code).toBe(2)
    expect(pruning.stdout).toContain('- github: delete')
    const pruned = await tula(['apply', '--config', onlyGoogle, '--yes', '--prune'])
    expect(pruned.code).toBe(0)
    expect(writes(pruned)).toEqual(['DELETE /v1/admin/oauth-providers/github'])
    expect((await providers()).github?.configured).toBe(false)
    expect((await providers()).google?.configured).toBe(true)
  })

  test('Apple’s private key is read from its variable and stored, never shown', async () => {
    const config = await dev({
      providers: {
        apple: {
          clientId: 'app.northline.web',
          teamId: 'TEAM123456',
          keyId: 'KEY1234567',
          privateKey: env('APPLE_PRIVATE_KEY'),
        },
      },
    })
    const plan = await tula(['diff', '--config', config])
    expect(plan.stdout).toContain('+ apple: create')
    expect(plan.stdout).toContain('secret set from $APPLE_PRIVATE_KEY')
    const run = await tula(['apply', '--config', config, '--yes'])
    expect(run.code).toBe(0)
    expect(await providers()).toMatchObject({
      apple: { configured: true, enabled: true, clientId: 'app.northline.web' },
    })
  })

  test('a secret whose variable is not set stops the run before anything is written', async () => {
    const config = await dev({
      settings: { app: { name: 'Northline' } },
      providers: { google: { clientId: 'g-client', clientSecret: env('GOOGLE_CLIENT_SECRET') } },
    })
    const run = await tula(['apply', '--config', config, '--yes'], {
      env: { GOOGLE_CLIENT_SECRET: '' },
    })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('GOOGLE_CLIENT_SECRET is not set')
    expect(writes(run)).toEqual([])
    // The dry run needs no secret: it only names the variable.
    const plan = await tula(['diff', '--config', config], { env: { GOOGLE_CLIENT_SECRET: '' } })
    expect(plan.code).toBe(2)
    expect(plan.stdout).toContain('secret set from $GOOGLE_CLIENT_SECRET')
  })

  test('a secret written in the config file is refused, and not repeated', async () => {
    const literal = 'literal-client-secret-Jk55-do-not-print'
    SECRETS.push(literal)
    const config = await dev({
      providers: { google: { clientId: 'g-client', clientSecret: literal } },
    })
    for (const command of ['diff', 'apply']) {
      const run = await tula(
        [command, '--config', config, '--yes'].slice(0, command === 'diff' ? 3 : 4)
      )
      expect(run.code).toBe(1)
      expect(run.stderr).toContain('environments.dev.providers.google.clientSecret')
      expect(run.stderr).toContain("must be env('NAME')")
      expect(run.requests).toEqual([])
    }
  })

  test('a failure part-way says what was applied and what was not, and a second run finishes', async () => {
    const config = await dev({
      settings: { app: { name: 'Northline' } },
      providers: {
        google: { clientId: 'g-client', clientSecret: env('GOOGLE_CLIENT_SECRET') },
        github: { clientId: 'gh-client', clientSecret: env('GITHUB_CLIENT_SECRET') },
      },
    })
    const broken = await tula(['apply', '--config', config, '--yes'], {
      intercept: (method, path) =>
        method === 'PUT' && path.endsWith('/github')
          ? Response.json(
              { status: 503, code: 'service.unavailable', detail: 'The service is unavailable.' },
              { status: 503, headers: { 'retry-after': '5' } }
            )
          : undefined,
    })
    expect(broken.code).toBe(1)
    expect(broken.stderr).toContain('Failed: provider github: create')
    expect(broken.stderr).toContain('service.unavailable')
    expect(broken.stderr).toContain('Try again in 5s.')
    expect(broken.stderr).toContain('Applied before the failure:\n  settings: replace')
    expect(broken.stderr).toContain(
      'Not applied:\n  provider github: create\n  provider google: create'
    )
    expect((await state()).settings.app.name).toBe('Northline')
    expect((await providers()).google?.configured).toBe(false)

    const retry = await tula(['apply', '--config', config, '--yes'])
    expect(retry.code).toBe(0)
    expect(writes(retry)).toEqual([
      'PUT /v1/admin/oauth-providers/github',
      'PUT /v1/admin/oauth-providers/google',
    ])
    expect((await tula(['diff', '--config', config])).code).toBe(0)
  })

  test('settings changed in the dashboard show as drift, and apply puts the file back in charge', async () => {
    const config = await dev({ settings: { app: { name: 'Northline' } } })
    expect((await tula(['apply', '--config', config, '--yes'])).code).toBe(0)
    await editByHand('Edited in the dashboard')
    expect((await state()).managedBy).toMatchObject({ drifted: true })

    const plan = await tula(['diff', '--config', config])
    expect(plan.code).toBe(2)
    expect(plan.stdout).toContain('~ app.name: "Edited in the dashboard" → "Northline"')
    expect(plan.stdout).toContain('changed outside the config file since the last apply')

    expect((await tula(['apply', '--config', config, '--yes'])).code).toBe(0)
    expect((await state()).managedBy).toMatchObject({ drifted: false, revision: 3 })
  })

  test('a weakening is flagged in the plan with the paths the server would record', async () => {
    const strict = await dev({ settings: { mfa: { policy: 'required' } } })
    expect((await tula(['apply', '--config', strict, '--yes'])).code).toBe(0)
    const loose = await dev({ settings: { mfa: { policy: 'off' } } })
    const plan = await tula(['diff', '--config', loose])
    expect(plan.stdout).toContain('! weakens security: mfa.policy')
    expect((await tula(['apply', '--config', loose, '--yes'])).code).toBe(0)
    const log = (await (
      await admin('/v1/admin/audit-logs?action=environment.settings_updated')
    ).json()) as { data: { metadata: Record<string, unknown> }[] }
    expect(log.data[0]?.metadata).toMatchObject({ weakened: true, managedBy: 'tula-apply' })
  })

  test('without a terminal and without --yes, apply refuses instead of waiting', async () => {
    const config = await dev({ settings: { app: { name: 'Northline' } } })
    const run = await tula(['apply', '--config', config])
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('pass --yes')
    expect(writes(run)).toEqual([])
  })

  test('at a terminal, anything but yes cancels', async () => {
    const config = await dev({ settings: { app: { name: 'Northline' } } })
    const asked: string[] = []
    const run = await tula(['apply', '--config', config], {
      isTTY: true,
      prompt: async (question) => {
        asked.push(question)
        return 'y'
      },
    })
    expect(run.code).toBe(1)
    expect(asked).toEqual([`Apply these changes to "dev" at ${BASE_URL}? Type yes to continue: `])
    expect(run.stderr).toContain('Cancelled. Nothing was changed.')
    expect(writes(run)).toEqual([])
  })

  test('a config for production is not applied with a development key', async () => {
    const config = await configFile({
      prod: { kind: 'production', settings: { app: { name: 'Prod' } } },
    })
    const run = await tula(['apply', '--config', config, '--env', 'prod', '--yes'])
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('is a production environment')
    expect(run.requests).toEqual([])
  })

  test('--json prints the plan for a machine, with the secret as a name', async () => {
    const config = await dev({
      settings: { app: { name: 'Northline' } },
      providers: { google: { clientId: 'g-client', clientSecret: env('GOOGLE_CLIENT_SECRET') } },
    })
    const run = await tula(['diff', '--config', config, '--json'])
    expect(run.code).toBe(2)
    const plan = JSON.parse(run.stdout) as {
      changes: boolean
      revision: number
      settings: { path: string }[]
      providers: { provider: string; action: string; secret: string; secretEnv: string }[]
    }
    expect(plan.changes).toBe(true)
    expect(plan.revision).toBe(0)
    expect(plan.settings.map((change) => change.path)).toEqual(['app.name'])
    expect(plan.providers).toMatchObject([
      { provider: 'google', action: 'create', secret: 'set', secretEnv: 'GOOGLE_CLIENT_SECRET' },
    ])

    const applied = await tula(['apply', '--config', config, '--yes', '--json'])
    const result = JSON.parse(applied.stdout) as {
      applied: string[]
      failed: null
      revisionAfter: number
    }
    expect(result).toMatchObject({
      applied: ['settings: replace', 'provider google: create'],
      failed: null,
      revisionAfter: 1,
    })
  })

  test('a key the API does not know is reported by its code, not echoed', async () => {
    const config = await dev({})
    const unknown = 'tula_sk_dev_nobodyknowsthiskey000000000000000'
    SECRETS.push(unknown)
    const run = await tula(['diff', '--config', config], { env: { TULA_SECRET_KEY: unknown } })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('auth.invalid_key')
  })
})

// Declared last, so it runs after every run above.
test('no secret that passed through any run was printed, to either stream', () => {
  const printed = everythingPrinted.join('\n')
  expect(printed.length).toBeGreaterThan(1000)
  for (const secret of SECRETS) {
    expect(printed).not.toContain(secret)
  }
})
