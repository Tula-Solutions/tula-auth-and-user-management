import { describe, expect, test } from 'bun:test'
import { DEFAULT_ENVIRONMENT_SETTINGS } from '@tula/contract'
import type { MemoryDiagnostics } from '~/adapters/memory/diagnostics'
import { unconfiguredSmsSender } from '~/adapters/sms/unconfigured'
import { createSecretBox } from '~/lib/secret-box'
import * as Audit from '~/modules/audit/service'
import * as Instance from '~/modules/instance/service'
import * as Jwks from '~/modules/jwks/service'
import * as OAuth from '~/modules/oauth/service'
import * as Webhooks from '~/modules/webhook/service'
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
      'webhook_worker',
      'sms_sender',
    ])
    expect(byId(result.checks, 'webhook_worker').status).toBe('ok')
    // The test deployment has a sender (the memory one).
    expect(byId(result.checks, 'sms_sender').status).toBe('ok')
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

// TULA-52. `WEBHOOK_WORKER=separate` on every process and no worker started must not mean,
// silently, that nobody delivers. An API instance cannot see a worker process; it can see
// what a worker would have done: an event that has waited to be queued.
describe('the webhook_worker check', () => {
  const separate = { ...TEST_CONFIG, deliversWebhooks: false }
  const worker = (deps: TestDeps) => byId0(Instance.diagnostics(deps))
  const byId0 = async (result: ReturnType<typeof Instance.diagnostics>) =>
    byId((await result).checks, 'webhook_worker')

  /** Record that something happened in an environment: an outbox event, waiting. */
  function happen(deps: TestDeps, environmentId: string = TEST_TENANT.environmentId) {
    const activity = Audit.entry(
      deps,
      { projectId: TEST_TENANT.projectId, environmentId },
      { type: 'user.deleted', actor: TEST_ACTOR, target: { type: 'user', id: deps.ids.next() } }
    )
    deps.activityLog.record([activity])
  }

  test('the API instances deliver and nothing waits: ok, and it says who delivers', async () => {
    const { deps } = await setup()
    expect(await worker(deps)).toEqual({
      id: 'webhook_worker',
      status: 'ok',
      summary:
        'No event has waited a minute or more to be queued for delivery. WEBHOOK_WORKER is `api`: the API instances make the deliveries.',
    })
  })

  test('the worker is separate and nothing waits: ok, and it says what it did not look at', async () => {
    const { deps } = await setup()
    expect(await worker({ ...deps, config: separate })).toEqual({
      id: 'webhook_worker',
      status: 'ok',
      summary:
        'No event has waited a minute or more to be queued for delivery. WEBHOOK_WORKER is `separate`: a worker process makes the deliveries. This check sees what waits, not the worker.',
    })
  })

  test('the worker is separate and none runs: an event that waits a minute fails the check, not a millisecond sooner', async () => {
    const { deps } = await setup()
    const api = { ...deps, config: separate }
    happen(deps)
    deps.clock.advance(Instance.WEBHOOK_WAITING_TOO_LONG_MS - 1)
    expect((await worker(api)).status).toBe('ok')
    deps.clock.advance(1)
    expect(await worker(api)).toEqual({
      id: 'webhook_worker',
      status: 'fail',
      summary:
        'Events have waited a minute or more to be queued for delivery, in 1 environment: the worker is not running, or it cannot keep up or cannot work.',
      // What the check knows is that events wait. It never saw a worker, running or not.
      fix: 'WEBHOOK_WORKER is `separate`, so no API instance makes a delivery: only a worker process does, and this check sees what waits, not the worker. See whether one is running (the same image with the command `bun run src/worker.ts`; with Compose, `docker compose --profile app --profile worker up -d`). If one is, read its log: `could not run the webhook delivery job` or `webhook delivery failed in one environment` means it cannot work, and rounds that finish while events still wait mean it cannot keep up. Or set WEBHOOK_WORKER=api on every instance and restart them.',
    })
    expect(Instance.WEBHOOK_WAITING_TOO_LONG_MS).toBe(60_000)
  })

  test('once a worker’s round has taken the events, the check is ok again', async () => {
    const { deps } = await setup()
    const api = { ...deps, config: separate }
    happen(deps)
    deps.clock.advance('10m')
    expect((await worker(api)).status).toBe('fail')
    // The worker: the same stores, a process that delivers.
    await Webhooks.run(deps)
    expect((await worker(api)).status).toBe('ok')
  })

  test('it counts environments, never events, and names none', async () => {
    const { deps } = await setup()
    const other = '00000000-0000-7000-8000-00000000beef'
    deps.environments.add({
      id: other,
      projectId: TEST_TENANT.projectId,
      kind: 'production',
      createdAt: deps.clock.now(),
    })
    for (let count = 0; count < 5; count += 1) {
      happen(deps)
    }
    happen(deps, other)
    deps.clock.advance('2m')
    const check = await worker({ ...deps, config: separate })
    expect(check.summary).toBe(
      'Events have waited a minute or more to be queued for delivery, in 2 environments: the worker is not running, or it cannot keep up or cannot work.'
    )
    expect(JSON.stringify(check)).not.toContain(other)
    expect(JSON.stringify(check)).not.toContain(TEST_TENANT.environmentId)
  })

  test('the API instances deliver and events still wait: a warning that points at the API’s log', async () => {
    const { deps } = await setup()
    happen(deps)
    deps.clock.advance(Instance.WEBHOOK_WAITING_TOO_LONG_MS)
    expect(await worker(deps)).toEqual({
      id: 'webhook_worker',
      status: 'warn',
      summary:
        'Events have waited a minute or more to be queued for delivery, in 1 environment: the delivery job is behind or failing.',
      fix: 'WEBHOOK_WORKER is `api`, so every API instance runs the delivery job. Look in the API’s log for `could not run the webhook delivery job` and `webhook delivery failed in one environment`, and check that the database is reachable and not overloaded.',
    })
  })

  test('a store that fails: skipped, with nothing of the driver’s message', async () => {
    const { deps } = await setup()
    const broken = {
      oldestPendingEventAt: async () => {
        throw new Error(`connection terminated ${CANARIES[0]}`)
      },
    }
    const result = await Instance.diagnostics({
      ...deps,
      config: separate,
      webhookDeliveries: broken as unknown as TestDeps['webhookDeliveries'],
    })
    expect(byId(result.checks, 'webhook_worker')).toEqual({
      id: 'webhook_worker',
      status: 'skipped',
      summary: 'Not checked: the events waiting for delivery could not be read from the database.',
    })
    expectNoCanary(result)
  })

  test('it reads when the oldest event happened and no event: a payload never leaves the store', async () => {
    const { deps } = await setup()
    let asked = 0
    const events = {
      oldestPendingEventAt: async () => {
        asked += 1
        return new Date(deps.clock.now().getTime() - 3_600_000)
      },
      // The read that returns whole rows, payload included, is not the check's to make.
      pendingEvents: async () => {
        throw new Error('the check read an event: CANARY-payload')
      },
    }
    const result = await Instance.diagnostics({
      ...deps,
      config: separate,
      webhookDeliveries: events as unknown as TestDeps['webhookDeliveries'],
    })
    expect(byId(result.checks, 'webhook_worker').status).toBe('fail')
    expect(asked).toBe(1)
    expectNoCanary(result)
  })

  test('more environments than one run reads: it says how many it looked at, and asks once for each', async () => {
    const { deps } = await setup()
    for (let index = 1; index <= Instance.MAX_ENVIRONMENTS_CHECKED; index += 1) {
      deps.environments.add({
        id: `00000000-0000-7000-8000-${String(index).padStart(12, '0')}`,
        projectId: TEST_TENANT.projectId,
        kind: 'development',
        createdAt: new Date(deps.clock.now().getTime() + index),
      })
    }
    const asked: string[] = []
    const oldest = deps.webhookDeliveries.oldestPendingEventAt.bind(deps.webhookDeliveries)
    deps.webhookDeliveries.oldestPendingEventAt = async (environmentId) => {
      asked.push(environmentId)
      return oldest(environmentId)
    }
    const check = await worker({ ...deps, config: separate })
    expect(check.status).toBe('warn')
    expect(check.summary).toBe(
      'Only the first 200 of 201 environments were looked at: no event of theirs has waited a minute or more to be queued for delivery. The other 1 was not read.'
    )
    expect(check.fix).toBeDefined()
    // One question per environment, and only of the environments it says it looked at.
    expect(asked).toHaveLength(Instance.MAX_ENVIRONMENTS_CHECKED)
    expect(new Set(asked).size).toBe(Instance.MAX_ENVIRONMENTS_CHECKED)

    // An overdue event among those it did read is still a failure, and says its scope.
    happen(deps)
    deps.clock.advance('5m')
    const failing = await worker({ ...deps, config: separate })
    expect(failing.status).toBe('fail')
    expect(failing.summary).toBe(
      'Events have waited a minute or more to be queued for delivery, in 1 environment of the first 200 of 201: the worker is not running, or it cannot keep up or cannot work.'
    )
  })

  test('a scan cut off by the timeout reads no further environment’s events', async () => {
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
      oldestPendingEventAt: async () => {
        calls += 1
        await new Promise((resolve) => setTimeout(resolve, 80))
        return null
      },
    }
    const result = await Instance.diagnostics(
      { ...deps, webhookDeliveries: slow as unknown as TestDeps['webhookDeliveries'] },
      50
    )
    expect(byId(result.checks, 'webhook_worker').status).toBe('skipped')
    expect(calls).toBe(1)
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(calls).toBe(1)
  })

  test('a store that never answers: later runs do not read the events again on top of it', async () => {
    const { deps } = await setup()
    let calls = 0
    const stuck = {
      oldestPendingEventAt: () => {
        calls += 1
        return new Promise<never>(() => {})
      },
    }
    const stuckDeps = {
      ...deps,
      webhookDeliveries: stuck as unknown as TestDeps['webhookDeliveries'],
    }
    expect(byId((await Instance.diagnostics(stuckDeps, 50)).checks, 'webhook_worker').status).toBe(
      'skipped'
    )
    expect(byId((await Instance.diagnostics(stuckDeps, 50)).checks, 'webhook_worker').status).toBe(
      'skipped'
    )
    expect(calls).toBe(1)
  })
})

