import { afterAll, afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from 'bun:test'
import { durationToMs, signWebhook, TulaEventSchema, webhookSecretBytes } from '@tula/contract'
import type { Tenant } from '~/dependencies'
import { ServiceException } from '~/exceptions'
import * as logger from '~/lib/logger'
import * as Audit from '~/modules/audit/service'
import * as Webhooks from '~/modules/webhook/service'
import type { WebhookEndpointRecord } from '~/ports/webhook-endpoint-store'
import { createTestDeps, TEST_ACTOR, TEST_TENANT, type TestDeps } from '~/testing'

// Secret rotation (TULA-43, ADR 0034): the new secret signs beside the one it replaces for a
// fixed overlap, there are never three, and nothing of either secret is written anywhere.

const tenant: Tenant = {
  projectId: TEST_TENANT.projectId,
  environmentId: TEST_TENANT.environmentId,
  apiKeyId: 'key_1',
}
const otherTenant: Tenant = { ...tenant, environmentId: TEST_TENANT.productionEnvironmentId }

/** What the loopback receiver was sent. */
interface Received {
  path: string
  headers: Record<string, string>
  body: string
}

let received: Received[] = []
let respond: (req: Request) => Response | Promise<Response> = () =>
  new Response(null, { status: 204 })
// A real listener on loopback, which the `local` tier allows: deliveries go through the real
// outbound guard and a real socket.
const listener = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url)
    received.push({
      path: url.pathname,
      headers: Object.fromEntries(req.headers),
      body: await req.text(),
    })
    return respond(req)
  },
})
afterAll(() => listener.stop(true))

const receiverUrl = (path = '/hook') => `http://127.0.0.1:${listener.port}${path}`

let deps: TestDeps
let spies: Mock<(...args: never[]) => unknown>[] = []

beforeEach(() => {
  received = []
  respond = () => new Response(null, { status: 204 })
  deps = createTestDeps()
  for (const [id, kind] of [
    [TEST_TENANT.environmentId, 'development'],
    [TEST_TENANT.productionEnvironmentId, 'production'],
  ] as const) {
    deps.environments.add({
      id,
      projectId: TEST_TENANT.projectId,
      kind,
      createdAt: deps.clock.now(),
    })
  }
})

afterEach(() => {
  for (const spy of spies) {
    spy.mockRestore()
  }
  spies = []
})

/** Everything the logger was given while the spies were on, as one text. */
function logged(): string {
  return JSON.stringify(spies.flatMap((spy) => spy.mock.calls))
}

/** The warnings logged, as `[message, fields]`. */
function warnings(): unknown[][] {
  return (spies[2]?.mock.calls ?? []) as unknown[][]
}

function quietLogs(): void {
  for (const level of ['debug', 'info', 'warn', 'error'] as const) {
    spies.push(spyOn(logger, level).mockImplementation(() => undefined))
  }
}

async function failure(work: Promise<unknown>): Promise<ServiceException> {
  const error = await work.then(
    () => null,
    (caught: unknown) => caught
  )
  if (!(error instanceof ServiceException)) {
    throw new Error(`expected a ServiceException, got ${String(error)}`)
  }
  return error
}

function register(scope: Tenant = tenant, path = '/hook') {
  return Webhooks.create(
    deps,
    scope,
    { url: receiverUrl(path), eventTypes: ['user.deleted'], enabled: true },
    TEST_ACTOR
  )
}

/** Record that something happened, as a store's write would. Returns the event's id. */
function happen(scope: Tenant = tenant): string {
  const activity = Audit.entry(deps, scope, {
    type: 'user.deleted',
    actor: TEST_ACTOR,
    target: { type: 'user', id: deps.ids.next() },
  })
  deps.activityLog.record([activity])
  return activity.id
}

const stored = async (id: string, scope: Tenant = tenant): Promise<WebhookEndpointRecord> => {
  const record = await deps.webhookEndpoints.find(scope.environmentId, id)
  if (!record) {
    throw new Error('no such endpoint')
  }
  return record
}

/** Put a changed copy of an endpoint's row in place of the row, as someone with the database could. */
async function tamper(id: string, changes: Partial<WebhookEndpointRecord>): Promise<void> {
  const record = await stored(id)
  await deps.webhookEndpoints.delete(tenant.environmentId, id, Audit.none('fixture'))
  await deps.webhookEndpoints.insert({ ...record, ...changes }, Audit.none('fixture'))
}

