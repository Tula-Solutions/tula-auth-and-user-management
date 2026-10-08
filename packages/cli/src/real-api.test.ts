import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { constants } from 'node:fs'
import { mkdir, mkdtemp, open, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AdminFetch } from '@tula/admin'
import type { EnvironmentConfigInput } from '@tula/config'
import { createApp } from '../../../apps/api/src/index'
import { createTestDeps, seedApiKey, type TestDeps } from '../../../apps/api/src/testing'
import type { Host } from './host'
import { type CliIo, COMMANDS, runCli } from './index'
import { createProcessHost } from './process-host'

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
/** A webhook signing secret as the server makes one: `whsec_` and 32 bytes in base64. */
const WHSEC = /whsec_[A-Za-z0-9+/]{43}=/

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
  /** Collects the body of every write the run makes. */
  bodies?: string[]
  /** Sees every answer the API itself gave: the method, the path and the body's text. */
  observe?: (method: string, path: string, body: string) => void
  /** In the real host's place. */
  host?: Host
  /**
   * The run was asked to print a secret (`--show-secrets`): its output is kept out of what
   * the last test scans, and the test that sets this checks it itself.
   */
  shown?: boolean
}

async function tula(args: string[], options: RunOptions = {}): Promise<Run> {
  let stdout = ''
  let stderr = ''
  const requests: string[] = []
  const fetch: AdminFetch = async (url, init) => {
    const method = init?.method ?? 'GET'
    const path = url.slice(BASE_URL.length)
    requests.push(`${method} ${path}`)
    if (method !== 'GET' && typeof init?.body === 'string') {
      options.bodies?.push(init.body)
    }
    const answered = options.intercept?.(method, path)
    if (answered) {
      return answered
    }
    const response = await app.request(url, init)
    options.observe?.(method, path, await response.clone().text())
    return response
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
      // The real host: a secrets file is written with the modes and refusals an operator gets.
      host: options.host ?? createProcessHost({}),
    },
    COMMANDS
  )
  if (!options.shown) {
    everythingPrinted.push(stdout, stderr)
  }
  return { code, stdout, stderr, requests }
}

const writes = (run: Run) => run.requests.filter((request) => !request.startsWith('GET '))

