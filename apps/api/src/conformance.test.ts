import { describe, expect, test } from 'bun:test'
import { formatResult, loadScenarios, runScenario, type Target } from '@tula/conformance'
import { mockOAuthProviders } from '~/adapters/oauth/mock'
import { createApp } from '~/index'
import * as Settings from '~/modules/settings/service'
import { createTestDeps, seedApiKey, TEST_CONFIG, TEST_TENANT, type TestDeps } from '~/testing'

const PUBLISHABLE_KEY = 'tula_pk_dev_conformance00000000000000000000'
const SECRET_KEY = 'tula_sk_dev_conformance00000000000000000000'
/** A subject that leads with a 6-digit code, as every code email's does. */
const CODE_SUBJECT = /^(\d{6})\b/
/** A sign-in link as it appears in an email's text: a URL with the link token in its fragment. */
const EMAIL_LINK = /https?:\/\/\S+#\S*tula_link=\S+/

/**
 * A fresh in-process server per scenario: memory adapters, a clock that `wait` steps advance,
 * and an outbox the email steps read. The requests are the same ones `bun run conformance`
 * sends to a live server.
 */
async function inProcessTarget(): Promise<Target & { deps: TestDeps }> {
  // The runner gives each scenario its own client address through X-Forwarded-For.
  // The OAuth scenarios need a provider that answers without a network: the mock provider, wired
  // as `container.ts` wires it for `OAUTH_MOCK_PROVIDER=true`.
  const deps = createTestDeps({ config: { ...TEST_CONFIG, trustProxy: true, oauthMock: true } })
  Object.assign(deps, {
    oauth: mockOAuthProviders({
      secretBox: deps.secretBox,
      clock: deps.clock,
      publicUrl: deps.config.publicUrl,
    }),
  })
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
    emailLink: async (to) => {
      // The link travels in the email that carries the code.
      const message = deps.mailer.outbox.findLast(
        (sent) => sent.to === to && CODE_SUBJECT.test(sent.subject)
      )
      const link = EMAIL_LINK.exec(message?.text ?? '')?.[0]
      if (!link) {
        throw new Error(`no email with a link was sent to ${to}`)
      }
      return link
    },
    wait: async (ms) => {
      deps.clock.advance(ms)
    },
    // Authenticator codes are computed for the clock the server reads, not the wall clock.
    now: () => deps.clock.now().getTime(),
    deps,
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
      'email code sign-in',
      'email link sign-in',
      'passwordless sign-up',
      'two-step enrolment and sign-in',
      'second factor lockout',
      'authenticator code replay',
      'backup codes',
      'password reset with a second factor',
      'step-up',
      'admin second factor reset',
      'required second factor',
      'OAuth sign-up and sign-in',
      'OAuth account linking',
      'OAuth with a second factor',
      'step-up by emailed code',
      'passkey registration and sign-in',
      'passkey assertion replay',
      'passkey origin and relying party',
      'passkey signature counter',
      'a passkey satisfies two-step verification',
      'step-up with a passkey',
      'the last way to sign in cannot be removed',
      'passkeys switched off mid-attempt',
    ])
  })

  test.each(scenarios.map(({ file, scenario }) => [file, scenario] as const))(
    '%s',
    async (_file, scenario) => {
      const target = await inProcessTarget()
      const before = await Settings.current(target.deps, TEST_TENANT)
      const result = await runScenario(scenario, target)
      // On failure the message shows each step and what differed.
      expect(formatResult(result)).toBe(
        [
          `PASSED ${scenario.name}`,
          ...[...scenario.steps, ...(scenario.cleanup ?? [])].map((step) => `  ok   ${step.name}`),
        ].join('\n')
      )
      // A live environment is shared by every scenario that follows: whatever a scenario
      // changed in the settings, its cleanup has put back.
      expect(await Settings.current(target.deps, TEST_TENANT)).toEqual(before)
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