/** The signature a secret makes for a delivery that arrived. */
async function signatureOf(secret: string, delivery: Received): Promise<string> {
  const key = webhookSecretBytes(secret) as Uint8Array<ArrayBuffer>
  return signWebhook(
    key,
    delivery.headers['webhook-id'] ?? '',
    Number(delivery.headers['webhook-timestamp']),
    delivery.body
  )
}

/** The entries of a delivery's signature header, in order. */
const entries = (delivery: Received): string[] =>
  (delivery.headers['webhook-signature'] ?? '').split(' ')

/** Something happens and one round delivers it: the request the receiver got. */
async function deliverOne(): Promise<Received> {
  const before = received.length
  happen()
  await Webhooks.deliverPending(deps)
  expect(received).toHaveLength(before + 1)
  return received[before] as Received
}

const rotate = (id: string, scope: Tenant = tenant) =>
  Webhooks.rotateSecret(deps, scope, id, TEST_ACTOR)

const revoke = (id: string, scope: Tenant = tenant) =>
  Webhooks.revokePreviousSecret(deps, scope, id, TEST_ACTOR)

const OVERLAP_MS = durationToMs(Webhooks.WEBHOOK_SECRET_OVERLAP)

describe('rotating a signing secret', () => {
  test('the overlap is a day: long enough to deploy a receiver, short enough that a leaked secret stops soon', () => {
    expect(Webhooks.WEBHOOK_SECRET_OVERLAP).toBe('24h')
  })

  test('the server makes the new secret, returns it once, keeps both sealed and says when the previous one stops', async () => {
    const created = await register()
    deps.clock.advance('1h')
    const rotatedAt = deps.clock.now()
    const rotated = await rotate(created.id)

    expect(rotated.secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/)
    expect(webhookSecretBytes(rotated.secret)?.length).toBe(32)
    expect(rotated.secret).not.toBe(created.secret)
    const overlapEnds = new Date(rotatedAt.getTime() + OVERLAP_MS)
    expect(rotated).toEqual({
      id: created.id,
      url: created.url,
      eventTypes: created.eventTypes,
      enabled: true,
      disabledReason: null,
      failingSince: null,
      lastFailedAt: null,
      rotationOverlapEndsAt: overlapEnds.toISOString(),
      createdAt: created.createdAt,
      updatedAt: rotatedAt.toISOString(),
      secret: rotated.secret,
    })

    const record = await stored(created.id)
    expect(record.previousSecretExpiresAt).toEqual(overlapEnds)
    // Neither column holds either secret in a readable form.
    for (const column of [record.secret, record.previousSecret ?? '']) {
      for (const secret of [created.secret, rotated.secret]) {
        expect(column).not.toContain(secret)
        expect(column).not.toContain(secret.slice('whsec_'.length))
      }
    }
    // A read says a rotation is under way and until when, and nothing of a secret.
    const read = await Webhooks.get(deps, tenant, created.id)
    expect(read).toEqual({
      id: created.id,
      url: created.url,
      eventTypes: created.eventTypes,
      enabled: true,
      disabledReason: null,
      failingSince: null,
      lastFailedAt: null,
      rotationOverlapEndsAt: overlapEnds.toISOString(),
      createdAt: created.createdAt,
      updatedAt: rotatedAt.toISOString(),
    })
    expect(await Webhooks.list(deps, tenant)).toEqual([read])
  })

  test('an endpoint that never rotated reads as having one secret', async () => {
    const created = await register()
    expect(created.rotationOverlapEndsAt).toBeNull()
    expect((await Webhooks.get(deps, tenant, created.id)).rotationOverlapEndsAt).toBeNull()
  })

  test('is audited as the administrator’s act, with the end of the overlap and nothing of either secret', async () => {
    const created = await register()
    deps.clock.advance('1h')
    const rotated = await rotate(created.id)
    const record = await stored(created.id)

    expect(deps.activityLog.entries.map((entry) => entry.type)).toEqual([
      'webhook_endpoint.created',
      'webhook_endpoint.secret_rotated',
    ])
    const entry = deps.activityLog.entries[1]
    expect(entry?.actor).toEqual({ type: TEST_ACTOR.type, id: TEST_ACTOR.id })
    expect(entry?.target).toEqual({ type: 'webhook_endpoint', id: created.id })
    expect(entry?.environmentId).toBe(tenant.environmentId)
    expect(entry?.data).toEqual({ rotationOverlapEndsAt: rotated.rotationOverlapEndsAt })
    // The event a webhook delivers is an event of the contract, with the same and no more.
    const event = deps.activityLog.events[1]
    expect(TulaEventSchema.parse(event)).toEqual(event as never)

    const written = JSON.stringify([deps.activityLog.entries, deps.activityLog.events])
    for (const secret of [created.secret, rotated.secret]) {
      expect(written).not.toContain(secret)
      expect(written).not.toContain(secret.slice('whsec_'.length))
      // Not a prefix of the key either: nothing that narrows a guess.
      expect(written).not.toContain(secret.slice('whsec_'.length, 'whsec_'.length + 8))
    }
    expect(written).not.toContain(record.secret)
    expect(written).not.toContain(record.previousSecret ?? 'absent')
    expect(written).not.toContain('127.0.0.1')
  })

  test('nothing of either secret is logged by a rotation, a delivery, a failed one or the end of the overlap', async () => {
    quietLogs()
    const created = await register()
    const rotated = await rotate(created.id)
    await deliverOne()
    respond = () => new Response(null, { status: 500 })
    await deliverOne()
    await revoke(created.id)
    await Webhooks.run(deps)
    const text = logged()
    for (const secret of [created.secret, rotated.secret]) {
      expect(text).not.toContain(secret)
      expect(text).not.toContain(secret.slice('whsec_'.length))
    }
  })

  test('an unknown endpoint is not found, and nothing is recorded', async () => {
    expect((await failure(rotate(deps.ids.next()))).status).toBe(404)
    expect((await failure(revoke(deps.ids.next()))).status).toBe(404)
    expect(deps.activityLog.entries).toEqual([])
  })

  test('another environment cannot rotate an endpoint’s secret or end its overlap: it is told what it is told of an id nobody has', async () => {
    const created = await register()
    const before = await stored(created.id)
    const unknown = await failure(rotate(deps.ids.next(), otherTenant))
    const foreign = await failure(rotate(created.id, otherTenant))
    expect(foreign.status).toBe(404)
    expect({ code: foreign.code, status: foreign.status, message: foreign.message }).toEqual({
      code: unknown.code,
      status: unknown.status,
      message: unknown.message,
    })
    expect(await stored(created.id)).toEqual(before)

    // The same with a rotation under way: the other environment learns nothing of it.
    await rotate(created.id)
    const during = await stored(created.id)
    const foreignRevoke = await failure(revoke(created.id, otherTenant))
    const foreignRotate = await failure(rotate(created.id, otherTenant))
    expect([foreignRevoke.status, foreignRotate.status]).toEqual([404, 404])
    expect(foreignRevoke.code).toBe(unknown.code)
    expect(await stored(created.id)).toEqual(during)
    expect(deps.activityLog.entries.map((entry) => entry.type)).toEqual([
      'webhook_endpoint.created',
      'webhook_endpoint.secret_rotated',
    ])
  })

  test('an endpoint that is switched off can be rotated: its secret may be why it is off', async () => {
    const created = await register()
    await Webhooks.update(deps, tenant, created.id, { enabled: false }, TEST_ACTOR)
    const rotated = await rotate(created.id)
    expect(rotated.enabled).toBe(false)
    expect(rotated.rotationOverlapEndsAt).not.toBeNull()
    await Webhooks.update(deps, tenant, created.id, { enabled: true }, TEST_ACTOR)
    const delivery = await deliverOne()
    expect(entries(delivery)).toEqual([
      await signatureOf(rotated.secret, delivery),
      await signatureOf(created.secret, delivery),
    ])
  })

  test('an endpoint removed while its rotation is under way is not found, and nothing is recorded', async () => {
    const created = await register()
    const seal = deps.secretBox.seal.bind(deps.secretBox)
    spies.push(
      spyOn(deps.secretBox, 'seal').mockImplementation(async (...args) => {
        await deps.webhookEndpoints.delete(tenant.environmentId, created.id, Audit.none('fixture'))
        return seal(...args)
      })
    )
    expect((await failure(rotate(created.id))).status).toBe(404)
    expect(await deps.webhookEndpoints.list(tenant.environmentId)).toEqual([])
    expect(deps.activityLog.entries.map((entry) => entry.type)).toEqual([
      'webhook_endpoint.created',
    ])
  })
})