interface State {
  revision: number
  settings: {
    app: { name: string }
    mfa: { policy: string }
    signIn: { methods: { password: { enabled: boolean } } }
    sessions: {
      jwtTemplates: Record<string, unknown>
      profiles: { web: { jwtTemplate: string | null } }
    }
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
  Record<
    string,
    { configured: boolean; enabled: boolean; clientId: string | null; tenant: string | null }
  >
> {
  const body = (await (await admin('/v1/admin/oauth-providers')).json()) as {
    data: {
      provider: string
      configured: boolean
      enabled: boolean
      clientId: string | null
      tenant: string | null
    }[]
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

  test('Microsoft is created with its tenant, which a second run finds unchanged', async () => {
    const microsoft = (tenant: string) =>
      dev({
        providers: {
          microsoft: {
            clientId: 'ms-client',
            clientSecret: env('MICROSOFT_CLIENT_SECRET'),
            tenant,
          },
        },
      })
    const secret = 'real-api-microsoft-secret'
    const withSecret = { env: { MICROSOFT_CLIENT_SECRET: secret } }
    // Written in capitals in the file: the server stores it lower-cased, and so does the file.
    const config = await microsoft('72F988BF-86F1-41AF-91AB-2D7CD011DB47')
    const plan = await tula(['diff', '--config', config], withSecret)
    expect(plan.stdout).toContain('+ microsoft: create')
    expect(plan.stdout).toContain('secret set from $MICROSOFT_CLIENT_SECRET')
    const run = await tula(['apply', '--config', config, '--yes'], withSecret)
    expect(run.code).toBe(0)
    expect(run.stdout + run.stderr).not.toContain(secret)
    expect(await providers()).toMatchObject({
      microsoft: {
        configured: true,
        enabled: true,
        clientId: 'ms-client',
        tenant: '72f988bf-86f1-41af-91ab-2d7cd011db47',
      },
    })
    expect((await tula(['diff', '--config', config])).code).toBe(0)

    // Another tenant: an update that needs no secret.
    const widened = await microsoft('organizations')
    const change = await tula(['apply', '--config', widened, '--yes'])
    expect(change.code).toBe(0)
    expect(writes(change)).toContain('PUT /v1/admin/oauth-providers/microsoft')
    expect((await providers()).microsoft?.tenant).toBe('organizations')
  })

  test.each([
    ['discord', 'DISCORD_CLIENT_SECRET'],
    ['linkedin', 'LINKEDIN_CLIENT_SECRET'],
  ] as const)(
    '%s is created from a client id and a secret, which a second run finds unchanged',
    async (provider, variable) => {
      const file = (enabled: boolean) =>
        dev({
          providers: {
            [provider]: { clientId: 'the-client', clientSecret: env(variable), enabled },
          },
        })
      const secret = `real-api-${provider}-secret-do-not-print`
      const withSecret = { env: { [variable]: secret } }
      const config = await file(true)
      const plan = await tula(['diff', '--config', config], withSecret)
      expect(plan.stdout).toContain(`+ ${provider}: create`)
      expect(plan.stdout).toContain(`secret set from $${variable}`)
      const run = await tula(['apply', '--config', config, '--yes'], withSecret)
      expect(run.code).toBe(0)
      expect(writes(run)).toContain(`PUT /v1/admin/oauth-providers/${provider}`)
      expect(run.stdout + run.stderr).not.toContain(secret)
      expect(await providers()).toMatchObject({
        [provider]: { configured: true, enabled: true, clientId: 'the-client', tenant: null },
      })
      expect((await tula(['diff', '--config', config])).code).toBe(0)

      // Switched off: an update that needs no secret, and the stored one is kept.
      const off = await tula(['apply', '--config', await file(false), '--yes'])
      expect(off.code).toBe(0)
      expect(off.stdout).toContain('stored secret kept')
      expect((await providers())[provider]).toMatchObject({ configured: true, enabled: false })
    }
  )

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
    expect((await tula(['apply', '--config', loose, '--yes', '--allow-weaker'])).code).toBe(0)
    const log = (await (
      await admin('/v1/admin/audit-logs?action=environment.settings_updated')
    ).json()) as { data: { metadata: Record<string, unknown> }[] }
    expect(log.data[0]?.metadata).toMatchObject({ weakened: true, managedBy: 'tula-apply' })
  })

  test('a weakening plan is not applied by --yes alone: it takes --allow-weaker', async () => {
    const strict = await dev({ settings: { mfa: { policy: 'required' } } })
    expect((await tula(['apply', '--config', strict, '--yes'])).code).toBe(0)
    const before = await state()
    const loose = await dev({ settings: { mfa: { policy: 'off' } } })

    const refused = await tula(['apply', '--config', loose, '--yes'])
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain('weakens security (mfa.policy)')
    expect(refused.stderr).toContain('--allow-weaker')
    expect(writes(refused)).toEqual([])
    expect(await state()).toEqual(before)

    const allowed = await tula(['apply', '--config', loose, '--yes', '--allow-weaker'])
    expect(allowed.code).toBe(0)
    expect((await state()).settings.mfa.policy).toBe('off')
  })

  test('a JWT template is planned, applied, and a second run changes nothing', async () => {
    const config = await dev({
      settings: {
        sessions: {
          jwtTemplates: {
            app: { claims: { role: { value: 'member' }, email: { from: 'user.email' } } },
          },
          profiles: { web: { jwtTemplate: 'app' } },
        },
      },
    })
    const plan = await tula(['diff', '--config', config])
    expect(plan.code).toBe(2)
    expect(plan.stdout).toContain('+ sessions.jwtTemplates.app')
    expect(plan.stdout).toContain('~ sessions.profiles.web.jwtTemplate: null → "app"')
    // Adding claims weakens nothing.
    expect(plan.stdout).not.toContain('weakens security')

    const applied = await tula(['apply', '--config', config, '--yes'])
    expect(applied.code).toBe(0)
    expect(writes(applied)).toEqual(['PUT /v1/admin/settings'])
    const now = await state()
    expect(now.settings.sessions.jwtTemplates).toEqual({
      app: { claims: { role: { value: 'member' }, email: { from: 'user.email' } } },
    })
    expect(now.settings.sessions.profiles.web.jwtTemplate).toBe('app')

    const second = await tula(['apply', '--config', config, '--yes'])
    expect(second.stdout).toContain('No changes')
    expect(writes(second)).toEqual([])
  })

  test('taking a claim away from sessions that carry it needs --allow-weaker under --yes', async () => {
    const template = (claims: Record<string, unknown>) =>
      dev({
        settings: {
          sessions: {
            jwtTemplates: { app: { claims } },
            profiles: { web: { jwtTemplate: 'app' } },
          },
        },
      })
    const full = await template({ role: { value: 'member' }, beta: { value: true } })
    expect((await tula(['apply', '--config', full, '--yes'])).code).toBe(0)
    const before = await state()

    const less = await template({ beta: { value: true } })
    const plan = await tula(['diff', '--config', less])
    expect(plan.stdout).toContain('- sessions.jwtTemplates.app.claims.role')
    expect(plan.stdout).toContain('! weakens security: sessions.profiles.web.jwtTemplate')
    const refused = await tula(['apply', '--config', less, '--yes'])
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain('--allow-weaker')
    expect(writes(refused)).toEqual([])
    expect(await state()).toEqual(before)

    expect((await tula(['apply', '--config', less, '--yes', '--allow-weaker'])).code).toBe(0)
    expect((await state()).settings.sessions.jwtTemplates).toEqual({
      app: { claims: { beta: { value: true } } },
    })
  })

  test('a template the file’s schema refuses is shown with the field’s path, before any request', async () => {
    // The file's own schema refuses a reserved key before any request.
    const config = await dev({
      settings: { sessions: { jwtTemplates: { app: { claims: { sub: { value: 'x' } } } } } },
    })
    const run = await tula(['diff', '--config', config])
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('sessions.jwtTemplates.app.claims.sub')
    expect(writes(run)).toEqual([])
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

const HOOK = 'https://hooks.example.test/tula'
const TYPES = ['user.created', 'user.deleted']

interface Endpoint {
  id: string
  url: string
  eventTypes: string[]
  enabled: boolean
  disabledReason: string | null
  secret?: string
}

async function endpoints(): Promise<Endpoint[]> {
  const body = (await (await admin('/v1/admin/webhook-endpoints')).json()) as { data: Endpoint[] }
  return body.data
}

/** Register an endpoint the way a person would, outside the file. Its secret is never to be printed. */
async function register(url: string, eventTypes = ['user.created']): Promise<Endpoint> {
  const res = await admin('/v1/admin/webhook-endpoints', {
    method: 'POST',
    body: JSON.stringify({ url, eventTypes }),
  })
  expect(res.status).toBe(201)
  const created = (await res.json()) as Endpoint
  SECRETS.push(created.secret as string)
  return created
}

async function patch(id: string, body: Record<string, unknown>): Promise<void> {
  const res = await admin(`/v1/admin/webhook-endpoints/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
  expect(res.status).toBe(200)
}

/**
 * The run's writes to webhook endpoints, ids masked. (A run of a file the server has not seen
 * also replaces the settings, to record the file as their manager: not what these tests are
 * about.)
 */
const webhookWrites = (run: Run) =>
  writes(run)
    .filter((request) => request.includes('/webhook-endpoints'))
    .map((request) => request.replace(/[0-9a-f-]{36}/, '<id>'))

/** Apply a file that changes no endpoint, so that only what a test does next is pending. */
async function settle(config: string): Promise<void> {
  const run = await tula(['apply', '--config', config, '--yes'])
  expect(run.code).toBe(0)
  expect(webhookWrites(run)).toEqual([])
}

const hook = (name: string, over: Record<string, unknown> = {}) => ({
  url: `${HOOK}/${name}`,
  eventTypes: ['user.created'],
  ...over,
})

describe('webhook endpoints in the config file', () => {
  beforeEach(() => {
    // The API's own guard judges every address; in tests a name resolves only where told to.
    deps.outbound.point('hooks.example.test', '93.184.216.34')
  })

  test('an endpoint is planned (exit 2), created, its secret kept in a file only its owner reads, and then nothing is left', async () => {
    const config = await dev({ webhooks: [{ url: HOOK, eventTypes: [...TYPES].reverse() }] })

    const before = await tula(['diff', '--config', config])
    expect(before.code).toBe(2)
    expect(before.stdout).toContain(
      `+ ${HOOK}: create (eventTypes "user.created" "user.deleted"; a signing secret is made, shown once)`
    )
    expect(before.stdout).toContain(
      '! creates 1 webhook endpoint: its signing secret is shown once, to the run that creates it (`tula apply` needs --secrets-file <path>, --show-secrets or --discard-secrets)'
    )
    expect(writes(before)).toEqual([])
    expect(await endpoints()).toEqual([])

    const applied = await tula([
      'apply',
      '--config',
      config,
      '--yes',
      '--secrets-file',
      'hooks.json',
    ])
    expect(applied.code).toBe(0)
    expect(writes(applied)).toEqual(['PUT /v1/admin/settings', 'POST /v1/admin/webhook-endpoints'])
    expect(applied.stdout).toContain(`done  webhook ${HOOK}: create`)
    expect(applied.stdout).toContain(
      `Wrote 1 signing secret to ${join(dir, 'hooks.json')} (mode 0600). It is not shown again: give it to the receiver, then delete the file.`
    )
    expect(applied.stdout + applied.stderr).not.toContain('whsec_')
    // Not only the value: the line that would carry it is not written at all (F4).
    expect(applied.stdout + applied.stderr).not.toContain('signing secret, shown this once')
    const [created] = await endpoints()
    expect(created).toMatchObject({ url: HOOK, eventTypes: TYPES, enabled: true })
    const file = join(dir, 'hooks.json')
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    const kept = JSON.parse(await readFile(file, 'utf8')) as Endpoint[]
    expect(kept).toHaveLength(1)
    expect(kept[0]?.id).toBe(created?.id as string)
    expect(kept[0]?.url).toBe(HOOK)
    expect(kept[0]?.secret).toMatch(new RegExp(`^${WHSEC.source}$`))
    SECRETS.push(kept[0]?.secret as string)

    const after = await tula(['diff', '--config', config])
    expect(after.code).toBe(0)
    expect(after.stdout).toContain(`= ${HOOK}: unchanged`)
    const second = await tula(['apply', '--config', config, '--yes'])
    expect(second.stdout).toContain('No changes')
    expect(writes(second)).toEqual([])
  })

  test('a plan that creates an endpoint is refused before any write until the run is told what to do with the secret', async () => {
    const config = await dev({ settings: { app: { name: 'Northline' } }, webhooks: [hook('a')] })
    const asked: string[] = []
    for (const options of [
      {},
      { isTTY: true, prompt: async (q: string) => String(asked.push(q)) },
    ]) {
      const run = await tula(
        ['apply', '--config', config, '--yes'].slice(0, options.isTTY ? 3 : 4),
        options
      )
      expect(run.code).toBe(1)
      expect(run.stderr).toContain(
        'error: This plan creates 1 webhook endpoint, and the server shows its signing secret only once, in its answer to this run. Nothing was changed. Say what to do with it:'
      )
      expect(run.stderr).toContain('--secrets-file <path>')
      expect(run.stderr).toContain('--show-secrets')
      expect(run.stderr).toContain(
        '--discard-secrets      keep nothing. To get a secret later, rotate it: for the 24 hours of the overlap deliveries are then also signed with the first secret, which nobody holds. That is harmless.'
      )
      expect(writes(run)).toEqual([])
    }
    expect(asked).toEqual([])
    expect(await endpoints()).toEqual([])
    expect((await state()).revision).toBe(0)
  })

  test('--show-secrets prints the secret once, on standard output; without it nothing ever does', async () => {
    const config = await dev({ webhooks: [hook('a')] })
    const run = await tula(['apply', '--config', config, '--yes', '--show-secrets'], {
      shown: true,
    })
    expect(run.code).toBe(0)
    const shown = run.stdout.match(new RegExp(WHSEC.source, 'g')) ?? []
    expect(shown).toHaveLength(1)
    expect(run.stdout).toContain(`signing secret, shown this once: ${shown[0]}`)
    expect(run.stderr).not.toContain('whsec_')
    SECRETS.push(shown[0] as string)
  })

  test('--discard-secrets creates the endpoint and keeps nothing, and says how to get a secret later', async () => {
    const config = await dev({ webhooks: [hook('a')] })
    const run = await tula(['apply', '--config', config, '--yes', '--discard-secrets'])
    expect(run.code).toBe(0)
    expect(run.stdout + run.stderr).not.toContain('whsec_')
    const [created] = await endpoints()
    expect(run.stdout).toContain(
      `1 signing secret was not kept (--discard-secrets). To get one, rotate it: POST /v1/admin/webhook-endpoints/<id>/secret/rotate.`
    )
    expect(created?.url).toBe(`${HOOK}/a`)
  })

  test('--discard-secrets with a way to keep them is a contradiction, refused before anything is read', async () => {
    const config = await dev({ webhooks: [hook('a')] })
    const run = await tula([
      'apply',
      '--config',
      config,
      '--yes',
      '--discard-secrets',
      '--show-secrets',
    ])
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('--discard-secrets cannot be combined')
    expect(run.requests).toEqual([])
  })

  test('--secrets-file never replaces a file that is there, and never writes through a link', async () => {
    const config = await dev({ webhooks: [hook('a')] })
    await writeFile(join(dir, 'earlier.json'), '[{"secret":"from an earlier run"}]\n')
    const existing = await tula([
      'apply',
      '--config',
      config,
      '--yes',
      '--secrets-file',
      'earlier.json',
    ])
    expect(existing.code).toBe(1)
    expect(existing.stderr).toContain('already exists')
    expect(existing.stderr).toContain('Nothing was changed.')
    expect(writes(existing)).toEqual([])
    expect(await readFile(join(dir, 'earlier.json'), 'utf8')).toContain('from an earlier run')

    await symlink(join(dir, 'elsewhere.json'), join(dir, 'link.json'))
    const linked = await tula(['apply', '--config', config, '--yes', '--secrets-file', 'link.json'])
    expect(linked.code).toBe(1)
    expect(linked.stderr).toContain('symbolic link')
    expect(linked.stderr).toContain('Nothing was changed.')
    expect(writes(linked)).toEqual([])
    expect(await endpoints()).toEqual([])
  })

  test('event types are a set: another order is no change, and a changed set is one PATCH of that field', async () => {
    const existing = await register(HOOK, ['user.deleted', 'user.created'])
    const same = await dev({
      webhooks: [{ url: HOOK, eventTypes: ['user.created', 'user.deleted', 'user.created'] }],
    })
    await settle(same)
    expect((await tula(['diff', '--config', same])).code).toBe(0)

    const changed = await dev({
      webhooks: [{ url: HOOK, eventTypes: ['user.created', 'session.created'] }],
    })
    const plan = await tula(['diff', '--config', changed])
    expect(plan.code).toBe(2)
    expect(plan.stdout).toContain(
      `~ ${HOOK}: update (eventTypes +"session.created" -"user.deleted")`
    )
    const bodies: string[] = []
    const run = await tula(['apply', '--config', changed, '--yes'], { bodies })
    expect(run.code).toBe(0)
    expect(webhookWrites(run)).toEqual(['PATCH /v1/admin/webhook-endpoints/<id>'])
    expect(bodies.at(-1)).toBe('{"eventTypes":["session.created","user.created"]}')
    expect((await endpoints())[0]).toMatchObject({
      id: existing.id,
      eventTypes: ['session.created', 'user.created'],
    })
  })

  test('enabled left out is not managed; written, it is set, and switching on is said in the plan', async () => {
    const existing = await register(HOOK)
    await patch(existing.id, { enabled: false })
    const silent = await dev({ webhooks: [{ url: HOOK, eventTypes: ['user.created'] }] })
    await settle(silent)
    expect((await tula(['diff', '--config', silent])).code).toBe(0)
    expect((await endpoints())[0]?.enabled).toBe(false)

    const on = await dev({ webhooks: [{ url: HOOK, eventTypes: ['user.created'], enabled: true }] })
    const plan = await tula(['diff', '--config', on])
    expect(plan.stdout).toContain(`~ ${HOOK}: update (enabled false → true)`)
    const run = await tula(['apply', '--config', on, '--yes'])
    expect(run.code).toBe(0)
    expect((await endpoints())[0]?.enabled).toBe(true)
  })

  test('an endpoint the list leaves out is left alone; --prune removes it, and under --yes only with --allow-webhook-removal', async () => {
    await register(`${HOOK}/old`)
    const config = await dev({ webhooks: [] })
    await settle(config)
    const kept = await tula(['diff', '--config', config])
    expect(kept.code).toBe(0)
    expect(kept.stdout).toContain(
      `= ${HOOK}/old: unmanaged (on the server, not in the file; --prune removes it, with its pending deliveries and its delivery log)`
    )

    const plan = await tula(['diff', '--config', config, '--prune'])
    expect(plan.code).toBe(2)
    expect(plan.stdout).toContain(
      `- ${HOOK}/old: remove, with its pending deliveries and its delivery log`
    )
    expect(plan.stdout).toContain(
      '! removes 1 webhook endpoint with its pending deliveries and its delivery log, for good (`tula apply --yes` needs --allow-webhook-removal)'
    )
    expect(plan.stdout).toContain(
      '`tula apply --yes` refuses this plan without --allow-webhook-removal: it removes a webhook endpoint and its delivery log.'
    )

    const refused = await tula(['apply', '--config', config, '--yes', '--prune'])
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain(
      'error: This plan removes 1 webhook endpoint with its pending deliveries and its delivery log, for good, and with --yes nobody is asked. Nothing was changed. Pass --allow-webhook-removal with --yes to apply it.'
    )
    expect(writes(refused)).toEqual([])
    expect(await endpoints()).toHaveLength(1)

    const allowed = await tula([
      'apply',
      '--config',
      config,
      '--yes',
      '--prune',
      '--allow-webhook-removal',
    ])
    expect(allowed.code).toBe(0)
    expect(webhookWrites(allowed)).toEqual(['DELETE /v1/admin/webhook-endpoints/<id>'])
    expect(await endpoints()).toEqual([])
  })

  test('at a terminal the question says what a removal deletes', async () => {
    await register(`${HOOK}/old`)
    const config = await dev({ webhooks: [] })
    const asked: string[] = []
    const run = await tula(['apply', '--config', config, '--prune'], {
      isTTY: true,
      prompt: async (question) => {
        asked.push(question)
        return 'no'
      },
    })
    expect(run.code).toBe(1)
    expect(asked).toEqual([
      `This REMOVES 1 webhook endpoint with its pending deliveries and its delivery log, for good. Apply these changes to "dev" at ${BASE_URL}? Type yes to continue: `,
    ])
    expect(await endpoints()).toHaveLength(1)
  })

  test('a file without a webhooks list does not read the endpoints, and --prune does not touch them', async () => {
    await register(`${HOOK}/old`)
    const config = await dev({ settings: { app: { name: 'Northline' } } })
    const plan = await tula(['diff', '--config', config, '--prune'])
    expect(plan.requests.filter((request) => request.includes('webhook'))).toEqual([])
    expect(plan.stdout).not.toContain('Webhooks')
    const run = await tula(['apply', '--config', config, '--yes', '--prune'])
    expect(run.code).toBe(0)
    expect(run.requests.filter((request) => request.includes('webhook'))).toEqual([])
    expect(await endpoints()).toHaveLength(1)
  })

  test('an address the server has twice cannot be matched: diff fails with the plan, apply writes nothing', async () => {
    const one = await register(HOOK)
    const two = await register(HOOK)
    const config = await dev({
      settings: { app: { name: 'Northline' } },
      webhooks: [{ url: HOOK, eventTypes: ['user.deleted'] }],
    })
    const message =
      `error: The server has 2 webhook endpoints with the address ${HOOK} (ids ${one.id}, ${two.id}): ` +
      'tula cannot tell which one the file means and changes none of them. Remove all but one by hand ' +
      '(DELETE /v1/admin/webhook-endpoints/<id>), then run again.'
    const plan = await tula(['diff', '--config', config])
    expect(plan.code).toBe(1)
    expect(plan.stdout).toContain(
      `! ${HOOK}: cannot be matched (the server has 2 endpoints with this address)`
    )
    expect(plan.stderr).toContain(message)
    for (const flags of [[], ['--prune', '--allow-webhook-removal']]) {
      const run = await tula(['apply', '--config', config, '--yes', ...flags])
      expect(run.code).toBe(1)
      expect(run.stderr).toContain(`${message} Nothing was changed.`)
      expect(writes(run)).toEqual([])
    }
    expect((await state()).revision).toBe(0)
    expect((await endpoints()).map((entry) => entry.eventTypes)).toEqual([
      ['user.created'],
      ['user.created'],
    ])
  })

  test('an address the server refuses: its code and its fixed reason and no more, with the settings and the endpoint before it applied', async () => {
    const config = await dev({
      settings: { app: { name: 'Northline' } },
      webhooks: [
        hook('a'),
        { url: 'https://canary-nowhere.example.test/in', eventTypes: ['user.created'] },
        hook('c'),
      ],
    })
    const run = await tula(['apply', '--config', config, '--yes', '--secrets-file', 'hooks.json'])
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('Failed: webhook https://canary-nowhere.example.test/in: create')
    expect(run.stderr).toContain(
      'error: The server cannot deliver to that address. (webhook.url_not_allowed, HTTP 422)\n  reason: resolve_failed\n'
    )
    expect(run.stderr).toContain(
      `Applied before the failure:\n  settings: replace\n  webhook ${HOOK}/a: create\n` +
        `Not applied:\n  webhook https://canary-nowhere.example.test/in: create\n  webhook ${HOOK}/c: create\n`
    )
    expect(run.stderr).toContain(
      `Wrote 1 signing secret to ${join(dir, 'hooks.json')} (mode 0600).`
    )
    expect(run.stdout + run.stderr).not.toContain('whsec_')
    expect((await state()).settings.app.name).toBe('Northline')
    expect((await endpoints()).map((entry) => entry.url)).toEqual([`${HOOK}/a`])
    const kept = JSON.parse(await readFile(join(dir, 'hooks.json'), 'utf8')) as Endpoint[]
    expect(kept.map((entry) => entry.url)).toEqual([`${HOOK}/a`])
    SECRETS.push(kept[0]?.secret as string)
  })

  test('a failure midway through several webhook writes says what was and was not applied, and a second run finishes', async () => {
    const stay = await register(`${HOOK}/stay`)
    await register(`${HOOK}/old`)
    const config = await dev({
      webhooks: [hook('stay', { eventTypes: ['user.deleted'] }), hook('new')],
    })
    const flags = [
      'apply',
      '--config',
      config,
      '--yes',
      '--prune',
      '--allow-webhook-removal',
      '--discard-secrets',
    ]
    const broken = await tula(flags, {
      intercept: (method) =>
        method === 'POST'
          ? Response.json(
              { status: 503, code: 'service.unavailable', detail: 'The service is unavailable.' },
              { status: 503 }
            )
          : undefined,
    })
    expect(broken.code).toBe(1)
    expect(broken.stderr).toContain(
      `Failed: webhook ${HOOK}/new: create\n` +
        'error: The service is unavailable. (service.unavailable, HTTP 503)\n' +
        `Applied before the failure:\n  settings: replace\n  webhook ${HOOK}/stay: update\n` +
        `Not applied:\n  webhook ${HOOK}/new: create\n  webhook ${HOOK}/old: remove\n`
    )
    // The endpoint being replaced was not removed: nothing is worse than before.
    expect((await endpoints()).map((entry) => entry.url)).toEqual([`${HOOK}/stay`, `${HOOK}/old`])

    const retry = await tula(flags)
    expect(retry.code).toBe(0)
    expect(webhookWrites(retry)).toEqual([
      'POST /v1/admin/webhook-endpoints',
      'DELETE /v1/admin/webhook-endpoints/<id>',
    ])
    expect(await endpoints()).toMatchObject([
      { id: stay.id, eventTypes: ['user.deleted'] },
      { url: `${HOOK}/new` },
    ])
  })

  test('at the limit of ten, one replaced: one removal goes first and the plan says so; an eleventh is refused whole', async () => {
    for (let index = 0; index < 10; index += 1) {
      await register(`${HOOK}/${index}`)
    }
    const eight = Array.from({ length: 8 }, (_, index) => hook(String(index)))
    // Ten on the server that the file does not list, and one more in the file.
    const eleven = await dev({ webhooks: [hook('new')] })
    const tooMany = await tula(['apply', '--config', eleven, '--yes', '--discard-secrets'])
    expect(tooMany.code).toBe(1)
    expect(tooMany.stderr).toContain(
      'error: The environment would have 11 webhook endpoints and may have 10. Nothing was changed. List fewer in the file, or remove the ones it does not list (--prune).'
    )
    expect(writes(tooMany)).toEqual([])

    const replaced = await dev({ webhooks: [...eight, hook('new')] })
    const flags = ['--config', replaced, '--prune']
    const plan = await tula(['diff', ...flags])
    expect(plan.stdout).toContain(
      '! the environment is at its limit of 10 webhook endpoints: 1 of the removals is made before the new endpoint is created, to make room'
    )
    const run = await tula([
      'apply',
      ...flags,
      '--yes',
      '--allow-webhook-removal',
      '--discard-secrets',
    ])
    expect(run.code).toBe(0)
    expect(webhookWrites(run)).toEqual([
      'DELETE /v1/admin/webhook-endpoints/<id>',
      'POST /v1/admin/webhook-endpoints',
      'DELETE /v1/admin/webhook-endpoints/<id>',
    ])
    expect((await endpoints()).map((entry) => entry.url)).toEqual([
      ...eight.map((entry) => entry.url),
      `${HOOK}/new`,
    ])
  })

  test('endpoints changed by someone else between the plan and the write are not written to; the settings already were', async () => {
    const existing = await register(HOOK)
    const config = await dev({
      settings: { app: { name: 'Northline' } },
      webhooks: [{ url: HOOK, eventTypes: ['user.deleted'] }],
    })
    const run = await tula(['apply', '--config', config], {
      isTTY: true,
      prompt: async () => {
        await patch(existing.id, { eventTypes: ['session.created'] })
        return 'yes'
      },
    })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain(
      'error: The webhook endpoints were changed by someone else after this plan was made. Nothing was written to them. Run `tula diff` again and review the new plan.\n' +
        'Applied before the failure:\n  settings: replace\n' +
        `Not applied:\n  webhook ${HOOK}: update\n`
    )
    expect(writes(run)).toEqual(['PUT /v1/admin/settings'])
    expect((await endpoints())[0]?.eventTypes).toEqual(['session.created'])
  })

  test('a secret written in the file is refused before any request, and not repeated', async () => {
    const literal = 'whsec_d3JpdHRlbi1pbi10aGUtZmlsZS1kby1ub3QtcHJpbnQ='
    SECRETS.push(literal)
    const config = await dev({
      webhooks: [{ url: HOOK, eventTypes: ['user.created'], secret: literal }],
    })
    const run = await tula(['diff', '--config', config])
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('environments.dev.webhooks.0.secret: unknown key')
    expect(run.requests).toEqual([])
  })

  test('--json carries the endpoints, what apply will ask for, and a secret only when asked', async () => {
    await register(`${HOOK}/old`)
    const config = await dev({ webhooks: [hook('a')] })
    const plan = JSON.parse(
      (await tula(['diff', '--config', config, '--json', '--prune'])).stdout
    ) as {
      webhooks: { managed: boolean; endpoints: { url: string; action: string }[] }
      applyRequires: Record<string, boolean>
    }
    expect(plan.webhooks.managed).toBe(true)
    expect(plan.webhooks.endpoints).toMatchObject([
      { url: `${HOOK}/a`, action: 'create' },
      { url: `${HOOK}/old`, action: 'delete' },
    ])
    expect(plan.applyRequires).toEqual({
      allowUnknown: false,
      allowWeaker: false,
      allowWebhookRemoval: true,
      webhookSecrets: true,
      hookSecrets: false,
    })
    const quiet = await tula(['apply', '--config', config, '--yes', '--json', '--discard-secrets'])
    expect(quiet.code).toBe(0)
    expect(quiet.stdout).not.toContain('whsec_')
    expect(JSON.parse(quiet.stdout)).toMatchObject({
      applied: ['settings: replace', `webhook ${HOOK}/a: create`],
    })
    expect(Object.hasOwn(JSON.parse(quiet.stdout) as object, 'webhookSecrets')).toBe(false)
  })
})

/** The real host, with some of its file methods replaced. */
function hostWith(over: Partial<Host>): Host {
  return { ...createProcessHost({}), ...over }
}

describe('the secrets file of tula apply, when the file system does not cooperate', () => {
  beforeEach(() => {
    deps.outbound.point('hooks.example.test', '93.184.216.34')
  })

  const posix = process.platform !== 'win32'

  /** The run, or `'hung'` after two seconds; a pipe still being waited on is then released. */
  async function bounded(work: Promise<Run>, pipe?: string): Promise<Run | 'hung'> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        work,
        new Promise<'hung'>((resolve) => {
          timer = setTimeout(() => resolve('hung'), 2_000)
        }),
      ])
    } finally {
      clearTimeout(timer)
      if (pipe) {
        const writer = await open(pipe, constants.O_WRONLY | constants.O_NONBLOCK).catch(
          () => undefined
        )
        await writer?.close()
      }
      await work.catch(() => undefined)
    }
  }

  test.if(posix)(
    'a named pipe at --secrets-file is refused at once: no wait, no write (F1)',
    async () => {
      const config = await dev({ webhooks: [hook('a')] })
      const pipe = join(dir, 'pipe.json')
      // One process, with a timeout of its own: a child that never exits must not hang the run.
      expect(Bun.spawnSync(['mkfifo', pipe], { timeout: 5_000 }).exitCode).toBe(0)
      const run = await bounded(
        tula(['apply', '--config', config, '--yes', '--secrets-file', 'pipe.json']),
        pipe
      )
      if (run === 'hung') {
        throw new Error('the run waited on the named pipe')
      }
      expect(run.code).toBe(1)
      expect(run.stderr).toContain('error: --secrets-file: pipe.json is not a regular file.')
      expect(run.stderr).toContain('Nothing was changed.')
      expect(writes(run)).toEqual([])
      expect(await endpoints()).toEqual([])
    }
  )

  test('a file that holds an empty list is a file that is there: not replaced (F2)', async () => {
    const config = await dev({ webhooks: [hook('a')] })
    await writeFile(join(dir, 'empty.json'), '[]\n')
    const run = await tula(['apply', '--config', config, '--yes', '--secrets-file', 'empty.json'])
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('error: --secrets-file: empty.json already exists.')
    expect(run.stderr).toContain('Nothing was changed.')
    expect(writes(run)).toEqual([])
    expect(await readFile(join(dir, 'empty.json'), 'utf8')).toBe('[]\n')
  })

  test('a directory at --secrets-file is refused in words, before any write (F1)', async () => {
    const config = await dev({ webhooks: [hook('a')] })
    await mkdir(join(dir, 'folder'))
    const run = await tula(['apply', '--config', config, '--yes', '--secrets-file', 'folder'])
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('error: --secrets-file: folder is not a regular file.')
    expect(run.stderr).not.toContain('EISDIR')
    expect(run.stderr).toContain('Nothing was changed.')
    expect(writes(run)).toEqual([])
  })

  test('a file that appears between the look and the claim is not replaced, and nothing is written (F2)', async () => {
    const config = await dev({ webhooks: [hook('a')] })
    const path = join(dir, 'hooks.json')
    const real = createProcessHost({})
    const host = hostWith({
      readFile: async (file) => {
        const seen = await real.readFile(file)
        if (file === path && seen === null) {
          // Another run got there first, and has already been given its secrets.
          await writeFile(path, 'the secrets of another run')
        }
        return seen
      },
    })
    const run = await tula(['apply', '--config', config, '--yes', '--secrets-file', 'hooks.json'], {
      host,
    })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('error: --secrets-file: hooks.json already exists.')
    expect(run.stderr).toContain('Nothing was changed.')
    expect(writes(run)).toEqual([])
    expect(await readFile(path, 'utf8')).toBe('the secrets of another run')
    expect(await endpoints()).toEqual([])
  })

  test('a file swapped in after the claim is not replaced either: the run stops and says the secret was not kept (F2)', async () => {
    const config = await dev({ webhooks: [hook('a')] })
    const path = join(dir, 'hooks.json')
    const real = createProcessHost({})
    const host = hostWith({
      createSecretFile: async (file, text) => {
        await real.createSecretFile(file, text)
        await rm(file)
        await writeFile(file, 'not this run’s file')
      },
    })
    const run = await tula(['apply', '--config', config, '--yes', '--secrets-file', 'hooks.json'], {
      host,
    })
    expect(run.code).toBe(1)
    expect(await readFile(path, 'utf8')).toBe('not this run’s file')
    expect(run.stderr).toContain('its signing secret could not be written')
    expect(run.stdout + run.stderr).not.toContain('whsec_')
  })

  const failingRewrite = () =>
    hostWith({
      writeSecretFile: async () => {
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
      },
    })

  test('an endpoint whose secret could not be written is reported as created, its secret as not kept, and never printed (F3)', async () => {
    const config = await dev({ webhooks: [hook('a'), hook('b')] })
    const run = await tula(['apply', '--config', config, '--yes', '--secrets-file', 'hooks.json'], {
      host: failingRewrite(),
    })
    const [created] = await endpoints()
    expect(run.code).toBe(1)
    expect(await endpoints()).toHaveLength(1)
    expect(run.stdout).toContain(`done  webhook ${HOOK}/a: create`)
    expect(run.stderr).not.toContain(`Failed: webhook ${HOOK}/a: create`)
    expect(run.stderr).toContain(
      `error: The webhook endpoint ${HOOK}/a was created, but its signing secret could not be written to ${join(dir, 'hooks.json')}: it was not kept. ` +
        `To get one, rotate it: POST /v1/admin/webhook-endpoints/${created?.id}/secret/rotate.\n` +
        `Applied before the failure:\n  settings: replace\n  webhook ${HOOK}/a: create\n` +
        `Not applied:\n  webhook ${HOOK}/b: create\n`
    )
    // The note counts what is in the file, and nothing is.
    expect(run.stdout + run.stderr).not.toContain('Wrote ')
    expect(run.stdout + run.stderr).not.toContain('whsec_')
    expect(run.stdout + run.stderr).not.toContain('signing secret, shown this once')
    // Claimed by this run and still empty: not left behind.
    expect(await stat(join(dir, 'hooks.json')).catch(() => null)).toBeNull()
  })

  test('and with --show-secrets it is printed, exactly once, although the file failed (F3)', async () => {
    const config = await dev({ webhooks: [hook('a'), hook('b')] })
    const run = await tula(
      ['apply', '--config', config, '--yes', '--secrets-file', 'hooks.json', '--show-secrets'],
      { host: failingRewrite(), shown: true }
    )
    expect(run.code).toBe(1)
    const shown = (run.stdout + run.stderr).match(new RegExp(WHSEC.source, 'g')) ?? []
    expect(shown).toHaveLength(1)
    expect(run.stdout).toContain(`signing secret, shown this once: ${shown[0]}`)
    expect(run.stderr).toContain('it was not kept')
    SECRETS.push(shown[0] as string)
  })

  test('a secret the run was not asked to show is removed from whatever is printed later, an API error that repeats it included (F4)', async () => {
    const config = await dev({ webhooks: [hook('a'), hook('b')] })
    let first: string | undefined
    const run = await tula(['apply', '--config', config, '--yes', '--discard-secrets'], {
      observe: (method, path, body) => {
        if (method === 'POST' && path === '/v1/admin/webhook-endpoints') {
          first = (JSON.parse(body) as { secret: string }).secret
        }
      },
      intercept: (method) =>
        method === 'POST' && first !== undefined
          ? Response.json(
              { status: 500, code: 'internal', detail: `the store said: ${first} is taken` },
              { status: 500 }
            )
          : undefined,
    })
    expect(first).toMatch(WHSEC)
    SECRETS.push(first as string)
    expect(run.code).toBe(1)
    expect(run.stderr).toContain(`Failed: webhook ${HOOK}/b: create`)
    expect(run.stderr).toContain('the store said: [redacted] is taken')
    expect(run.stdout + run.stderr).not.toContain(first as string)
  })

  test('when the endpoints cannot be read again, the run says that, not that an operation failed; and its empty file is not left behind (F6)', async () => {
    const config = await dev({ settings: { app: { name: 'Northline' } }, webhooks: [hook('a')] })
    let lists = 0
    const run = await tula(['apply', '--config', config, '--yes', '--secrets-file', 'hooks.json'], {
      intercept: (method, path) => {
        if (method !== 'GET' || path !== '/v1/admin/webhook-endpoints') {
          return undefined
        }
        lists += 1
        return lists === 1
          ? undefined
          : Response.json(
              { status: 503, code: 'service.unavailable', detail: 'The service is unavailable.' },
              { status: 503 }
            )
      },
    })
    expect(run.code).toBe(1)
    expect(run.stderr).not.toContain('Failed: webhook')
    expect(run.stderr).toContain(
      'error: The webhook endpoints could not be read again before the first write to them, so nothing was written to them.\n' +
        'error: The service is unavailable. (service.unavailable, HTTP 503)\n' +
        'Applied before the failure:\n  settings: replace\n' +
        `Not applied:\n  webhook ${HOOK}/a: create\n`
    )
    expect(writes(run)).toEqual(['PUT /v1/admin/settings'])
    expect(await stat(join(dir, 'hooks.json')).catch(() => null)).toBeNull()
  })

  test('a claimed file is removed only while it is this run’s and empty: a run that kept a secret leaves it', async () => {
    const config = await dev({ webhooks: [hook('a'), hook('b')] })
    let posts = 0
    const run = await tula(['apply', '--config', config, '--yes', '--secrets-file', 'hooks.json'], {
      intercept: (method) => {
        posts += method === 'POST' ? 1 : 0
        return method === 'POST' && posts === 2
          ? Response.json(
              { status: 503, code: 'service.unavailable', detail: 'The service is unavailable.' },
              { status: 503 }
            )
          : undefined
      },
    })
    expect(run.code).toBe(1)
    const kept = JSON.parse(await readFile(join(dir, 'hooks.json'), 'utf8')) as Endpoint[]
    expect(kept.map((entry) => entry.url)).toEqual([`${HOOK}/a`])
    expect(run.stderr).toContain('Wrote 1 signing secret to')
    SECRETS.push(kept[0]?.secret as string)
  })
})

