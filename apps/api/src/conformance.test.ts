import { describe, expect, test } from 'bun:test'
import { formatResult, loadScenarios, runScenario } from '@tula/conformance'
import { EVENT_SCHEMAS } from '@tula/contract'
import * as Settings from '~/modules/settings/service'
import { TEST_TENANT } from '~/testing'
import { inProcessTarget } from '~/testing/in-process-target'

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
      'the admin reset removes passkeys and says whether the user can still sign in',
      'session profile timeouts',
      'session profile selection',
      'concurrent session limit',
      'stateful session',
      'step-up window per profile',
      'settings managed by a config file',
      'admin user sessions',
      'dashboard credential rules',
      'admin user authentication',
      'webhook delivered and signed',
      'webhook endpoint on a refused address',
      'webhook retried after a 500',
      'webhook secret rotated with an overlap',
      'sign-up denied by a hook',
      'hook that times out',
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
      // Everything the scenario recorded is a valid event of its type (ADR 0012), and the
      // payload lost nothing on the way: a detail a call site records and the contract does
      // not name would be missing from `events` and fail here.
      const { entries, events } = target.deps.activityLog
      for (const event of events) {
        expect(EVENT_SCHEMAS[event.type].parse(event)).toEqual(event as never)
      }
      expect(events.map((event) => event.data)).toEqual(entries.map((entry) => entry.data))
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

  test('a scenario that needs a webhook receiver is skipped, not failed, by a target without one', async () => {
    const webhook = scenarios.find(({ scenario }) => scenario.needsWebhookReceiver)
    const target = { ...(await inProcessTarget()), webhooks: undefined }
    expect(webhook && (await runScenario(webhook.scenario, target))).toMatchObject({
      status: 'skipped',
      steps: [],
      reason: 'needs a webhook receiver the server can reach',
    })
    expect(target.deps.activityLog.entries).toEqual([])
  })

  test('the webhook scenario’s delivery left the server through the outbound guard and was recorded', async () => {
    const webhook = scenarios.find(
      ({ scenario }) => scenario.name === 'webhook delivered and signed'
    )
    const target = await inProcessTarget()
    expect(webhook && (await runScenario(webhook.scenario, target))).toMatchObject({
      status: 'passed',
    })
    // Every event of the run is settled: the outbox does not grow.
    expect(target.deps.activityLog.outbox.length).toBeGreaterThan(0)
    const waiting = await target.deps.webhookDeliveries.pendingEvents(
      TEST_TENANT.environmentId,
      100
    )
    // What was recorded after the last round (the switch-off and the removal) still waits.
    expect(waiting.map((event) => event.type)).toEqual([
      'webhook_endpoint.updated',
      'webhook_endpoint.deleted',
    ])
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