describe('the two secrets of an overlap', () => {
  test('every delivery carries a signature for both, the current secret’s first', async () => {
    const created = await register()
    const before = await deliverOne()
    expect(entries(before)).toEqual([await signatureOf(created.secret, before)])

    const rotated = await rotate(created.id)
    const during = await deliverOne()
    expect(entries(during)).toEqual([
      await signatureOf(rotated.secret, during),
      await signatureOf(created.secret, during),
    ])
    // Well inside what a verifier reads: two entries, under a hundred characters.
    expect((during.headers['webhook-signature'] ?? '').length).toBeLessThan(100)
  })

  test('the previous secret signs until the instant the overlap ends: a millisecond before it does, at it it does not', async () => {
    const created = await register()
    const rotated = await rotate(created.id)
    const overlapEnds = new Date(rotated.rotationOverlapEndsAt).getTime()

    deps.clock.set(new Date(overlapEnds - 1))
    const last = await deliverOne()
    expect(entries(last)).toEqual([
      await signatureOf(rotated.secret, last),
      await signatureOf(created.secret, last),
    ])

    deps.clock.set(new Date(overlapEnds))
    const first = await deliverOne()
    expect(entries(first)).toEqual([await signatureOf(rotated.secret, first)])
  })

  test('the previous secret stops signing at the end of the overlap whether or not anything has cleared it from the row', async () => {
    const created = await register()
    const rotated = await rotate(created.id)
    const during = await stored(created.id)
    deps.clock.set(new Date(rotated.rotationOverlapEndsAt))
    // No round has run since the overlap ended: the ciphertext is still there, and a request
    // made on demand must not use it.
    expect(await stored(created.id)).toEqual(during)
    const result = await Webhooks.sendTest(deps, tenant, created.id, { eventType: 'user.created' })
    expect(result.outcome).toBe('delivered')
    const [delivery] = received as [Received]
    expect(entries(delivery)).toEqual([await signatureOf(rotated.secret, delivery)])
    // And a read no longer says a rotation is under way.
    expect((await Webhooks.get(deps, tenant, created.id)).rotationOverlapEndsAt).toBeNull()
  })

  test('a previous secret that expires while a round is sending stops signing for the rest of that round', async () => {
    const created = await register()
    const rotated = await rotate(created.id)
    const overlapEnds = new Date(rotated.rotationOverlapEndsAt)
    deps.clock.set(new Date(overlapEnds.getTime() - 1))
    happen()
    happen()
    // The first request of the lane takes the clock past the end of the overlap.
    respond = () => {
      deps.clock.set(overlapEnds)
      return new Response(null, { status: 204 })
    }
    await Webhooks.deliverPending(deps)
    expect(received).toHaveLength(2)
    const [early, late] = received as [Received, Received]
    expect(entries(early)).toHaveLength(2)
    expect(entries(late)).toEqual([await signatureOf(rotated.secret, late)])
  })

  test('a test event and a delivery sent again are signed the same way as the worker signs', async () => {
    const created = await register()
    const worker = await deliverOne()
    const [delivery] = deps.webhookDeliveries.rows
    const rotated = await rotate(created.id)

    await Webhooks.sendTest(deps, tenant, created.id, { eventType: 'user.created' })
    await Webhooks.redeliver(deps, tenant, created.id, delivery?.id ?? '')
    const [, tested, again] = received as [Received, Received, Received]
    for (const one of [tested, again]) {
      expect(entries(one)).toEqual([
        await signatureOf(rotated.secret, one),
        await signatureOf(created.secret, one),
      ])
    }
    expect(again.headers['webhook-id']).toBe(worker.headers['webhook-id'] ?? 'none')

    deps.clock.set(new Date(rotated.rotationOverlapEndsAt))
    await Webhooks.sendTest(deps, tenant, created.id, { eventType: 'user.created' })
    await Webhooks.redeliver(deps, tenant, created.id, delivery?.id ?? '')
    for (const one of received.slice(3)) {
      expect(entries(one)).toEqual([await signatureOf(rotated.secret, one)])
    }
    expect(received).toHaveLength(5)
  })

  test('a delivery made while a rotation commits is signed with the old secret alone or with both, never with the new one alone', async () => {
    const created = await register()
    happen()
    happen()
    let rotated: Awaited<ReturnType<typeof rotate>> | undefined
    // The rotation commits while the lane's first request is in flight: the lane goes on with
    // the row it read before.
    respond = async () => {
      rotated ??= await rotate(created.id)
      return new Response(null, { status: 204 })
    }
    await Webhooks.deliverPending(deps)
    expect(received).toHaveLength(2)
    const [first, second] = received as [Received, Received]
    for (const one of [first, second]) {
      // The receiver still on the old secret, and the one that holds both, verify it.
      expect(entries(one)).toEqual([await signatureOf(created.secret, one)])
    }
    // From the next round on, both.
    const next = await deliverOne()
    expect(entries(next)).toEqual([
      await signatureOf(rotated?.secret ?? '', next),
      await signatureOf(created.secret, next),
    ])
  })
})

