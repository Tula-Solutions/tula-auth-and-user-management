import { describe, expect, test } from 'bun:test'
import { formatResult, loadScenarios, runScenario, type Target } from '@tula/conformance'
import { createApp } from '~/index'
import { createTestDeps, seedApiKey, TEST_CONFIG, TEST_TENANT } from '~/testing'

const PUBLISHABLE_KEY = 'tula_pk_dev_conformance00000000000000000000'
const SECRET_KEY = 'tula_sk_dev_conformance00000000000000000000'
/** A subject that leads with a 6-digit code, as every code email's does. */
const CODE_SUBJECT = /^(\d{6})\b/

/**
 * A fresh in-process server per scenario: memory adapters, a clock that `wait` steps advance,
 * and an outbox the email steps read. The requests are the same ones `bun run conformance`
 * sends to a live server.
 */
async function inProcessTarget(): Promise<Target> {
  // The runner gives each scenario its own client address through X-Forwarded-For.
  const deps = createTestDeps({ config: { ...TEST_CONFIG, trustProxy: true } })
  deps.environments.add({
    id: TEST_TENANT.environmentId,
    projectId: TEST_TENANT.projectId,
    kind: 'development',
    createdAt: deps.clock.now(),
  })
  await seedApiKey(deps, PUBLISHABLE_KEY)
  await seedApiKey(deps, SECRET_KEY)
  const app = createApp(deps)
  // A second instance of the same deployment: its own app over the same stores, as two
  // processes share one Postgres and one Redis. `multi-instance.test.ts` covers the Redis
  // adapters themselves; here the point is that the shared scenario runs in process too.
  const second = createApp(deps)
  return {
    baseUrl: 'http://tula.test',
    publishableKey: PUBLISHABLE_KEY,
    secretKey: SECRET_KEY,
    fetch: async (request) => app.request(request),
    second: {
      baseUrl: 'http://second.tula.test',
      fetch: async (request) => second.request(request),
    },
    emailCode: async (to) => {
      // The newest email that carries a code: a security notice (ADR 0023) can follow it.
      const message = deps.mailer.outbox.findLast(
        (sent) => sent.to === to && CODE_SUBJECT.test(sent.subject)
      )
      const code = CODE_SUBJECT.exec(message?.subject ?? '')?.[1]
      if (!code) {
        throw new Error(`no email with a code was sent to ${to}`)
      }
      return code
    },
    wait: async (ms) => {
      deps.clock.advance(ms)
    },
  }
}

const scenarios = await loadScenarios()

describe('conformance scenarios, in process', () => {
  test('the suite covers the Phase 0 journey and each Phase 1 step', () => {
    expect(scenarios.map(({ scenario }) => scenario.name)).toEqual([
      'sign-up',
      'sign-in',
      'refresh rotation and reuse detection',
      'sign-out',
      'password policy',
      'password lockout',
      'admin ban and audit log',
      'sign-up for an existing address',
      'verification code attempts',
      'password reset',
      'two instances',
      'environment settings',
      'attempt binding',
    ])
  })

  test.each(scenarios.map(({ file, scenario }) => [file, scenario] as const))(
    '%s',
    async (_file, scenario) => {
      const result = await runScenario(scenario, await inProcessTarget())
      // On failure the message shows each step and what differed.
      expect(formatResult(result)).toBe(
        [`PASSED ${scenario.name}`, ...scenario.steps.map((step) => `  ok   ${step.name}`)].join(
          '\n'
        )
      )
    }
  )

  test('the two-instance scenario also passes against a single instance', async () => {
    const two = scenarios.find(({ scenario }) => scenario.name === 'two instances')
    const target = { ...(await inProcessTarget()), second: undefined }
    expect(two && (await runScenario(two.scenario, target))).toMatchObject({ status: 'passed' })
  })

  test('the two-instance scenario really sends requests to both instances', async () => {
    const two = scenarios.find(({ scenario }) => scenario.name === 'two instances')
    const target = await inProcessTarget()
    const counts = { first: 0, second: 0 }
    const counted: typeof target = {
      ...target,
      fetch: (request) => {
        counts.first += 1
        return target.fetch(request)
      },
      second: target.second && {
        ...target.second,
        fetch: (request) => {
          counts.second += 1
          return (target.second ?? target).fetch(request)
        },
      },
    }
    expect(two && (await runScenario(two.scenario, counted))).toMatchObject({ status: 'passed' })
    expect(counts.first).toBeGreaterThan(5)
    expect(counts.second).toBeGreaterThan(5)
  })

  test('a scenario that needs a secret key is skipped, not failed, without one', async () => {
    const admin = scenarios.find(({ scenario }) => scenario.needsSecretKey)
    const target = { ...(await inProcessTarget()), secretKey: undefined }
    expect(admin && (await runScenario(admin.scenario, target))).toMatchObject({
      status: 'skipped',
      steps: [],
    })
  })
})
