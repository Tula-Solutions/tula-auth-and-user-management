import { describe, expect, test } from 'bun:test'
import { EVENT_FIXTURES } from '@tula/contract'
import {
  formatWebhookSecret,
  signWebhook,
  webhookSecretBytes,
} from '@tula/contract/webhook-signature'
import {
  exitCode,
  formatResult,
  runScenario,
  type Target,
  WEBHOOK_RECEIVER_SKIP_REASON,
} from './runner'
import { type Scenario, ScenarioSchema } from './scenario'
import { checkDelivery, type ReceivedDelivery, WebhookReceiver } from './webhook'

const SECRET = formatWebhookSecret(new Uint8Array(32).fill(9))
const OTHER_SECRET = formatWebhookSecret(new Uint8Array(32).fill(10))
const NOW = Date.parse('2026-10-08T09:30:00.000Z')
const event = EVENT_FIXTURES['user.created']

async function signed(
  secret: string,
  body: string,
  { id = event.id, timestamp = Math.floor(NOW / 1000) } = {}
): Promise<ReceivedDelivery> {
  const key = webhookSecretBytes(secret) as Uint8Array<ArrayBuffer>
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'webhook-id': id,
      'webhook-timestamp': String(timestamp),
      'webhook-signature': await signWebhook(key, id, timestamp, body),
    },
    body,
  }
}

const good = () => signed(SECRET, JSON.stringify(event))

describe('checkDelivery', () => {
  test('finds nothing wrong with a delivery signed for the secret', async () => {
    expect(await checkDelivery(await good(), SECRET, NOW)).toEqual({ problems: [], id: event.id })
  })

  test('accepts the right signature among several', async () => {
    const delivery = await good()
    const other = (await signed(OTHER_SECRET, delivery.body)).headers['webhook-signature']
    delivery.headers['webhook-signature'] = `${other} ${delivery.headers['webhook-signature']}`
    expect((await checkDelivery(delivery, SECRET, NOW)).problems).toEqual([])
  })

  test('matches the event against what the step expects, as a subset', async () => {
    const delivery = await good()
    expect(
      (
        await checkDelivery(delivery, SECRET, NOW, {
          type: 'user.created',
          data: { method: 'sign_up' },
        })
      ).problems
    ).toEqual([])
    expect(
      (await checkDelivery(delivery, SECRET, NOW, { data: { method: 'admin' } })).problems
    ).toEqual(['expected event.data.method to be "admin", got "sign_up"'])
  })

  test.each([
    [
      'a signature for another secret',
      async () => signed(OTHER_SECRET, JSON.stringify(event)),
      'no entry of webhook-signature is the signature for the secret',
    ],
    [
      'a body changed after signing',
      async () => ({
        ...(await good()),
        body: JSON.stringify({ ...event, occurredAt: '2026-10-08T09:31:00.000Z' }),
      }),
      'no entry of webhook-signature is the signature for the secret',
    ],
    [
      'a timestamp six minutes old',
      async () =>
        signed(SECRET, JSON.stringify(event), { timestamp: Math.floor(NOW / 1000) - 360 }),
      'webhook-timestamp is more than five minutes from the server’s clock',
    ],
    [
      'a timestamp six minutes ahead',
      async () =>
        signed(SECRET, JSON.stringify(event), { timestamp: Math.floor(NOW / 1000) + 360 }),
      'webhook-timestamp is more than five minutes from the server’s clock',
    ],
    [
      'a GET',
      async () => ({ ...(await good()), method: 'GET' }),
      'the delivery was a GET, not a POST',
    ],
    [
      'another content type',
      async () => {
        const delivery = await good()
        return { ...delivery, headers: { ...delivery.headers, 'content-type': 'text/plain' } }
      },
      'the delivery’s content-type is not application/json',
    ],
    [
      'an id that is not the event’s',
      async () => signed(SECRET, JSON.stringify(event), { id: EVENT_FIXTURES['user.deleted'].id }),
      'the event’s id is not the webhook-id header',
    ],
    [
      'a body that is not JSON',
      async () => signed(SECRET, 'not json'),
      'the delivery’s body is not JSON',
    ],
    [
      'a body that is not an event',
      async () =>
        signed(
          SECRET,
          JSON.stringify({ ...event, schemaVersion: undefined, data: { method: 'x' } })
        ),
      'the delivery’s body is not an event of the contract (schemaVersion, data.method, data.emailVerified)',
    ],
  ])('reports %s', async (_, build, problem) => {
    const { problems } = await checkDelivery(await build(), SECRET, NOW)
    expect(problems).toContain(problem)
  })

  test.each(['webhook-id', 'webhook-timestamp', 'webhook-signature'])(
    'reports a missing %s header and checks no further',
    async (name) => {
      const delivery = await good()
      delete delivery.headers[name]
      expect((await checkDelivery(delivery, SECRET, NOW)).problems).toEqual([
        `the delivery has no ${name} header`,
      ])
    }
  )

  test('reports a timestamp that is not a number', async () => {
    const delivery = await good()
    delivery.headers['webhook-timestamp'] = 'soon'
    expect(await checkDelivery(delivery, SECRET, NOW)).toEqual({
      problems: ['webhook-timestamp is not a whole number of seconds'],
      id: event.id,
    })
  })

  test('reports a secret that is not one', async () => {
    expect((await checkDelivery(await good(), 'tula_sk_dev_nope', NOW)).problems).toEqual([
      'the secret given to the step is not a signing secret (whsec_…)',
    ])
  })

  test('no problem quotes the secret, a signature or the body', async () => {
    const delivery = await signed(OTHER_SECRET, '{"canary":"body"}')
    const { problems } = await checkDelivery(delivery, SECRET, NOW, { type: 'user.created' })
    const text = problems.join('\n')
    expect(problems.length).toBeGreaterThan(1)
    expect(text).not.toContain(SECRET)
    expect(text).not.toContain(delivery.headers['webhook-signature'] as string)
    expect(text).not.toContain('canary')
  })
})