const ASK = 'https://ask.example.test/tula'

interface ListedHook {
  id: string
  point: string
  url: string
  enabled: boolean
  deadlineMs: number
  failureMode: string
  secret?: string
}

async function hooks(): Promise<ListedHook[]> {
  const body = (await (await admin('/v1/admin/hooks')).json()) as { data: ListedHook[] }
  return body.data
}

/** Register a hook the way a person would, outside the file. Its secret is never to be printed. */
async function registerHook(point: string, over: Record<string, unknown> = {}): Promise<string> {
  const res = await admin('/v1/admin/hooks', {
    method: 'POST',
    body: JSON.stringify({ point, url: `${ASK}/${point}`, ...over }),
  })
  expect(res.status).toBe(201)
  const created = (await res.json()) as ListedHook
  SECRETS.push(created.secret as string)
  return created.id
}

async function patchHook(id: string, body: Record<string, unknown>): Promise<void> {
  const res = await admin(`/v1/admin/hooks/${id}`, { method: 'PATCH', body: JSON.stringify(body) })
  expect(res.status).toBe(200)
}

/** The run's writes to hooks, ids masked. */
const hookWrites = (run: Run) =>
  writes(run)
    .filter((request) => request.includes('/v1/admin/hooks'))
    .map((request) => request.replace(/[0-9a-f-]{36}/, '<id>'))