describe('never more than two secrets', () => {
  test('rotating again during the overlap is refused with a fixed word, and changes and records nothing', async () => {
    const created = await register()
    const rotated = await rotate(created.id)
    const before = await stored(created.id)
    deps.clock.set(new Date(new Date(rotated.rotationOverlapEndsAt).getTime() - 1))

    const refused = await failure(rotate(created.id))
    expect({ code: refused.code, status: refused.status, params: refused.params }).toEqual({
      code: 'webhook.rotation_refused',
      status: 409,
      params: { reason: 'rotation_in_progress' },
    })
    expect(await stored(created.id)).toEqual(before)
    expect(deps.activityLog.entries.map((entry) => entry.type)).toEqual([
      'webhook_endpoint.created',
      'webhook_endpoint.secret_rotated',
    ])
    const delivery = await deliverOne()
    expect(entries(delivery)).toHaveLength(2)
  })

  test('once the overlap has ended a new rotation is allowed, and the oldest secret signs nothing', async () => {
    const created = await register()
    const second = await rotate(created.id)
    deps.clock.set(new Date(second.rotationOverlapEndsAt))
    // Allowed at that very instant, cleared from the row yet or not.
    const third = await rotate(created.id)
    const delivery = await deliverOne()
    expect(entries(delivery)).toEqual([
      await signatureOf(third.secret, delivery),
      await signatureOf(second.secret, delivery),
    ])
    expect(entries(delivery)).not.toContain(await signatureOf(created.secret, delivery))
  })

  test('two rotations at once, on one instance or two: one is made, the other is refused, and two secrets sign', async () => {
    const created = await register()
    const outcomes = await Promise.allSettled([rotate(created.id), rotate(created.id)])
    const made = outcomes.flatMap((outcome) =>
      outcome.status === 'fulfilled' ? [outcome.value] : []
    )
    const refused = outcomes.flatMap((outcome) =>
      outcome.status === 'rejected' ? [outcome.reason as ServiceException] : []
    )
    expect(made).toHaveLength(1)
    expect(refused).toHaveLength(1)
    expect(refused[0]?.code).toBe('webhook.rotation_refused')
    expect(refused[0]?.params).toEqual({ reason: 'rotation_in_progress' })
    expect(
      deps.activityLog.entries.filter((entry) => entry.type === 'webhook_endpoint.secret_rotated')
    ).toHaveLength(1)
    const delivery = await deliverOne()
    expect(entries(delivery)).toEqual([
      await signatureOf(made[0]?.secret ?? '', delivery),
      await signatureOf(created.secret, delivery),
    ])
  })
})