// TULA-29. "SMS on" is an environment's setting and the sender is the deployment's: the boot
// sees only the second, so the diagnostics compare the two.
describe('the sms_sender check', () => {
  const NO_SENDER = { sms: unconfiguredSmsSender } as unknown as Partial<TestDeps>
  const check = async (deps: Parameters<typeof Instance.diagnostics>[0]) =>
    byId((await Instance.diagnostics(deps)).checks, 'sms_sender')

  function switchOn(
    deps: TestDeps,
    environmentId: string = TEST_TENANT.environmentId,
    sms = { enabled: true, allowedCountries: ['US'], dailyMessageLimit: 500 }
  ) {
    deps.environmentSettings.seed(environmentId, {
      revision: 1,
      settings: { ...DEFAULT_ENVIRONMENT_SETTINGS, sms },
    })
  }

  function addEnvironments(deps: TestDeps, count: number): string[] {
    const ids: string[] = []
    for (let index = 1; index <= count; index += 1) {
      const id = `00000000-0000-7000-8000-${String(index).padStart(12, '0')}`
      ids.push(id)
      deps.environments.add({
        id,
        projectId: TEST_TENANT.projectId,
        kind: 'development',
        createdAt: new Date(deps.clock.now().getTime() + index),
      })
    }
    return ids
  }

  test('no sender and no environment with text messages on: skipped, and it says both', async () => {
    const { deps } = await setup(NO_SENDER)
    expect(await check(deps)).toEqual({
      id: 'sms_sender',
      status: 'skipped',
      summary:
        'The deployment has no sender for text messages (SMS_PROVIDER is `none`), and no environment has them switched on.',
    })
  })

  test('no sender and an environment with text messages on: a warning, with what to do', async () => {
    const { deps } = await setup(NO_SENDER)
    switchOn(deps)
    expect(await check(deps)).toEqual({
      id: 'sms_sender',
      status: 'warn',
      summary:
        'SMS_PROVIDER is `none`, and 1 environment has text messages switched on: no message is sent, and a request that would send one is answered `sms.unavailable`.',
      fix: 'Set SMS_PROVIDER=twilio and the TWILIO_* variables on every API instance and restart them (docs/self-host.md, “Text messages with Twilio”). Or switch text messages off in the settings of the environments that have them on.',
    })
  })

  test('counts environments, and names none of them', async () => {
    const { deps } = await setup(NO_SENDER)
    const [second, third] = addEnvironments(deps, 3)
    switchOn(deps)
    switchOn(deps, second)
    switchOn(deps, third)
    const result = await Instance.diagnostics(deps)
    const found = byId(result.checks, 'sms_sender')
    expect(found.status).toBe('warn')
    expect(found.summary).toStartWith(
      'SMS_PROVIDER is `none`, and 3 environments have text messages switched on'
    )
    const said = JSON.stringify(found)
    for (const id of [TEST_TENANT.environmentId, second, third]) {
      expect(said).not.toContain(String(id))
    }
    // Not a country either: which destinations an environment texts is its own business.
    expect(said).not.toMatch(/\bUS\b/)
    expect(found.values).toBeUndefined()
  })

  // What `Settings.requireSms` refuses is not "on": such an environment sends nothing with
  // any sender, so the missing sender changes nothing for it.
  test.each([
    [
      'switched off, with countries',
      { enabled: false, allowedCountries: ['US'], dailyMessageLimit: 500 },
    ],
    [
      'switched on, with no country',
      { enabled: true, allowedCountries: [], dailyMessageLimit: 500 },
    ],
  ])('an environment with text messages %s is not counted', async (_name, sms) => {
    const { deps } = await setup(NO_SENDER)
    switchOn(deps, TEST_TENANT.environmentId, sms)
    expect((await check(deps)).status).toBe('skipped')
  })

  test('with a sender it is ok, says what it did not ask, and reads no settings', async () => {
    const { deps } = await setup()
    switchOn(deps)
    let read = 0
    const get = deps.environmentSettings.get.bind(deps.environmentSettings)
    deps.environmentSettings.get = async (...args) => {
      read += 1
      return get(...args)
    }
    expect(await check(deps)).toEqual({
      id: 'sms_sender',
      status: 'ok',
      summary:
        'The deployment has a sender for text messages (SMS_PROVIDER). No message was sent and the provider was not asked: this does not show that its credentials or its sender work.',
    })
    expect(read).toBe(0)
    // And it sent nothing to find out.
    expect(deps.sms.outbox).toEqual([])
  })

  test('the development inbox is said for what it is', async () => {
    const { deps } = await setup()
    expect(await check({ ...deps, smsInbox: deps.sms })).toEqual({
      id: 'sms_sender',
      status: 'ok',
      summary:
        'SMS_PROVIDER is `dev`: text messages are kept in the development inbox and reach no phone. Local development only.',
    })
  })

  test('settings that cannot be read: skipped, the reason stays out of the answer, the other checks stand', async () => {
    const { deps } = await setup(NO_SENDER)
    switchOn(deps)
    deps.environmentSettings.get = async () => {
      throw new Error(`could not read settings: ${CANARIES[0]} CANARY-internal-message`)
    }
    const result = await Instance.diagnostics(deps)
    expect(byId(result.checks, 'sms_sender')).toEqual({
      id: 'sms_sender',
      status: 'skipped',
      summary: 'Not checked: the environments’ settings could not be read from the database.',
    })
    // The settings' failure is not the stored secrets' nor the outbox's.
    expect(byId(result.checks, 'master_key').status).toBe('ok')
    expect(byId(result.checks, 'webhook_worker').status).toBe('ok')
    expectNoCanary(result)
  })

  test('after one failed read it asks no further environment', async () => {
    const { deps } = await setup(NO_SENDER)
    addEnvironments(deps, 5)
    let read = 0
    deps.environmentSettings.get = async () => {
      read += 1
      throw new Error('CANARY-internal-message')
    }
    expect((await check(deps)).status).toBe('skipped')
    expect(read).toBe(1)
  })

  test('more environments than one run reads: one read each, of those it says it looked at', async () => {
    const { deps } = await setup(NO_SENDER)
    const ids = addEnvironments(deps, Instance.MAX_ENVIRONMENTS_CHECKED)
    const asked: string[] = []
    const get = deps.environmentSettings.get.bind(deps.environmentSettings)
    deps.environmentSettings.get = async (environmentId, ...rest) => {
      asked.push(environmentId)
      return get(environmentId, ...rest)
    }
    // The newest environment, past the 200th, has text messages on: it is not read, and the
    // check does not say "none".
    switchOn(deps, ids.at(-1))
    const none = await check(deps)
    expect(none.status).toBe('warn')
    expect(none.summary).toBe(
      'SMS_PROVIDER is `none`. Only the first 200 of 201 environments were looked at: none of them has text messages switched on. The other 1 was not read.'
    )
    expect(none.fix).toBeDefined()
    expect(asked).toHaveLength(Instance.MAX_ENVIRONMENTS_CHECKED)
    expect(new Set(asked).size).toBe(Instance.MAX_ENVIRONMENTS_CHECKED)
    expect(asked).not.toContain(ids.at(-1))

    switchOn(deps)
    expect((await check(deps)).summary).toBe(
      'SMS_PROVIDER is `none`, and 1 environment of the first 200 of 201 has text messages switched on: no message is sent, and a request that would send one is answered `sms.unavailable`.'
    )
  })

  test('a scan cut off by the timeout reads no further environment’s settings', async () => {
    const { deps } = await setup(NO_SENDER)
    addEnvironments(deps, 5)
    let calls = 0
    deps.environmentSettings.get = async () => {
      calls += 1
      await new Promise((resolve) => setTimeout(resolve, 80))
      return null
    }
    const result = await Instance.diagnostics(deps, 50)
    expect(byId(result.checks, 'sms_sender').status).toBe('skipped')
    expect(calls).toBe(1)
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(calls).toBe(1)
  })

  test('settings that never answer: later runs do not read them again on top of it', async () => {
    const { deps } = await setup(NO_SENDER)
    let calls = 0
    deps.environmentSettings.get = () => {
      calls += 1
      return new Promise<never>(() => {})
    }
    expect((await Instance.diagnostics(deps, 50)).checks.at(-1)?.status).toBe('skipped')
    expect((await Instance.diagnostics(deps, 50)).checks.at(-1)?.status).toBe('skipped')
    expect(calls).toBe(1)
  })
})
