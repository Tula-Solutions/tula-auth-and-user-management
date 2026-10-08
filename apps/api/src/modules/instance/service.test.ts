import { describe, expect, test } from 'bun:test'
import type { MemoryDiagnostics } from '~/adapters/memory/diagnostics'
import { createSecretBox } from '~/lib/secret-box'
import * as Audit from '~/modules/audit/service'
import * as Instance from '~/modules/instance/service'
import * as Jwks from '~/modules/jwks/service'
import * as OAuth from '~/modules/oauth/service'
import { createTestDeps, TEST_ACTOR, TEST_CONFIG, TEST_TENANT, type TestDeps } from '~/testing'
import type { DiagnosticCheck } from './schema'

const tenant = { projectId: TEST_TENANT.projectId, environmentId: TEST_TENANT.environmentId }

/** Strings a driver might put in an error. None may ever reach the answer. */
const CANARIES = [
  'postgres://tula_api:CANARY-db-password@db.internal:5432/tula',
  'CANARY-smtp-password',
  'redis://:CANARY-redis-password@cache.internal:6379',
  'CANARY-internal-message',
  'CANARY-client-secret',
]

async function setup(overrides: Partial<TestDeps> = {}) {
  const deps = createTestDeps(overrides)
  deps.environments.add({
    id: TEST_TENANT.environmentId,
    projectId: TEST_TENANT.projectId,
    kind: 'development',
    createdAt: deps.clock.now(),
  })
  await Jwks.ensureKeys(deps, TEST_TENANT.environmentId)
  const diagnostics = deps.diagnostics as MemoryDiagnostics
  return { deps, diagnostics }
}

function byId(checks: DiagnosticCheck[], id: string): DiagnosticCheck {
  const check = checks.find((candidate) => candidate.id === id)
  if (!check) {
    throw new Error(`no check ${id}`)
  }
  return check
}

function expectNoCanary(value: unknown) {
  const text = JSON.stringify(value)
  for (const canary of CANARIES) {
    expect(text).not.toContain(canary)
  }
  expect(text).not.toContain('CANARY')
}