describe('ending the overlap early', () => {
  test('the previous secret stops signing at once, its ciphertext is gone, and it is recorded with nothing in it', async () => {
    const created = await register()
    const rotated = await rotate(created.id)
    deps.clock.advance('10m')
    const revokedAt = deps.clock.now()

    const endpoint = await revoke(created.id)
    expect(endpoint.rotationOverlapEndsAt).toBeNull()
    expect(endpoint.updatedAt).toBe(revokedAt.toISOString())
    expect(JSON.stringify(endpoint)).not.toContain('whsec_')
    const record = await stored(created.id)
    expect(record.previousSecret).toBeNull()
    expect(record.previousSecretExpiresAt).toBeNull()

    const delivery = await deliverOne()
    expect(entries(delivery)).toEqual([await signatureOf(rotated.secret, delivery)])

    expect(deps.activityLog.entries.map((entry) => entry.type)).toEqual([
      'webhook_endpoint.created',
      'webhook_endpoint.secret_rotated',
      'webhook_endpoint.previous_secret_revoked',
      'user.deleted',
    ])
    const entry = deps.activityLog.entries[2]
    expect(entry?.actor).toEqual({ type: TEST_ACTOR.type, id: TEST_ACTOR.id })
    expect(entry?.target).toEqual({ type: 'webhook_endpoint', id: created.id })
    expect(entry?.data).toEqual({})
    expect(TulaEventSchema.parse(deps.activityLog.events[2])).toEqual(
      deps.activityLog.events[2] as never
    )
  })

  test('after it a new rotation is allowed at once: the way out when the new secret is the one that leaked', async () => {
    const created = await register()
    const leaked = await rotate(created.id)
    await revoke(created.id)
    const replacement = await rotate(created.id)
    await revoke(created.id)
    const delivery = await deliverOne()
    expect(entries(delivery)).toEqual([await signatureOf(replacement.secret, delivery)])
    for (const gone of [created.secret, leaked.secret]) {
      expect(entries(delivery)).not.toContain(await signatureOf(gone, delivery))
    }
  })

  test.each([
    ['never rotated', async (_id: string) => undefined],
    [
      'rotated, and the overlap ended by itself a moment ago',
      async (id: string) => {
        const rotated = await rotate(id)
        deps.clock.set(new Date(rotated.rotationOverlapEndsAt))
      },
    ],
    [
      'rotated, and the overlap was already ended early',
      async (id: string) => {
        await rotate(id)
        await revoke(id)
      },
    ],
  ])('is refused for an endpoint that %s, and records nothing', async (_, prepare) => {
    const created = await register()
    await prepare(created.id)
    const before = await stored(created.id)
    const recorded = deps.activityLog.entries.length
    const refused = await failure(revoke(created.id))
    expect({ code: refused.code, status: refused.status, params: refused.params }).toEqual({
      code: 'webhook.rotation_refused',
      status: 409,
      params: { reason: 'no_rotation_in_progress' },
    })
    expect(await stored(created.id)).toEqual(before)
    expect(deps.activityLog.entries).toHaveLength(recorded)
  })
})