describe('WebhookReceiver', () => {
  test('keeps what it is sent, answers 204, and hands deliveries out oldest first, by type', async () => {
    const receiver = new WebhookReceiver('127.0.0.1')
    try {
      const url = `http://127.0.0.1:${receiver.port}/webhooks/tula`
      const send = (body: string) =>
        fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
      const answer = await send('{"type":"user.created","n":1}')
      expect(answer.status).toBe(204)
      expect(await answer.text()).toBe('')
      await send('{"type":"user.deleted","n":2}')
      await send('{"type":"user.created","n":3}')
      await send('not json')
      await send('[1]')

      expect(receiver.take('session.created')).toBeUndefined()
      expect(receiver.take('user.deleted')?.body).toBe('{"type":"user.deleted","n":2}')
      expect(receiver.take()?.body).toBe('{"type":"user.created","n":1}')
      expect(receiver.take('user.created')).toMatchObject({
        method: 'POST',
        body: '{"type":"user.created","n":3}',
        headers: { 'content-type': 'application/json' },
      })
      expect(receiver.take('user.created')).toBeUndefined()
      expect(receiver.take()?.body).toBe('not json')
    } finally {
      receiver.stop()
    }
  })

  test('answers the statuses it was told to, one delivery each and in order, and 204 again after them', async () => {
    const receiver = new WebhookReceiver('127.0.0.1')
    try {
      const url = `http://127.0.0.1:${receiver.port}/webhooks/tula`
      const send = async () => (await fetch(url, { method: 'POST', body: '{}' })).status
      expect(await send()).toBe(204)
      receiver.answerNext([500, 503])
      receiver.answerNext([410])
      expect([await send(), await send(), await send(), await send()]).toEqual([500, 503, 410, 204])
      // A delivery it failed is kept all the same: a scenario asks what arrived.
      expect([receiver.take(), receiver.take(), receiver.take()].every(Boolean)).toBe(true)
      receiver.answerNext([])
      expect(await send()).toBe(204)
    } finally {
      receiver.stop()
    }
  })

  test('nothing listens once it is stopped', async () => {
    const receiver = new WebhookReceiver('127.0.0.1')
    const { port } = receiver
    receiver.stop()
    expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow()
  })
})

