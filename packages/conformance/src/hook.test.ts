import { afterEach, describe, expect, test } from 'bun:test'
import { EVENT_FIXTURES, HOOK_QUESTION_FIXTURES } from '@tula/contract'
import {
  formatWebhookSecret,
  signWebhook,
  webhookSecretBytes,
} from '@tula/contract/webhook-signature'
import { ScenarioSchema } from './scenario'
import { checkQuestion, type ReceivedDelivery, WebhookReceiver } from './webhook'

const SECRET = formatWebhookSecret(new Uint8Array(32).fill(61))
const OTHER = formatWebhookSecret(new Uint8Array(32).fill(62))
const NOW = Date.parse('2026-10-08T09:30:00.000Z')
const SECONDS = Math.floor(NOW / 1000)
const fixture = HOOK_QUESTION_FIXTURES.before_sign_up

async function asked(
  payload: unknown = fixture,
  overrides: {
    method?: string
    headers?: Record<string, string>
    secrets?: readonly string[]
  } = {}
): Promise<ReceivedDelivery> {
  const body = JSON.stringify(payload)
  const id = (payload as { id: string }).id
  const signatures = await Promise.all(
    (overrides.secrets ?? [SECRET]).map((secret) =>
      signWebhook(webhookSecretBytes(secret) as Uint8Array<ArrayBuffer>, id, SECONDS, body)
    )
  )
  return {
    method: overrides.method ?? 'POST',
    headers: overrides.headers ?? {
      'content-type': 'application/json',
      'webhook-id': id,
      'webhook-timestamp': String(SECONDS),
      'webhook-signature': signatures.join(' '),
    },
    body,
  }
}

describe('checkQuestion', () => {
  test('finds nothing wrong with a question signed with the hook’s secret', async () => {
    expect(
      await checkQuestion(await asked(), SECRET, NOW, { type: 'hook.before_sign_up' })
    ).toEqual({
      problems: [],
      id: fixture.id,
    })
  })

  test.each([
    ['another secret', {}, OTHER, 'not the one signature'],
    [
      'two signatures: a hook has one secret',
      { secrets: [SECRET, OTHER] },
      SECRET,
      'not the one signature',
    ],
    ['a GET', { method: 'GET' }, SECRET, 'not a POST'],
    [
      'no headers',
      { headers: { 'content-type': 'application/json' } },
      SECRET,
      'lacks a webhook-id',
    ],
  ] as const)('reports %s', async (_name, overrides, secret, problem) => {
    const { problems } = await checkQuestion(await asked(fixture, { ...overrides }), secret, NOW)
    expect(problems.join('\n')).toContain(problem)
  })

  test('reports a timestamp far from the server’s clock', async () => {
    const { problems } = await checkQuestion(await asked(), SECRET, NOW + 6 * 60_000)
    expect(problems.join('\n')).toContain('more than five minutes')
  })

  test.each([
    ['an event', EVENT_FIXTURES['user.created']],
    ['a question with a password in it', { ...fixture, data: { ...fixture.data, password: 'x' } }],
    ['a question with an attempt in it', { ...fixture, attemptId: fixture.id }],
  ])('reports %s as not a question of the contract', async (_name, payload) => {
    const { problems } = await checkQuestion(await asked(payload), SECRET, NOW)
    expect(problems.join('\n')).toContain('not a hook question of the contract')
  })

  test('reports a mismatch with what the step expected, and never quotes the secret', async () => {
    const { problems } = await checkQuestion(await asked(), OTHER, NOW, {
      data: { method: 'passwordless' },
    })
    expect(problems.length).toBeGreaterThan(1)
    expect(problems.join('\n')).not.toContain(SECRET)
    expect(problems.join('\n')).not.toContain(OTHER)
  })
})

describe('a receiver scripted as a hook’s endpoint', () => {
  let receiver: WebhookReceiver | undefined
  afterEach(() => receiver?.stop())

  const post = (port: number, signal?: AbortSignal) =>
    fetch(`http://127.0.0.1:${port}/webhooks/tula`, { method: 'POST', body: '{}', signal })

  test('answers with the scripted answer as JSON, a bare status, and 204 when unscripted', async () => {
    receiver = new WebhookReceiver('127.0.0.1')
    expect((await post(receiver.port)).status).toBe(204)
    receiver.answerHook({ decision: 'deny', code: 'disposable_email' })
    const denied = await post(receiver.port)
    expect(denied.status).toBe(200)
    expect(await denied.json()).toEqual({ decision: 'deny', code: 'disposable_email' })
    receiver.answerHook({ status: 500 })
    expect((await post(receiver.port)).status).toBe(500)
    receiver.answerHook({ decision: 'allow' })
    expect(await (await post(receiver.port)).json()).toEqual({ decision: 'allow' })
    expect(receiver.take()?.body).toBe('{}')
  })

  test('told to hang, it takes the question and never answers', async () => {
    receiver = new WebhookReceiver('127.0.0.1')
    receiver.answerHook('hang')
    const outcome = await post(receiver.port, AbortSignal.timeout(150)).then(
      () => 'answered',
      (error: Error) => error.name
    )
    expect(outcome).toBe('TimeoutError')
    expect(receiver.take()).toBeDefined()
  })
})

describe('a hook step in a scenario', () => {
  const scenario = (hook: unknown, needsWebhookReceiver?: boolean) =>
    ScenarioSchema.safeParse({
      name: 'A hook',
      description: 'x',
      ...(needsWebhookReceiver !== undefined && { needsWebhookReceiver }),
      steps: [{ name: 'the step', hook }],
    }).success

  test.each([
    [{ receiver: 'r', captureUrl: 'url', answer: { decision: 'allow' } }],
    [{ receiver: 'r', captureUrl: 'url' }],
    [{ receiver: 'r', answer: 'hang' }],
    [{ receiver: 'r', answer: { status: 500 } }],
    [{ receiver: 'r', answer: { decision: 'deny', code: 'no' } }],
    [{ receiver: 'r', captureUrl: 'url', answer: { claims: { plan: 'pro', seats: 5 } } }],
    [{ receiver: 'r', answer: { claims: {} } }],
    [{ receiver: 'r', expect: { secret: '{{secret}}', body: { type: 'hook.before_sign_up' } } }],
    [{ receiver: 'r', expect: { nothing: true } }],
  ])('%p is a step', (hook) => {
    expect(scenario(hook, true)).toBe(true)
  })

  test.each([
    ['nothing to do', { receiver: 'r' }],
    ['an answer the contract does not have', { receiver: 'r', answer: { decision: 'maybe' } }],
    ['claims under a reserved name', { receiver: 'r', answer: { claims: { sub: 'x' } } }],
    ['claims beside a decision', { receiver: 'r', answer: { claims: {}, decision: 'allow' } }],
    [
      'an answer with an extra key',
      { receiver: 'r', answer: { decision: 'allow', verified: true } },
    ],
    [
      'both an answer and an expectation',
      { receiver: 'r', answer: 'hang', expect: { nothing: true } },
    ],
    [
      'an expectation that also starts a receiver',
      { receiver: 'r', captureUrl: 'u', expect: { nothing: true } },
    ],
    ['an unknown key', { receiver: 'r', captureUrl: 'u', wait: 1 }],
  ])('%s is refused', (_name, hook) => {
    expect(scenario(hook, true)).toBe(false)
  })

  test('a scenario with one must say it needs a receiver the server can reach', () => {
    expect(scenario({ receiver: 'r', captureUrl: 'url' })).toBe(false)
    expect(scenario({ receiver: 'r', captureUrl: 'url' }, false)).toBe(false)
  })
})