describe('deleting the previous secret once it has stopped signing', () => {
  test('the first round at or after the end of the overlap deletes its ciphertext; a round a millisecond before does not', async () => {
    const created = await register()
    const rotated = await rotate(created.id)
    const during = await stored(created.id)
    const overlapEnds = new Date(rotated.rotationOverlapEndsAt)

    deps.clock.set(new Date(overlapEnds.getTime() - 1))
    const early = await Webhooks.deliverPending(deps)
    expect(early.secretsExpired).toBe(0)
    expect(await stored(created.id)).toEqual(during)

    deps.clock.set(overlapEnds)
    const report = await Webhooks.deliverPending(deps)
    expect(report.secretsExpired).toBe(1)
    // The current secret and everything else about the endpoint are as they were: no
    // administrator changed it, and nothing is recorded.
    expect(await stored(created.id)).toEqual({
      ...during,
      previousSecret: null,
      previousSecretExpiresAt: null,
    })
    expect(deps.activityLog.entries.map((entry) => entry.type)).toEqual([
      'webhook_endpoint.created',
      'webhook_endpoint.secret_rotated',
    ])
    expect((await Webhooks.deliverPending(deps)).secretsExpired).toBe(0)
  })

  test('it is deleted from an endpoint that is switched off and from one that is sent nothing', async () => {
    const off = await register(tenant, '/off')
    const idle = await register(otherTenant, '/idle')
    await rotate(off.id)
    const rotated = await rotate(idle.id, otherTenant)
    await Webhooks.update(deps, tenant, off.id, { enabled: false }, TEST_ACTOR)
    deps.clock.set(new Date(rotated.rotationOverlapEndsAt))
    const report = await Webhooks.deliverPending(deps)
    expect(report.secretsExpired).toBe(2)
    expect((await stored(off.id)).previousSecret).toBeNull()
    expect((await stored(idle.id, otherTenant)).previousSecret).toBeNull()
    expect(received).toEqual([])
  })

  test('a round that deleted one says so in its log line, with a count and nothing else of it', async () => {
    quietLogs()
    const created = await register()
    const rotated = await rotate(created.id)
    await Webhooks.run(deps)
    deps.clock.set(new Date(rotated.rotationOverlapEndsAt))
    await Webhooks.run(deps)
    const lines = (spies[1]?.mock.calls ?? []) as unknown[][]
    const [message, fields] = lines.at(-1) ?? []
    expect(message).toBe('webhook delivery round finished')
    // Counts only: the line is the round's report, and nothing in it names an endpoint.
    expect(fields).toEqual({
      environments: 2,
      failed: 0,
      events: 0,
      unowed: 0,
      queued: 0,
      delivered: 0,
      undelivered: 0,
      deferred: 0,
      givenUp: 0,
      disabled: 0,
      secretsExpired: 1,
      skipped: 0,
    })
  })
})