/** What the audit log holds for hook changes, newest first: the action and its `metadata`. */
async function hookAudit(action: string): Promise<Record<string, unknown>[]> {
  const log = (await (await admin(`/v1/admin/audit-logs?action=${action}`)).json()) as {
    data: { metadata: Record<string, unknown> }[]
  }
  return log.data.map((entry) => entry.metadata)
}

describe('hooks in the config file', () => {
  beforeEach(() => {
    deps.outbound.point('ask.example.test', '93.184.216.34')
    deps.outbound.point('hooks.example.test', '93.184.216.34')
  })

  test('a hook is planned (exit 2), created, its secret kept in the file under its point, and then nothing is left', async () => {
    const config = await dev({ hooks: { before_sign_up: { url: `${ASK}/sign-up` } } })

    const before = await tula(['diff', '--config', config])
    expect(before.code).toBe(2)
    expect(before.stdout).toContain(
      `Hooks\n  + before_sign_up: create (url ${ASK}/sign-up, enabled true, deadlineMs 2000, failureMode "deny"; a signing secret is made, shown once)\n`
    )
    expect(before.stdout).toContain(
      '! creates 1 hook: its signing secret is shown once, to the run that creates it (`tula apply` needs --secrets-file <path>, --show-secrets or --discard-secrets)'
    )
    // Registering a hook that refuses on failure is the operator's choice, not a weakening.
    expect(before.stdout).not.toContain('weakens security')
    expect(writes(before)).toEqual([])
    expect(await hooks()).toEqual([])

    const applied = await tula([
      'apply',
      '--config',
      config,
      '--yes',
      '--secrets-file',
      'kept.json',
    ])
    expect(applied.code).toBe(0)
    expect(writes(applied)).toEqual(['PUT /v1/admin/settings', 'POST /v1/admin/hooks'])
    expect(applied.stdout).toContain('done  hook before_sign_up: create')
    expect(applied.stdout).toContain(
      `Wrote 1 signing secret to ${join(dir, 'kept.json')} (mode 0600). It is not shown again: give it to the receiver, then delete the file.`
    )
    expect(applied.stdout + applied.stderr).not.toContain('whsec_')
    expect(applied.stdout + applied.stderr).not.toContain('signing secret, shown this once')
    const [created] = await hooks()
    expect(created).toMatchObject({
      point: 'before_sign_up',
      url: `${ASK}/sign-up`,
      enabled: true,
      deadlineMs: 2000,
      failureMode: 'deny',
    })
    const file = join(dir, 'kept.json')
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    const kept = JSON.parse(await readFile(file, 'utf8')) as Record<string, string>[]
    expect(kept).toHaveLength(1)
    // A hook's entry says so first: its point.
    expect(Object.keys(kept[0] ?? {})).toEqual(['hook', 'id', 'url', 'secret'])
    expect(kept[0]).toMatchObject({
      hook: 'before_sign_up',
      id: created?.id as string,
      url: `${ASK}/sign-up`,
    })
    expect(kept[0]?.secret).toMatch(new RegExp(`^${WHSEC.source}$`))
    SECRETS.push(kept[0]?.secret as string)

    const after = await tula(['diff', '--config', config])
    expect(after.code).toBe(0)
    expect(after.stdout).toContain('= before_sign_up: unchanged')
    const second = await tula(['apply', '--config', config, '--yes'])
    expect(second.stdout).toContain('No changes')
    expect(writes(second)).toEqual([])
  })

  test('one secrets file for both kinds: an endpoint’s entry is what it has always been, a hook’s begins with its point', async () => {
    const config = await dev({
      webhooks: [hook('a')],
      hooks: { before_session: { url: `${ASK}/session` } },
    })
    const run = await tula(['apply', '--config', config, '--yes', '--secrets-file', 'kept.json'])
    expect(run.code).toBe(0)
    // Hooks after the endpoints: an endpoint this run registers is there to hear of them.
    expect(writes(run)).toEqual([
      'PUT /v1/admin/settings',
      'POST /v1/admin/webhook-endpoints',
      'POST /v1/admin/hooks',
    ])
    expect(run.stdout).toContain(`Wrote 2 signing secrets to ${join(dir, 'kept.json')}`)
    const text = await readFile(join(dir, 'kept.json'), 'utf8')
    const kept = JSON.parse(text) as Record<string, string>[]
    const [endpoint] = await endpoints()
    const [asked] = await hooks()
    for (const entry of kept) {
      SECRETS.push(entry.secret as string)
    }
    // The whole file, as text: what a webhook-only run wrote before hooks could be in it is
    // what such an entry still is.
    expect(text).toBe(
      `${JSON.stringify(
        [
          { id: endpoint?.id, url: `${HOOK}/a`, secret: kept[0]?.secret },
          { hook: 'before_session', id: asked?.id, url: `${ASK}/session`, secret: kept[1]?.secret },
        ],
        null,
        2
      )}\n`
    )
    expect(run.stdout + run.stderr).not.toContain('whsec_')
  })

  test('a webhook-only run writes the file it always wrote', async () => {
    const config = await dev({ webhooks: [hook('a')], hooks: {} })
    const run = await tula(['apply', '--config', config, '--yes', '--secrets-file', 'kept.json'])
    expect(run.code).toBe(0)
    const text = await readFile(join(dir, 'kept.json'), 'utf8')
    const [endpoint] = await endpoints()
    const secret = (JSON.parse(text) as { secret: string }[])[0]?.secret as string
    SECRETS.push(secret)
    expect(text).toBe(
      `[\n  {\n    "id": "${endpoint?.id}",\n    "url": "${HOOK}/a",\n    "secret": "${secret}"\n  }\n]\n`
    )
  })

  test('a plan that creates a hook is refused before any write until the run is told what to do with the secret', async () => {
    const one = await dev({
      settings: { app: { name: 'Northline' } },
      hooks: { before_sign_up: { url: `${ASK}/sign-up` } },
    })
    const run = await tula(['apply', '--config', one, '--yes'])
    expect(run.code).toBe(1)
    expect(run.stderr).toContain(
      'error: This plan creates 1 hook, and the server shows its signing secret only once, in its answer to this run. Nothing was changed. Say what to do with it:'
    )
    expect(run.stderr).toContain(
      '--discard-secrets      keep nothing. A hook’s secret cannot be rotated: to get one later, remove the hook and add it again (its receiver cannot verify a question until then).'
    )
    expect(writes(run)).toEqual([])

    const both = await dev({
      webhooks: [hook('a'), hook('b')],
      hooks: { before_sign_up: { url: `${ASK}/sign-up` } },
    })
    const mixed = await tula(['apply', '--config', both, '--yes'])
    expect(mixed.code).toBe(1)
    expect(mixed.stderr).toContain(
      'error: This plan creates 2 webhook endpoints and 1 hook, and the server shows each signing secret only once, in its answer to this run. Nothing was changed. Say what to do with them:'
    )
    expect(writes(mixed)).toEqual([])
    expect(await hooks()).toEqual([])
    expect(await endpoints()).toEqual([])
    expect((await state()).revision).toBe(0)
  })

  test('--show-secrets prints a hook’s secret once; --discard-secrets keeps nothing and says what that costs', async () => {
    const shownConfig = await dev({ hooks: { before_sign_up: { url: `${ASK}/sign-up` } } })
    const shown = await tula(['apply', '--config', shownConfig, '--yes', '--show-secrets'], {
      shown: true,
    })
    expect(shown.code).toBe(0)
    const printed = shown.stdout.match(new RegExp(WHSEC.source, 'g')) ?? []
    expect(printed).toHaveLength(1)
    expect(shown.stdout).toContain(
      `done  hook before_sign_up: create\n        signing secret, shown this once: ${printed[0]}`
    )
    expect(shown.stderr).not.toContain('whsec_')
    SECRETS.push(printed[0] as string)

    const quietConfig = await dev({
      hooks: {
        before_sign_up: { url: `${ASK}/sign-up` },
        before_token: { url: `${ASK}/token` },
      },
    })
    const quiet = await tula(['apply', '--config', quietConfig, '--yes', '--discard-secrets'])
    expect(quiet.code).toBe(0)
    expect(quiet.stdout + quiet.stderr).not.toContain('whsec_')
    expect(quiet.stdout).toContain(
      '1 signing secret of a hook was not kept (--discard-secrets). A hook’s secret cannot be rotated: to get one, remove the hook and apply again.'
    )
    expect((await hooks()).map((entry) => entry.point)).toEqual(['before_sign_up', 'before_token'])
  })

  test('“allow on failure” is flagged as weaker by diff, and not applied by --yes alone: nothing is written', async () => {
    const id = await registerHook('before_sign_up')
    const strict = await dev({ hooks: { before_sign_up: { url: `${ASK}/before_sign_up` } } })
    await tula(['apply', '--config', strict, '--yes'])
    const before = await state()
    const loose = await dev({
      hooks: { before_sign_up: { url: `${ASK}/before_sign_up`, failureMode: 'allow' } },
    })

    const plan = await tula(['diff', '--config', loose])
    expect(plan.code).toBe(2)
    expect(plan.stdout).toContain('~ before_sign_up: update (failureMode "deny" → "allow")')
    expect(plan.stdout).toContain(
      '! weakens security: hooks.before_sign_up.failureMode (`tula apply --yes` needs --allow-weaker)'
    )
    expect(plan.stdout).toContain(
      '`tula apply --yes` refuses this plan without --allow-weaker: it weakens security.'
    )

    const refused = await tula(['apply', '--config', loose, '--yes'])
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain(
      'error: This plan weakens security (hooks.before_sign_up.failureMode), and with --yes nobody is asked. Nothing was changed. Pass --allow-weaker with --yes to apply it.'
    )
    expect(writes(refused)).toEqual([])
    expect(await state()).toEqual(before)
    expect((await hooks())[0]?.failureMode).toBe('deny')

    const allowed = await tula(['apply', '--config', loose, '--yes', '--allow-weaker'])
    expect(allowed.code).toBe(0)
    expect(hookWrites(allowed)).toEqual(['PATCH /v1/admin/hooks/<id>'])
    expect(await hooks()).toMatchObject([{ id, failureMode: 'allow' }])
    // The server recorded the same change as a weakening: one rule, the contract's.
    expect((await hookAudit('hook.updated'))[0]).toMatchObject({
      changed: ['failureMode'],
      weakened: true,
    })
    // And tightening it again needs no word.
    const back = await tula(['apply', '--config', strict, '--yes'])
    expect(back.code).toBe(0)
    expect((await hooks())[0]?.failureMode).toBe('deny')
  })

  test('at a terminal the question says what gets weaker', async () => {
    await registerHook('before_session')
    const config = await dev({
      hooks: { before_session: { url: `${ASK}/before_session`, enabled: false } },
    })
    const asked: string[] = []
    const run = await tula(['apply', '--config', config], {
      isTTY: true,
      prompt: async (question) => {
        asked.push(question)
        return 'no'
      },
    })
    expect(run.code).toBe(1)
    expect(asked).toHaveLength(1)
    expect(asked[0]).toStartWith('This WEAKENS security (hooks.before_session.enabled). ')
    expect(writes(run)).toEqual([])
    expect((await hooks())[0]?.enabled).toBe(true)
  })

  test('a hook registered to let through on failure is a weakening too, refused before the secret is asked about', async () => {
    const config = await dev({
      hooks: { before_token: { url: `${ASK}/token`, failureMode: 'allow' } },
    })
    const refused = await tula(['apply', '--config', config, '--yes', '--discard-secrets'])
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain('weakens security (hooks.before_token.failureMode)')
    expect(writes(refused)).toEqual([])
    expect(await hooks()).toEqual([])

    const allowed = await tula([
      'apply',
      '--config',
      config,
      '--yes',
      '--discard-secrets',
      '--allow-weaker',
    ])
    expect(allowed.code).toBe(0)
    expect((await hookAudit('hook.created'))[0]).toMatchObject({
      failureMode: 'allow',
      weakened: true,
    })
  })

  test('a point the file leaves out is left alone; --prune removes it, and a hook that is on only with --allow-weaker', async () => {
    await registerHook('before_sign_up')
    await registerHook('before_session')
    const off = await registerHook('before_token', { enabled: false })
    const config = await dev({ hooks: { before_sign_up: { url: `${ASK}/before_sign_up` } } })

    const kept = await tula(['apply', '--config', config, '--yes'])
    expect(kept.code).toBe(0)
    expect(kept.stdout).toContain(
      '= before_session: unmanaged (on the server, not in the file; --prune removes it)'
    )
    expect(hookWrites(kept)).toEqual([])
    expect(await hooks()).toHaveLength(3)

    const plan = await tula(['diff', '--config', config, '--prune'])
    expect(plan.stdout).toContain(
      `- before_session: remove (${ASK}/before_session), with its signing secret`
    )
    // Only the hook that is on: removing one that is off lets nothing new through.
    expect(plan.stdout).toContain('! weakens security: hooks.before_session (`tula apply --yes`')

    const refused = await tula(['apply', '--config', config, '--yes', '--prune'])
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain('weakens security (hooks.before_session)')
    expect(writes(refused)).toEqual([])
    expect(await hooks()).toHaveLength(3)

    const pruned = await tula(['apply', '--config', config, '--yes', '--prune', '--allow-weaker'])
    expect(pruned.code).toBe(0)
    expect(hookWrites(pruned)).toEqual([
      'DELETE /v1/admin/hooks/<id>',
      'DELETE /v1/admin/hooks/<id>',
    ])
    expect(pruned.stdout).toContain('done  hook before_session: remove')
    expect((await hooks()).map((entry) => entry.point)).toEqual(['before_sign_up'])
    expect((await hooks()).some((entry) => entry.id === off)).toBe(false)
  })

  test('removing only a hook that is off needs no --allow-weaker', async () => {
    await registerHook('before_token', { enabled: false })
    const config = await dev({ hooks: {} })
    const run = await tula(['apply', '--config', config, '--yes', '--prune'])
    expect(run.code).toBe(0)
    expect(run.stdout).not.toContain('weakens security')
    expect(await hooks()).toEqual([])
  })

  test('a file without a hooks key does not read the hooks, and --prune does not touch them', async () => {
    await registerHook('before_sign_up')
    const config = await dev({ settings: { app: { name: 'Northline' } } })
    const run = await tula(['apply', '--config', config, '--yes', '--prune'])
    expect(run.code).toBe(0)
    expect(run.requests.filter((request) => request.includes('/v1/admin/hooks'))).toEqual([])
    expect(run.stdout).not.toContain('Hooks')
    expect(await hooks()).toHaveLength(1)
  })

  test('a changed address is the same hook: one PATCH of that field, no new secret', async () => {
    const id = await registerHook('before_sign_up', { deadlineMs: 4000 })
    const config = await dev({
      hooks: { before_sign_up: { url: `${ASK}/moved`, deadlineMs: 4000 } },
    })
    const bodies: string[] = []
    const run = await tula(['apply', '--config', config, '--yes'], { bodies })
    expect(run.code).toBe(0)
    expect(run.stdout).toContain(
      `~ before_sign_up: update (url ${ASK}/before_sign_up → ${ASK}/moved)`
    )
    expect(hookWrites(run)).toEqual(['PATCH /v1/admin/hooks/<id>'])
    expect(bodies.map((body) => JSON.parse(body) as object).at(-1)).toEqual({
      url: `${ASK}/moved`,
    })
    expect(await hooks()).toMatchObject([{ id, url: `${ASK}/moved`, deadlineMs: 4000 }])
    expect(run.stdout + run.stderr).not.toContain('secret')
  })

  test('an address the server refuses: its code and its fixed reason and no more, with what came before it applied', async () => {
    const config = await dev({
      settings: { app: { name: 'Northline' } },
      hooks: {
        before_sign_up: { url: `${ASK}/sign-up` },
        before_session: { url: 'https://canary-nowhere.example.test/ask' },
      },
    })
    const run = await tula(['apply', '--config', config, '--yes', '--secrets-file', 'kept.json'])
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('Failed: hook before_session: create')
    expect(run.stderr).toContain('(hook.url_not_allowed, HTTP 422)\n  reason: resolve_failed\n')
    expect(run.stderr).toContain(
      'Applied before the failure:\n  settings: replace\n  hook before_sign_up: create\n' +
        'Not applied:\n  hook before_session: create\n'
    )
    expect(run.stderr).toContain(`Wrote 1 signing secret to ${join(dir, 'kept.json')} (mode 0600).`)
    expect(run.stdout + run.stderr).not.toContain('whsec_')
    expect((await hooks()).map((entry) => entry.point)).toEqual(['before_sign_up'])
    const kept = JSON.parse(await readFile(join(dir, 'kept.json'), 'utf8')) as ListedHook[]
    SECRETS.push(kept[0]?.secret as string)
  })

  test('hooks changed by someone else between the plan and the write are not written to', async () => {
    const id = await registerHook('before_sign_up')
    const config = await dev({
      settings: { app: { name: 'Northline' } },
      hooks: { before_sign_up: { url: `${ASK}/before_sign_up`, deadlineMs: 3000 } },
    })
    const run = await tula(['apply', '--config', config], {
      isTTY: true,
      prompt: async () => {
        // The plan weakens nothing. What it would write over meanwhile lets through on failure.
        await patchHook(id, { failureMode: 'allow' })
        return 'yes'
      },
    })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain(
      'error: The hooks were changed by someone else after this plan was made. Nothing was written to them. Run `tula diff` again and review the new plan.\n' +
        'Applied before the failure:\n  settings: replace\n' +
        'Not applied:\n  hook before_sign_up: update\n'
    )
    expect(writes(run)).toEqual(['PUT /v1/admin/settings'])
    expect(await hooks()).toMatchObject([{ deadlineMs: 2000, failureMode: 'allow' }])
  })

  test('when the hooks cannot be read again, the run says that, not that an operation failed', async () => {
    const config = await dev({ hooks: { before_sign_up: { url: `${ASK}/sign-up` } } })
    let lists = 0
    const run = await tula(['apply', '--config', config, '--yes', '--secrets-file', 'kept.json'], {
      intercept: (method, path) => {
        if (method !== 'GET' || path !== '/v1/admin/hooks') {
          return undefined
        }
        lists += 1
        return lists === 1
          ? undefined
          : Response.json(
              { status: 503, code: 'service.unavailable', detail: 'The service is unavailable.' },
              { status: 503 }
            )
      },
    })
    expect(run.code).toBe(1)
    expect(run.stderr).not.toContain('Failed: hook')
    expect(run.stderr).toContain(
      'error: The hooks could not be read again before the first write to them, so nothing was written to them.\n' +
        'error: The service is unavailable. (service.unavailable, HTTP 503)\n'
    )
    expect(hookWrites(run)).toEqual([])
    expect(await stat(join(dir, 'kept.json')).catch(() => null)).toBeNull()
  })

  test('a hook whose secret could not be written is reported as created, its secret as not kept, and never printed', async () => {
    const config = await dev({
      hooks: {
        before_sign_up: { url: `${ASK}/sign-up` },
        before_token: { url: `${ASK}/token` },
      },
    })
    const run = await tula(['apply', '--config', config, '--yes', '--secrets-file', 'kept.json'], {
      host: hostWith({
        writeSecretFile: async () => {
          throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
        },
      }),
    })
    expect(run.code).toBe(1)
    expect((await hooks()).map((entry) => entry.point)).toEqual(['before_sign_up'])
    expect(run.stdout).toContain('done  hook before_sign_up: create')
    expect(run.stderr).not.toContain('Failed: hook before_sign_up: create')
    expect(run.stderr).toContain(
      `error: The hook before_sign_up was created, but its signing secret could not be written to ${join(dir, 'kept.json')}: it was not kept. ` +
        'A hook’s secret cannot be rotated: to get one, remove the hook and apply again.\n' +
        'Applied before the failure:\n  settings: replace\n  hook before_sign_up: create\n' +
        'Not applied:\n  hook before_token: create\n'
    )
    expect(run.stdout + run.stderr).not.toContain('Wrote ')
    expect(run.stdout + run.stderr).not.toContain('whsec_')
  })

  test('a secret the run was not asked to show is removed from whatever is printed later, an API error that repeats it included', async () => {
    const config = await dev({
      hooks: {
        before_sign_up: { url: `${ASK}/sign-up` },
        before_token: { url: `${ASK}/token` },
      },
    })
    let first: string | undefined
    const run = await tula(['apply', '--config', config, '--yes', '--discard-secrets'], {
      observe: (method, path, body) => {
        if (method === 'POST' && path === '/v1/admin/hooks') {
          first = (JSON.parse(body) as { secret: string }).secret
        }
      },
      intercept: (method) =>
        method === 'POST' && first !== undefined
          ? Response.json(
              { status: 500, code: 'internal', detail: `the store said: ${first} is taken` },
              { status: 500 }
            )
          : undefined,
    })
    expect(first).toMatch(WHSEC)
    SECRETS.push(first as string)
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('Failed: hook before_token: create')
    expect(run.stderr).toContain('the store said: [redacted] is taken')
    expect(run.stdout + run.stderr).not.toContain(first as string)
  })

  test('a secret written in the file is refused before any request, and not repeated', async () => {
    const literal = 'whsec_d3JpdHRlbi1pbi1hLWhvb2stZG8tbm90LXByaW50MTI='
    const config = await dev({
      hooks: { before_sign_up: { url: `${ASK}/sign-up`, secret: literal } },
    })
    SECRETS.push(literal)
    const run = await tula(['diff', '--config', config])
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('environments.dev.hooks.before_sign_up.secret: unknown key')
    expect(run.requests).toEqual([])
  })

  test('--json carries the hooks, what apply will ask for, and a secret only when asked', async () => {
    await registerHook('before_session')
    const config = await dev({ hooks: { before_sign_up: { url: `${ASK}/sign-up` } } })
    const plan = JSON.parse(
      (await tula(['diff', '--config', config, '--json', '--prune'])).stdout
    ) as {
      hooks: { managed: boolean; hooks: { point: string; action: string; weakened: string[] }[] }
      weakened: string[]
      applyRequires: Record<string, boolean>
    }
    expect(plan.hooks.managed).toBe(true)
    expect(plan.hooks.hooks).toMatchObject([
      { point: 'before_sign_up', action: 'create', weakened: [] },
      { point: 'before_session', action: 'delete', weakened: ['hooks.before_session'] },
    ])
    expect(plan.weakened).toEqual(['hooks.before_session'])
    expect(plan.applyRequires).toEqual({
      allowUnknown: false,
      allowWeaker: true,
      allowWebhookRemoval: false,
      webhookSecrets: false,
      hookSecrets: true,
    })
    const quiet = await tula(['apply', '--config', config, '--yes', '--json', '--discard-secrets'])
    expect(quiet.code).toBe(0)
    expect(quiet.stdout).not.toContain('whsec_')
    expect(JSON.parse(quiet.stdout)).toMatchObject({
      applied: ['settings: replace', 'hook before_sign_up: create'],
    })
    expect(Object.hasOwn(JSON.parse(quiet.stdout) as object, 'hookSecrets')).toBe(false)

    const loud = await dev({ hooks: { before_token: { url: `${ASK}/token` } } })
    const shown = await tula(['apply', '--config', loud, '--yes', '--json', '--show-secrets'], {
      shown: true,
    })
    const answer = JSON.parse(shown.stdout) as {
      webhookSecrets: unknown[]
      hookSecrets: { hook: string; secret: string }[]
    }
    expect(answer.webhookSecrets).toEqual([])
    expect(answer.hookSecrets).toHaveLength(1)
    expect(answer.hookSecrets[0]?.hook).toBe('before_token')
    expect(answer.hookSecrets[0]?.secret).toMatch(WHSEC)
    SECRETS.push(answer.hookSecrets[0]?.secret as string)
  })
})

// Declared last, so it runs after every run above.
test('no secret that passed through any run was printed, to either stream', () => {
  const printed = everythingPrinted.join('\n')
  expect(printed.length).toBeGreaterThan(1000)
  expect(SECRETS.filter((secret) => secret.startsWith('whsec_')).length).toBeGreaterThan(10)
  for (const secret of SECRETS) {
    expect(printed).not.toContain(secret)
  }
  // Whatever the server made in any run, known to this file or not: nothing shaped like a
  // webhook signing secret was printed by a run that was not asked to (`shown`).
  expect(printed).not.toMatch(WHSEC)
})