const scenario = (steps: unknown[], extra: object = {}): Scenario =>
  ScenarioSchema.parse({
    name: 'webhook test',
    description: 'A test scenario.',
    needsWebhookReceiver: true,
    steps,
    ...extra,
  })

/** A target whose "server" delivers `body` to whatever URL the scenario registered. */
function webhookTarget(options: {
  deliver?: boolean
  body?: () => string
  secret?: string
  timeoutMs?: number
  sendOnRegister?: boolean
}) {
  const registered: string[] = []
  const send = async () => {
    for (const url of registered) {
      const delivery = await signed(
        options.secret ?? SECRET,
        (options.body ?? (() => JSON.stringify(event)))()
      )
      await fetch(url, { method: 'POST', headers: delivery.headers, body: delivery.body })
    }
  }
  const target: Target = {
    baseUrl: 'http://tula.test',
    publishableKey: 'tula_pk_test',
    secretKey: 'tula_sk_test',
    fetch: async (request) => {
      const body = (await request.json()) as { url: string }
      registered.push(body.url)
      if (options.sendOnRegister) {
        // A live server: its own worker sends a little later, with no help from the runner.
        setTimeout(() => void send(), 150)
      }
      return Response.json({ secret: options.secret ?? SECRET }, { status: 201 })
    },
    emailCode: async () => '123456',
    wait: async () => undefined,
    now: () => NOW,
    webhooks: {
      hostname: '127.0.0.1',
      ...(options.deliver === false ? {} : { deliver: send }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    },
  }
  return { target, registered }
}

const steps = (expect: object = {}) => [
  { name: 'start a receiver', webhook: { receiver: 'backend', captureUrl: 'url' } },
  {
    name: 'register it',
    request: {
      method: 'POST',
      path: '/v1/admin/webhook-endpoints',
      auth: 'none',
      body: { url: '{{url}}' },
    },
    expect: { status: 201 },
    capture: { secret: 'secret' },
  },
  {
    name: 'the event arrives',
    webhook: { receiver: 'backend', expect: { secret: '{{secret}}', ...expect } },
  },
]

describe('webhook steps', () => {
  test('a receiver is started, registered and its delivery checked and captured', async () => {
    const { target, registered } = webhookTarget({})
    const result = await runScenario(
      scenario([
        ...steps({
          type: 'user.created',
          body: { data: { method: 'sign_up' } },
          captureId: 'eventId',
        }),
        {
          name: 'the id was captured',
          request: {
            method: 'POST',
            path: '/again',
            auth: 'none',
            body: { url: 'x', id: '{{eventId}}' },
          },
          expect: { status: 201 },
        },
      ]),
      target
    )
    expect(formatResult(result)).toBe(
      'PASSED webhook test\n  ok   start a receiver\n  ok   register it\n  ok   the event arrives\n  ok   the id was captured'
    )
    expect(registered[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/webhooks\/tula$/)
  })

  test('the URL the server is given can be the target’s own', async () => {
    const { target, registered } = webhookTarget({})
    target.webhooks = {
      ...target.webhooks,
      hostname: '127.0.0.1',
      url: (port) => `http://localhost:${port}/in`,
    }
    const result = await runScenario(scenario(steps()), target)
    expect(result.status).toBe('passed')
    expect(registered[0]).toMatch(/^http:\/\/localhost:\d+\/in$/)
  })

  test('against a live server the step waits for the server’s own worker', async () => {
    const { target } = webhookTarget({ deliver: false, sendOnRegister: true, timeoutMs: 3_000 })
    expect((await runScenario(scenario(steps({ type: 'user.created' })), target)).status).toBe(
      'passed'
    )
  })

  test('a delivery that never arrives fails the step when the wait is over', async () => {
    const { target } = webhookTarget({ deliver: false, timeoutMs: 200 })
    const result = await runScenario(scenario(steps({ type: 'user.created' })), target)
    expect(result.status).toBe('failed')
    expect(result.steps.at(-1)?.problems).toEqual([
      'no delivery of user.created arrived at the receiver',
    ])
    const untyped = await runScenario(
      scenario(steps()),
      webhookTarget({ deliver: false, timeoutMs: 100 }).target
    )
    expect(untyped.steps.at(-1)?.problems).toEqual(['no delivery arrived at the receiver'])
  })

  test('in process, a round that sent nothing of the type fails at once', async () => {
    const { target } = webhookTarget({ body: () => JSON.stringify(EVENT_FIXTURES['user.deleted']) })
    const result = await runScenario(scenario(steps({ type: 'user.created' })), target)
    expect(result.steps.at(-1)).toEqual({
      name: 'the event arrives',
      ok: false,
      problems: ['no delivery of user.created arrived at the receiver'],
    })
  })

  test('a delivery signed with another secret fails the step, and the report shows no secret', async () => {
    const { target } = webhookTarget({})
    const wrong = [...steps()]
    wrong[2] = {
      name: 'the event arrives',
      webhook: { receiver: 'backend', expect: { secret: OTHER_SECRET } },
    }
    const result = await runScenario(scenario(wrong), target)
    expect(result.status).toBe('failed')
    expect(result.steps.at(-1)?.problems).toEqual([
      'no entry of webhook-signature is the signature for the secret',
    ])
    expect(formatResult(result)).not.toContain(OTHER_SECRET)
    expect(formatResult(result)).not.toContain(SECRET)
  })

  test('a mismatch of the event is reported, with the captured secret as its placeholder', async () => {
    const { target } = webhookTarget({})
    const result = await runScenario(scenario(steps({ body: { type: 'user.banned' } })), target)
    expect(result.steps.at(-1)?.problems).toEqual([
      'expected event.type to be "user.banned", got "user.created"',
    ])
  })

  test('a receiver that was never started fails the step that asks it', async () => {
    const { target } = webhookTarget({})
    const result = await runScenario(
      scenario([{ name: 'ask', webhook: { receiver: 'nobody', expect: { secret: SECRET } } }]),
      target
    )
    expect(result.steps[0]?.problems).toEqual([
      'the receiver nobody was not started by an earlier step',
    ])
  })

  test('every listener is stopped when the run ends, passed or failed', async () => {
    for (const expectation of [{}, { body: { type: 'nope' } }]) {
      const { target, registered } = webhookTarget({})
      await runScenario(scenario(steps(expectation)), target)
      expect(fetch(registered[0] as string, { method: 'POST', body: '{}' })).rejects.toThrow()
    }
  })

  test('a target with no receiver skips the scenario, and says why', async () => {
    const { target } = webhookTarget({})
    const result = await runScenario(scenario(steps()), { ...target, webhooks: undefined })
    expect(result).toEqual({
      name: 'webhook test',
      status: 'skipped',
      steps: [],
      reason: WEBHOOK_RECEIVER_SKIP_REASON,
    })
    expect(formatResult(result)).toBe(
      'SKIPPED webhook test\n  (needs a webhook receiver the server can reach)'
    )
    // A run that only skipped checked nothing.
    expect(exitCode({ passed: 0, failed: 0, skipped: 1 })).toBe(1)
  })
})

describe('the webhook step in a scenario file', () => {
  const base = { name: 'n', description: 'd' }
  const start = { name: 'start', webhook: { receiver: 'r', captureUrl: 'url' } }

  test('a scenario with a webhook step must say it needs a receiver', () => {
    expect(ScenarioSchema.safeParse({ ...base, steps: [start] }).success).toBe(false)
    expect(
      ScenarioSchema.safeParse({ ...base, cleanup: [start], steps: [{ name: 'w', wait: '1s' }] })
        .success
    ).toBe(false)
    expect(
      ScenarioSchema.safeParse({ ...base, needsWebhookReceiver: true, steps: [start] }).success
    ).toBe(true)
  })

  test.each([
    ['neither a URL to capture nor an expectation', { receiver: 'r' }],
    ['both', { receiver: 'r', captureUrl: 'url', expect: { secret: 's' } }],
    ['no receiver name', { captureUrl: 'url' }],
    ['an expectation without a secret', { receiver: 'r', expect: { type: 'user.created' } }],
    ['an unknown key', { receiver: 'r', captureUrl: 'url', port: 80 }],
    ['an unknown key in the expectation', { receiver: 'r', expect: { secret: 's', headers: {} } }],
    // `answers` is how the receiver is told to fail: it belongs to the step that starts it.
    ['answers on an expectation', { receiver: 'r', expect: { secret: 's' }, answers: [500] }],
    ['an empty list of answers', { receiver: 'r', captureUrl: 'url', answers: [] }],
    ['an answer that is no status', { receiver: 'r', captureUrl: 'url', answers: [99] }],
    ['an informational answer', { receiver: 'r', captureUrl: 'url', answers: [100] }],
    ['an answer that is not a number', { receiver: 'r', captureUrl: 'url', answers: ['500'] }],
    [
      'more answers than a scenario can need',
      { receiver: 'r', captureUrl: 'url', answers: Array.from({ length: 17 }, () => 500) },
    ],
  ])('refuses a webhook step with %s', (_, webhook) => {
    expect(
      ScenarioSchema.safeParse({
        ...base,
        needsWebhookReceiver: true,
        steps: [{ name: 's', webhook }],
      }).success
    ).toBe(false)
  })

  test('a receiver may be started with the statuses it answers its next deliveries with', () => {
    expect(
      ScenarioSchema.safeParse({
        ...base,
        needsWebhookReceiver: true,
        steps: [{ name: 's', webhook: { receiver: 'r', captureUrl: 'url', answers: [500, 204] } }],
      }).success
    ).toBe(true)
  })
})

describe('a receiver told to fail', () => {
  test('answers the next delivery as the scenario said, and the step still checks what arrived', async () => {
    const statuses: number[] = []
    let url = ''
    const send = async () => {
      const body = JSON.stringify(event)
      const delivery = await signed(SECRET, body)
      const answer = await fetch(url, { method: 'POST', headers: delivery.headers, body })
      statuses.push(answer.status)
    }
    const target: Target = {
      baseUrl: 'http://tula.test',
      publishableKey: 'tula_pk_test',
      fetch: async (request) => {
        url = ((await request.json()) as { url: string }).url
        return Response.json({ secret: SECRET }, { status: 201 })
      },
      emailCode: async () => '',
      wait: async () => undefined,
      now: () => NOW,
      webhooks: { hostname: '127.0.0.1', deliver: send },
    }
    const expectation = { secret: '{{secret}}', type: event.type }
    const result = await runScenario(
      ScenarioSchema.parse({
        name: 'retried',
        description: 'd',
        needsWebhookReceiver: true,
        steps: [
          {
            name: 'start a receiver that fails once',
            webhook: { receiver: 'backend', captureUrl: 'url', answers: [500] },
          },
          {
            name: 'register it',
            request: {
              method: 'POST',
              path: '/v1/admin/webhook-endpoints',
              auth: 'none',
              body: { url: '{{url}}' },
            },
            expect: { status: 201 },
            capture: { secret: 'secret' },
          },
          {
            name: 'the event arrives and is refused',
            webhook: { receiver: 'backend', expect: expectation },
          },
          {
            name: 'it arrives again and is taken',
            webhook: { receiver: 'backend', expect: expectation },
          },
        ],
      }),
      target
    )
    expect(formatResult(result)).toBe(
      [
        'PASSED retried',
        '  ok   start a receiver that fails once',
        '  ok   register it',
        '  ok   the event arrives and is refused',
        '  ok   it arrives again and is taken',
      ].join('\n')
    )
    expect(statuses).toEqual([500, 204])
  })
})