describe('what a sealed secret is bound to', () => {
  /** Seal a secret as this version's predecessor did: environment and endpoint id. */
  const sealAsBefore = (secret: string, environmentId: string, endpointId: string) =>
    deps.secretBox.seal(
      Webhooks.WEBHOOK_SECRET_PURPOSE,
      new TextEncoder().encode(secret),
      `${environmentId}:${endpointId}`
    )

  test('a secret stored before rotation existed still opens, signs and can be rotated', async () => {
    const created = await register()
    const existing = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'
    // The row as migration 0020 finds it: sealed for environment and endpoint id, and no
    // previous secret.
    await tamper(created.id, {
      secret: await sealAsBefore(existing, tenant.environmentId, created.id),
      previousSecret: null,
      previousSecretExpiresAt: null,
    })
    const before = await deliverOne()
    expect(entries(before)).toEqual([await signatureOf(existing, before)])

    const rotated = await rotate(created.id)
    const during = await deliverOne()
    expect(entries(during)).toEqual([
      await signatureOf(rotated.secret, during),
      await signatureOf(existing, during),
    ])
  })

  test('the ciphertext of the current secret, copied into the previous slot, does not open there', async () => {
    quietLogs()
    const created = await register()
    const rotated = await rotate(created.id)
    const record = await stored(created.id)
    await tamper(created.id, { previousSecret: record.secret })
    const delivery = await deliverOne()
    expect(entries(delivery)).toEqual([await signatureOf(rotated.secret, delivery)])
  })

  test('the ciphertext of the previous secret, copied into the current slot, does not open there: nothing is sent', async () => {
    quietLogs()
    const created = await register()
    await rotate(created.id)
    const record = await stored(created.id)
    await tamper(created.id, { secret: record.previousSecret ?? '' })
    happen()
    await Webhooks.deliverPending(deps)
    expect(received).toEqual([])
    expect(deps.webhookDeliveries.rows.map((row) => row.failureReason)).toEqual(['signing_failed'])
  })

  test.each([
    [
      'another endpoint of the same environment',
      async () => {
        const donor = await register(tenant, '/donor')
        await rotate(donor.id)
        return (await stored(donor.id)).previousSecret
      },
    ],
    [
      'an endpoint of another environment',
      async () => {
        const donor = await register(otherTenant, '/donor')
        await rotate(donor.id, otherTenant)
        return (await stored(donor.id, otherTenant)).previousSecret
      },
    ],
    ['nothing that was ever sealed', async () => 'whsec_plain'],
  ])('a previous secret taken from %s does not open', async (_, take) => {
    quietLogs()
    const created = await register()
    const rotated = await rotate(created.id)
    await tamper(created.id, { previousSecret: await take() })
    const delivery = (await deliverOneTo('/hook')) as Received
    expect(entries(delivery)).toEqual([await signatureOf(rotated.secret, delivery)])
  })

  /** Something happens, a round runs: the request that reached `path`. */
  async function deliverOneTo(path: string): Promise<Received | undefined> {
    happen()
    await Webhooks.deliverPending(deps)
    return received.findLast((one) => one.path === path)
  }
})