describe('Instance.diagnostics', () => {
  test('a healthy deployment: every check is ok or skipped, in a stable order', async () => {
    const { deps } = await setup()
    const result = await Instance.diagnostics(deps)
    expect(result.checks.map((check) => check.id)).toEqual([
      'database',
      'migrations',
      'master_key',
      'smtp',
      'redis',
      'clock',
      'public_url',
      'oauth_redirect_uris',
    ])
    expect(byId(result.checks, 'database').status).toBe('ok')
    expect(byId(result.checks, 'migrations').status).toBe('ok')
    expect(byId(result.checks, 'master_key').status).toBe('ok')
    expect(byId(result.checks, 'smtp').status).toBe('ok')
    expect(byId(result.checks, 'clock').status).toBe('ok')
    // No Redis in the test deployment, a loopback PUBLIC_URL, no provider.
    expect(byId(result.checks, 'redis').status).toBe('skipped')
    expect(byId(result.checks, 'public_url').status).toBe('skipped')
    expect(byId(result.checks, 'oauth_redirect_uris').status).toBe('skipped')
    for (const check of result.checks) {
      expect(check.fix === undefined).toBe(check.status === 'ok' || check.status === 'skipped')
    }
    expect(result.publicUrl).toBe(TEST_CONFIG.publicUrl)
    expect(result.environment).toBe('local')
    expect(result.time).toBe(deps.clock.now().toISOString())
  })

  test('an unreachable database fails its check and skips the ones that need it', async () => {
    const { deps, diagnostics } = await setup()
    diagnostics.database = async () => {
      throw new Error(`connect failed for ${CANARIES[0]}`)
    }
    const result = await Instance.diagnostics(deps)
    expect(byId(result.checks, 'database').status).toBe('fail')
    expect(byId(result.checks, 'database').fix).toContain('DATABASE_URL')
    expect(byId(result.checks, 'migrations').status).toBe('skipped')
    expect(byId(result.checks, 'clock').status).toBe('skipped')
    expectNoCanary(result)
  })

  test('a database behind the shipped migrations fails with the migrate command', async () => {
    const { deps, diagnostics } = await setup()
    diagnostics.shippedMigrations = [1, 2, 3]
    diagnostics.database = async () => ({ appliedMigrations: [1, 2], now: deps.clock.now() })
    const check = byId((await Instance.diagnostics(deps)).checks, 'migrations')
    expect(check.status).toBe('fail')
    expect(check.summary).toContain('2 of 3')
    expect(check.fix).toContain('migrate')
  })

  test('a migration history that cannot be read counts as not migrated', async () => {
    const { deps, diagnostics } = await setup()
    diagnostics.database = async () => ({ appliedMigrations: null, now: deps.clock.now() })
    const check = byId((await Instance.diagnostics(deps)).checks, 'migrations')
    expect(check.status).toBe('fail')
    expect(check.fix).toContain('migrate')
  })

  test('a database migrated by a newer version is a warning', async () => {
    const { deps, diagnostics } = await setup()
    diagnostics.database = async () => ({ appliedMigrations: [1, 2, 3, 4], now: deps.clock.now() })
    const check = byId((await Instance.diagnostics(deps)).checks, 'migrations')
    expect(check.status).toBe('warn')
    expect(check.fix).toBeDefined()
  })

  test('a master key that does not open the signing keys fails', async () => {
    const { deps } = await setup()
    const result = await Instance.diagnostics({
      ...deps,
      secretBox: createSecretBox('cd'.repeat(32)),
    })
    const check = byId(result.checks, 'master_key')
    expect(check.status).toBe('fail')
    expect(check.fix).toContain('TULA_MASTER_KEY')
    expectNoCanary(result)
  })

  test('a master key that does not open a provider credential fails', async () => {
    const { deps } = await setup()
    await OAuth.update(
      deps,
      tenant,
      'github',
      { clientId: 'client', clientSecret: 'CANARY-client-secret', enabled: true },
      TEST_ACTOR
    )
    const healthy = await Instance.diagnostics(deps)
    expect(byId(healthy.checks, 'master_key').status).toBe('ok')
    expect(byId(healthy.checks, 'master_key').summary).toContain('1 provider credential')

    // The signing keys still open (re-sealed below is not needed: only the provider row is swapped).
    const [record] = await deps.oauthProviders.list(TEST_TENANT.environmentId)
    await deps.oauthProviders.upsert(
      {
        ...(record as NonNullable<typeof record>),
        secret: await createSecretBox('cd'.repeat(32)).seal(
          OAuth.OAUTH_SECRET_PURPOSE,
          new TextEncoder().encode('{}'),
          `${TEST_TENANT.environmentId}:github`
        ),
      },
      Audit.none('fixture')
    )
    const broken = await Instance.diagnostics(deps)
    expect(byId(broken.checks, 'master_key').status).toBe('fail')
    expectNoCanary(broken)
  })

  test('more environments than one run opens: a warning that says how many were checked', async () => {
    const { deps } = await setup()
    const base = deps.clock.now().getTime()
    const add = (index: number) => {
      const id = `00000000-0000-7000-8000-${String(index).padStart(12, '0')}`
      deps.environments.add({
        id,
        projectId: TEST_TENANT.projectId,
        kind: 'development',
        createdAt: new Date(base + index),
      })
      return id
    }
    for (let index = 1; index < Instance.MAX_ENVIRONMENTS_CHECKED; index += 1) {
      add(index)
    }
    // The newest, one past the bound: its signing keys are sealed under another master key.
    const beyond = add(Instance.MAX_ENVIRONMENTS_CHECKED)
    await Jwks.ensureKeys({ ...deps, secretBox: createSecretBox('cd'.repeat(32)) }, beyond)

    const check = byId((await Instance.diagnostics(deps)).checks, 'master_key')
    expect(check.status).toBe('warn')
    expect(check.summary).toContain('the first 200 of 201 environments')
    expect(check.fix).toBeDefined()

    // The order is the environments' age, whatever order the store answers in.
    const all = await deps.environments.listAll()
    const reversed = { ...deps.environments, listAll: async () => [...all].reverse() }
    const again = await Instance.diagnostics({
      ...deps,
      environments: reversed as unknown as TestDeps['environments'],
    })
    expect(byId(again.checks, 'master_key')).toEqual(check)
  })

  test('a secret that does not open among the first environments still fails when truncated', async () => {
    const { deps } = await setup()
    for (let index = 1; index <= Instance.MAX_ENVIRONMENTS_CHECKED; index += 1) {
      deps.environments.add({
        id: `00000000-0000-7000-8000-${String(index).padStart(12, '0')}`,
        projectId: TEST_TENANT.projectId,
        kind: 'development',
        createdAt: new Date(deps.clock.now().getTime() + index),
      })
    }
    const result = await Instance.diagnostics({
      ...deps,
      secretBox: createSecretBox('cd'.repeat(32)),
    })
    const check = byId(result.checks, 'master_key')
    expect(check.status).toBe('fail')
    expect(check.summary).toContain('the first 200 of 201 environments')
  })

  test('a scan cut off by the timeout makes no further store calls', async () => {
    const { deps } = await setup()
    for (let index = 1; index <= 5; index += 1) {
      deps.environments.add({
        id: `00000000-0000-7000-8000-${String(index).padStart(12, '0')}`,
        projectId: TEST_TENANT.projectId,
        kind: 'development',
        createdAt: new Date(deps.clock.now().getTime() + index),
      })
    }
    let calls = 0
    const slow = {
      list: async () => {
        calls += 1
        await new Promise((resolve) => setTimeout(resolve, 80))
        return []
      },
    }
    const slowDeps = { ...deps, signingKeys: slow as unknown as TestDeps['signingKeys'] }
    const result = await Instance.diagnostics(slowDeps, 50)
    expect(byId(result.checks, 'master_key').status).toBe('skipped')
    expect(calls).toBe(1)
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(calls).toBe(1)
  })

  test('a store that never answers: later runs do not start another scan on top of it', async () => {
    const { deps } = await setup()
    let calls = 0
    const stuck = {
      list: () => {
        calls += 1
        return new Promise<never>(() => {})
      },
    }
    const stuckDeps = { ...deps, signingKeys: stuck as unknown as TestDeps['signingKeys'] }
    const first = await Instance.diagnostics(stuckDeps, 50)
    expect(byId(first.checks, 'master_key').status).toBe('skipped')
    expect(calls).toBe(1)
    const second = await Instance.diagnostics(stuckDeps, 50)
    expect(byId(second.checks, 'master_key').status).toBe('skipped')
    expect(calls).toBe(1)
    // The other checks are unaffected.
    expect(byId(second.checks, 'database').status).toBe('ok')
  })

  test('concurrent callers share one run; the next caller gets a new one', async () => {
    const { deps, diagnostics } = await setup()
    let scans = 0
    let probes = 0
    const listAll = deps.environments.listAll.bind(deps.environments)
    deps.environments.listAll = async () => {
      scans += 1
      return listAll()
    }
    diagnostics.smtp = async () => {
      probes += 1
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const [one, two] = await Promise.all([Instance.diagnostics(deps), Instance.diagnostics(deps)])
    expect(scans).toBe(1)
    expect(probes).toBe(1)
    expect(two).toEqual(one)
    await Instance.diagnostics(deps)
    expect(scans).toBe(2)
    expect(probes).toBe(2)
  })

  test('nothing sealed yet: the master key check is skipped', async () => {
    const deps = createTestDeps()
    const check = byId((await Instance.diagnostics(deps)).checks, 'master_key')
    expect(check.status).toBe('skipped')
  })

  test('an unreachable mail relay fails without the driver’s message', async () => {
    const { deps, diagnostics } = await setup()
    diagnostics.smtp = async () => {
      throw new Error('535 auth failed for user mailer with CANARY-smtp-password')
    }
    const result = await Instance.diagnostics(deps)
    const check = byId(result.checks, 'smtp')
    expect(check.status).toBe('fail')
    expect(check.fix).toContain('SMTP_URL')
    expectNoCanary(result)
  })

  test('Redis: ok when it answers, fail when it does not', async () => {
    const { deps, diagnostics } = await setup()
    diagnostics.redis = async () => {}
    expect(byId((await Instance.diagnostics(deps)).checks, 'redis').status).toBe('ok')
    diagnostics.redis = async () => {
      throw new Error(`ECONNREFUSED ${CANARIES[2]}`)
    }
    const result = await Instance.diagnostics(deps)
    expect(byId(result.checks, 'redis').status).toBe('fail')
    expect(byId(result.checks, 'redis').fix).toContain('REDIS_URL')
    expectNoCanary(result)
  })

  test('clock: a few seconds of difference warns, half a minute fails', async () => {
    const { deps, diagnostics } = await setup()
    const at = (seconds: number) => async () => ({
      appliedMigrations: diagnostics.shippedMigrations,
      now: new Date(deps.clock.now().getTime() + seconds * 1000),
    })
    diagnostics.database = at(2)
    expect(byId((await Instance.diagnostics(deps)).checks, 'clock').status).toBe('ok')
    diagnostics.database = at(-10)
    expect(byId((await Instance.diagnostics(deps)).checks, 'clock').status).toBe('warn')
    diagnostics.database = at(45)
    const check = byId((await Instance.diagnostics(deps)).checks, 'clock')
    expect(check.status).toBe('fail')
    expect(check.summary).toContain('45')
  })

  // Found running `tula doctor` against a stack whose mail relay was down: the SMTP check's
  // five-second timeout was counted as clock skew.
  test('clock: time spent in another, slower check is not skew', async () => {
    const { deps, diagnostics } = await setup()
    diagnostics.smtp = async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      deps.clock.advance('20s')
    }
    const result = await Instance.diagnostics(deps)
    expect(byId(result.checks, 'clock').status).toBe('ok')
  })

  test('PUBLIC_URL: fetched only as configured, ok on 200, fail on anything else', async () => {
    const { deps, diagnostics } = await setup()
    const config = { ...TEST_CONFIG, publicUrl: 'https://auth.example.com/' }
    const ok = await Instance.diagnostics({ ...deps, config })
    expect(byId(ok.checks, 'public_url').status).toBe('ok')
    expect(diagnostics.requested).toEqual(['https://auth.example.com/v1/status'])

    diagnostics.httpStatus = async () => 302
    const redirected = await Instance.diagnostics({ ...deps, config })
    expect(byId(redirected.checks, 'public_url').status).toBe('fail')
    expect(byId(redirected.checks, 'public_url').summary).toContain('redirect')

    diagnostics.httpStatus = async () => {
      throw new Error('getaddrinfo ENOTFOUND CANARY-internal-message')
    }
    const down = await Instance.diagnostics({ ...deps, config })
    expect(byId(down.checks, 'public_url').status).toBe('fail')
    expect(byId(down.checks, 'public_url').fix).toContain('PUBLIC_URL')
    expectNoCanary(down)
  })

  test('enabled providers: the exact redirect URI of each, once', async () => {
    const { deps } = await setup()
    const input = { clientId: 'client', clientSecret: 'CANARY-client-secret', enabled: true }
    await OAuth.update(deps, tenant, 'github', input, TEST_ACTOR)
    await OAuth.update(deps, tenant, 'google', { ...input, enabled: false }, TEST_ACTOR)
    const result = await Instance.diagnostics(deps)
    const check = byId(result.checks, 'oauth_redirect_uris')
    expect(check.status).toBe('skipped')
    expect(check.values).toEqual(['github: http://localhost:3003/v1/oauth/callback/github'])
    expectNoCanary(result)
  })

  test('the mock provider is a warning', async () => {
    const { deps } = await setup()
    const result = await Instance.diagnostics({
      ...deps,
      config: { ...TEST_CONFIG, oauthMock: true },
    })
    expect(byId(result.checks, 'oauth_redirect_uris').status).toBe('warn')
  })

  test('a probe that never answers is cut off and fails', async () => {
    const { deps, diagnostics } = await setup()
    diagnostics.smtp = () => new Promise(() => {})
    const started = Date.now()
    const result = await Instance.diagnostics(deps, 20)
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(byId(result.checks, 'smtp').status).toBe('fail')
  })

  test('the checks run concurrently', async () => {
    const { deps, diagnostics } = await setup()
    const order: string[] = []
    diagnostics.smtp = async () => {
      order.push('smtp:start')
      await new Promise((resolve) => setTimeout(resolve, 20))
      order.push('smtp:end')
    }
    diagnostics.redis = async () => {
      order.push('redis:start')
    }
    await Instance.diagnostics(deps)
    expect(order.indexOf('redis:start')).toBeLessThan(order.indexOf('smtp:end'))
  })
})