describe('a previous secret the server cannot open', () => {
  test('the delivery is made, signed with the current secret alone, and it is said once per endpoint per round', async () => {
    quietLogs()
    const created = await register()
    const rotated = await rotate(created.id)
    await tamper(created.id, { previousSecret: 'not-sealed' })
    const events = [happen(), happen(), happen()]

    const report = await Webhooks.deliverPending(deps)

    expect(received).toHaveLength(events.length)
    for (const delivery of received) {
      expect(entries(delivery)).toEqual([await signatureOf(rotated.secret, delivery)])
    }
    // Requests were made and answered: these are deliveries, not put off.
    expect(report.delivered).toBe(3)
    expect(report.deferred).toBe(0)
    const said = () =>
      warnings().filter(([message]) => String(message).includes('previous signing secret'))
    expect(said()).toEqual([
      [
        'webhook previous signing secret could not be opened; deliveries to the endpoint carry the current secret’s signature only',
        { environmentId: tenant.environmentId, endpointId: created.id },
      ],
    ])
    // Said again by the next round that sends something, once.
    await deliverOne()
    expect(said()).toHaveLength(2)
    // A round with nothing to send to it says nothing.
    await Webhooks.deliverPending(deps)
    expect(said()).toHaveLength(2)
    expect(logged()).not.toContain(rotated.secret)
    expect(logged()).not.toContain(created.secret)
    expect(logged()).not.toContain('not-sealed')
  })

  test('once the overlap has ended nothing is said: the secret was not going to sign anyway', async () => {
    quietLogs()
    const created = await register()
    const rotated = await rotate(created.id)
    await tamper(created.id, { previousSecret: 'not-sealed' })
    deps.clock.set(new Date(rotated.rotationOverlapEndsAt))
    await Webhooks.sendTest(deps, tenant, created.id, { eventType: 'user.created' })
    expect(received).toHaveLength(1)
    expect(warnings().filter(([message]) => String(message).includes('signing secret'))).toEqual([])
  })

  test('a test event and a delivery sent again are still made, and say it too', async () => {
    quietLogs()
    const created = await register()
    await deliverOne()
    const [delivery] = deps.webhookDeliveries.rows
    const rotated = await rotate(created.id)
    await tamper(created.id, { previousSecret: 'not-sealed' })

    const tested = await Webhooks.sendTest(deps, tenant, created.id, { eventType: 'user.created' })
    const again = await Webhooks.redeliver(deps, tenant, created.id, delivery?.id ?? '')
    expect([tested.outcome, again.outcome]).toEqual(['delivered', 'delivered'])
    for (const one of received.slice(1)) {
      expect(entries(one)).toEqual([await signatureOf(rotated.secret, one)])
    }
    expect(
      warnings().filter(([message]) => String(message).includes('previous signing secret'))
    ).toHaveLength(2)
  })
})

describe('a current secret the server cannot open', () => {
  test('cannot be rotated: the secret that signs could not be kept signing, and nothing changes', async () => {
    quietLogs()
    const created = await register()
    await tamper(created.id, { secret: 'not-sealed' })
    const before = await stored(created.id)
    const refused = await failure(rotate(created.id))
    expect({ code: refused.code, status: refused.status, params: refused.params }).toEqual({
      code: 'webhook.rotation_refused',
      status: 409,
      params: { reason: 'secret_unreadable' },
    })
    expect(await stored(created.id)).toEqual(before)
    expect(deps.activityLog.entries.map((entry) => entry.type)).toEqual([
      'webhook_endpoint.created',
    ])
    expect(logged()).not.toContain('not-sealed')
  })

  test('a sealed value that opens to something that is no signing secret cannot be rotated either: it would be kept as a previous secret that signs nothing', async () => {
    quietLogs()
    const created = await register()
    await tamper(created.id, {
      secret: await deps.secretBox.seal(
        Webhooks.WEBHOOK_SECRET_PURPOSE,
        new TextEncoder().encode('canary-not-a-webhook-secret'),
        `${tenant.environmentId}:${created.id}`
      ),
    })
    const before = await stored(created.id)
    const refused = await failure(rotate(created.id))
    expect(refused.code).toBe('webhook.rotation_refused')
    expect(refused.params).toEqual({ reason: 'secret_unreadable' })
    expect(await stored(created.id)).toEqual(before)
    expect(`${refused.message} ${refused.detail} ${JSON.stringify(refused.params)}`).not.toContain(
      'canary'
    )
    expect(logged()).not.toContain('canary')
  })

  test('during an overlap nothing is sent, as before: the previous secret never signs alone', async () => {
    quietLogs()
    const created = await register()
    await rotate(created.id)
    await tamper(created.id, { secret: 'not-sealed' })
    happen()
    const report = await Webhooks.deliverPending(deps)
    expect(received).toEqual([])
    expect(report.deferred).toBe(1)
    expect(deps.webhookDeliveries.rows.map((row) => [row.failureReason, row.attempts])).toEqual([
      ['signing_failed', 0],
    ])
  })
})
