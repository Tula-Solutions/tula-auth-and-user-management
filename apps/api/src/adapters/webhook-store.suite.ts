import { beforeEach, describe, expect, test } from 'bun:test'
import * as Audit from '~/modules/audit/service'
import type { Activity } from '~/ports/activity-log'
import type {
  DeliveryTransition,
  NewWebhookAttempt,
  WebhookDeliveryRecord,
  WebhookDeliveryStore,
} from '~/ports/webhook-delivery-store'
import type { WebhookEndpointRecord, WebhookEndpointStore } from '~/ports/webhook-endpoint-store'
import { comparable } from '~/testing/comparable'

/** A tenant for the suite. */
export interface WebhookSuiteTenant {
  projectId: string
  environmentId: string
}

/** An outbox event a test puts there directly. */
export interface SeededEvent {
  type: string
  payload: Record<string, unknown>
  occurredAt: Date
}

/** What the stores under test provide. */
export interface WebhookSuiteContext {
  endpoints: WebhookEndpointStore
  deliveries: WebhookDeliveryStore
  /** The audit actions recorded so far in tenant `a`, oldest first. */
  recorded: () => Promise<string[]>
  /** Put an event in the outbox, as a store's write would. Returns its id. */
  seedEvent: (tenant: WebhookSuiteTenant, event: SeededEvent) => Promise<string>
  /** When an event was marked delivered; `null` while it waits. */
  deliveredAt: (tenant: WebhookSuiteTenant, eventId: string) => Promise<Date | null>
  /** Whether the outbox still holds the event. */
  eventExists: (tenant: WebhookSuiteTenant, eventId: string) => Promise<boolean>
  a: WebhookSuiteTenant
  b: WebhookSuiteTenant
}

/**
 * Behaviour every `WebhookEndpointStore` and `WebhookDeliveryStore` must have. Run against each
 * adapter so the memory stores used by unit tests can't drift from Postgres.
 *
 * @param name - Adapter name for the report.
 * @param setup - Builds a fresh context; called before each test.
 */
export function describeWebhookStores(
  name: string,
  setup: () => Promise<WebhookSuiteContext>
): void {
  const now = new Date('2026-01-01T00:00:00.000Z')
  const later = new Date('2026-01-02T00:00:00.000Z')
  let ctx: WebhookSuiteContext

  function endpoint(
    tenant: WebhookSuiteTenant,
    overrides: Partial<WebhookEndpointRecord> = {}
  ): WebhookEndpointRecord {
    return {
      id: Bun.randomUUIDv7(),
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      url: 'https://hooks.example.com/tula',
      eventTypes: ['user.created', 'session.created'],
      secret: 'v1.sealed.secret',
      enabled: true,
      disabledReason: null,
      failingSince: null,
      lastFailedAt: null,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    }
  }

  function activity(
    tenant: WebhookSuiteTenant,
    type:
      | 'webhook_endpoint.created'
      | 'webhook_endpoint.updated'
      | 'webhook_endpoint.deleted'
      | 'webhook_endpoint.disabled',
    endpointId: string
  ): Activity {
    return {
      id: Bun.randomUUIDv7(),
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      type,
      actor: { type: 'admin', id: null },
      target: { type: 'webhook_endpoint', id: endpointId },
      ipAddress: null,
      userAgent: null,
      data:
        type === 'webhook_endpoint.updated'
          ? { changed: ['enabled'] }
          : type === 'webhook_endpoint.disabled'
            ? { reason: 'failing' }
            : {},
      occurredAt: now,
    }
  }

  /** A request that was made, as the worker hands it to the store. */
  function attempt(overrides: Partial<NewWebhookAttempt> = {}): NewWebhookAttempt {
    return {
      id: Bun.randomUUIDv7(),
      attemptedAt: later,
      statusCode: 500,
      durationMs: 12,
      failureReason: null,
      ...overrides,
    }
  }

  const retryAt = new Date('2026-01-02T00:00:05.000Z')
  const retry: DeliveryTransition = { state: 'pending', nextAttemptAt: retryAt, completedAt: null }
  const done: DeliveryTransition = { state: 'delivered', nextAttemptAt: null, completedAt: later }
  const gaveUp: DeliveryTransition = { state: 'failed', nextAttemptAt: null, completedAt: later }

  /** Register an endpoint in `tenant`. */
  async function registered(tenant: WebhookSuiteTenant): Promise<WebhookEndpointRecord> {
    const record = endpoint(tenant)
    await ctx.endpoints.insert(record, Audit.none('fixture'))
    return record
  }

  /** Queue one delivery of a new event to `endpointId`, at `at`. Returns the delivery's id. */
  async function queued(
    tenant: WebhookSuiteTenant,
    endpointId: string,
    at: Date = now,
    type = 'user.created'
  ): Promise<{ id: string; eventId: string }> {
    const eventId = await ctx.seedEvent(tenant, { ...seeded(0, type), occurredAt: at })
    const id = Bun.randomUUIDv7()
    expect(
      await ctx.deliveries.enqueue([{ id, ...tenant, endpointId, eventId, eventType: type, at }])
    ).toBe(1)
    return { id, eventId }
  }

  const read = async (tenant: WebhookSuiteTenant, endpointId: string, id: string) =>
    ctx.deliveries.find(tenant.environmentId, endpointId, id)

  const seeded = (minutes: number, type = 'user.created'): SeededEvent => ({
    type,
    payload: { type, schemaVersion: 1 },
    occurredAt: new Date(now.getTime() + minutes * 60_000),
  })

  describe(`${name} (WebhookEndpointStore)`, () => {
    beforeEach(async () => {
      ctx = await setup()
    })

    test('an inserted endpoint is found and listed, and its activity is recorded with it', async () => {
      const record = endpoint(ctx.a)
      const stored = await ctx.endpoints.insert(
        record,
        activity(ctx.a, 'webhook_endpoint.created', record.id)
      )
      expect(stored).toEqual(record)
      expect(await ctx.endpoints.find(ctx.a.environmentId, record.id)).toEqual(record)
      expect(await ctx.endpoints.list(ctx.a.environmentId)).toEqual([record])
      expect(await ctx.recorded()).toEqual(['webhook_endpoint.created'])
    })

    test('endpoints are listed oldest first', async () => {
      const second = endpoint(ctx.a, { createdAt: later, url: 'https://b.example.com/' })
      const first = endpoint(ctx.a, { url: 'https://a.example.com/' })
      await ctx.endpoints.insert(second, Audit.none('fixture'))
      await ctx.endpoints.insert(first, Audit.none('fixture'))
      const listed = await ctx.endpoints.list(ctx.a.environmentId)
      expect(listed.map((one) => one.url)).toEqual([
        'https://a.example.com/',
        'https://b.example.com/',
      ])
    })

    test('an explicit "not recorded" writes the endpoint and no activity', async () => {
      await ctx.endpoints.insert(endpoint(ctx.a), Audit.none('fixture'))
      expect(await ctx.recorded()).toEqual([])
    })

    test('an update sets the fields it names and keeps the others', async () => {
      const record = endpoint(ctx.a)
      await ctx.endpoints.insert(record, Audit.none('fixture'))
      const updated = await ctx.endpoints.update(
        ctx.a.environmentId,
        record.id,
        { enabled: false },
        later,
        activity(ctx.a, 'webhook_endpoint.updated', record.id)
      )
      expect(updated).toEqual({ ...record, enabled: false, updatedAt: later })
      const again = await ctx.endpoints.update(
        ctx.a.environmentId,
        record.id,
        { url: 'https://new.example.com/in', eventTypes: ['user.deleted'] },
        later,
        activity(ctx.a, 'webhook_endpoint.updated', record.id)
      )
      expect(again).toEqual({
        ...record,
        url: 'https://new.example.com/in',
        eventTypes: ['user.deleted'],
        enabled: false,
        updatedAt: later,
      })
      expect(await ctx.endpoints.find(ctx.a.environmentId, record.id)).toEqual(again)
      expect(await ctx.recorded()).toEqual(['webhook_endpoint.updated', 'webhook_endpoint.updated'])
    })

    test('an update never changes the secret, the id or when the endpoint was created', async () => {
      const record = endpoint(ctx.a)
      await ctx.endpoints.insert(record, Audit.none('fixture'))
      const updated = await ctx.endpoints.update(
        ctx.a.environmentId,
        record.id,
        { url: 'https://new.example.com/' },
        later,
        Audit.none('fixture')
      )
      expect(comparable(updated)).toMatchObject(
        comparable({ id: record.id, secret: record.secret, createdAt: now })
      )
    })

    test('updating an endpoint that does not exist changes and records nothing', async () => {
      expect(
        await ctx.endpoints.update(
          ctx.a.environmentId,
          Bun.randomUUIDv7(),
          { enabled: false },
          later,
          activity(ctx.a, 'webhook_endpoint.updated', Bun.randomUUIDv7())
        )
      ).toBeNull()
      expect(await ctx.recorded()).toEqual([])
    })

    test('a deleted endpoint is gone, and deleting it again removes and records nothing', async () => {
      const record = endpoint(ctx.a)
      await ctx.endpoints.insert(record, Audit.none('fixture'))
      const remove = () =>
        ctx.endpoints.delete(
          ctx.a.environmentId,
          record.id,
          activity(ctx.a, 'webhook_endpoint.deleted', record.id)
        )
      expect(await remove()).toBe(true)
      expect(await ctx.endpoints.find(ctx.a.environmentId, record.id)).toBeNull()
      expect(await remove()).toBe(false)
      expect(await ctx.recorded()).toEqual(['webhook_endpoint.deleted'])
    })

    test('a run written from what was read does not bring back one that was cleared meanwhile', async () => {
      const record = await registered(ctx.a)
      const first = new Date('2026-01-03T00:00:00.000Z')
      const second = new Date('2026-01-04T00:00:00.000Z')
      const third = new Date('2026-01-05T00:00:00.000Z')
      const none = { failingSince: null, lastFailedAt: null }
      // From nothing to a run: what was read is what is there.
      expect(
        await ctx.endpoints.setHealth(ctx.a.environmentId, record.id, none, {
          failingSince: first,
          lastFailedAt: first,
        })
      ).toBe(true)
      const read = { failingSince: first, lastFailedAt: first }
      // An administrator switches it off and on again: the run is forgotten.
      await ctx.endpoints.update(
        ctx.a.environmentId,
        record.id,
        { enabled: true, resetHealth: true },
        later,
        Audit.none('fixture')
      )
      // The worker, still holding what it read before that, records its next failure.
      expect(
        await ctx.endpoints.setHealth(ctx.a.environmentId, record.id, read, {
          failingSince: first,
          lastFailedAt: second,
        })
      ).toBe(false)
      expect(await ctx.endpoints.find(ctx.a.environmentId, record.id)).toEqual({
        ...record,
        updatedAt: later,
      })
      // Half right is not right: the same start, another last failure.
      await ctx.endpoints.setHealth(ctx.a.environmentId, record.id, none, {
        failingSince: first,
        lastFailedAt: second,
      })
      expect(
        await ctx.endpoints.setHealth(ctx.a.environmentId, record.id, read, {
          failingSince: first,
          lastFailedAt: third,
        })
      ).toBe(false)
      expect(
        await ctx.endpoints.setHealth(
          ctx.a.environmentId,
          record.id,
          { failingSince: first, lastFailedAt: second },
          { failingSince: first, lastFailedAt: third }
        )
      ).toBe(true)
      expect((await ctx.endpoints.find(ctx.a.environmentId, record.id))?.lastFailedAt).toEqual(
        third
      )
      // Whatever is there (`null`): a success clears a run it did not read.
      expect(await ctx.endpoints.setHealth(ctx.a.environmentId, record.id, null, none)).toBe(true)
      expect(await ctx.endpoints.setHealth(ctx.b.environmentId, record.id, null, read)).toBe(false)
      expect(
        await ctx.endpoints.setHealth(ctx.a.environmentId, Bun.randomUUIDv7(), null, read)
      ).toBe(false)
      expect(await ctx.recorded()).toEqual([])
    })

    test('the server switches an endpoint off once, with its reason, and that is recorded', async () => {
      const record = await registered(ctx.a)
      const disable = (reason: 'failing' | 'gone') =>
        ctx.endpoints.disable(
          ctx.a.environmentId,
          record.id,
          reason,
          later,
          activity(ctx.a, 'webhook_endpoint.disabled', record.id)
        )
      expect(await disable('failing')).toBe(true)
      expect(await ctx.endpoints.find(ctx.a.environmentId, record.id)).toEqual({
        ...record,
        enabled: false,
        disabledReason: 'failing',
        updatedAt: later,
      })
      // Already off: nothing changes, and the first reason stands.
      expect(await disable('gone')).toBe(false)
      expect((await ctx.endpoints.find(ctx.a.environmentId, record.id))?.disabledReason).toBe(
        'failing'
      )
      expect(
        await ctx.endpoints.disable(
          ctx.a.environmentId,
          Bun.randomUUIDv7(),
          'gone',
          later,
          activity(ctx.a, 'webhook_endpoint.disabled', record.id)
        )
      ).toBe(false)
      expect(await ctx.recorded()).toEqual(['webhook_endpoint.disabled'])
    })

    test('an endpoint an administrator switched off is not switched off again by the server', async () => {
      const record = endpoint(ctx.a, { enabled: false })
      await ctx.endpoints.insert(record, Audit.none('fixture'))
      expect(
        await ctx.endpoints.disable(
          ctx.a.environmentId,
          record.id,
          'failing',
          later,
          activity(ctx.a, 'webhook_endpoint.disabled', record.id)
        )
      ).toBe(false)
      expect(await ctx.endpoints.find(ctx.a.environmentId, record.id)).toEqual(record)
      expect(await ctx.recorded()).toEqual([])
    })

    test('an update can forget what the worker held against an endpoint, and otherwise keeps it', async () => {
      const record = await registered(ctx.a)
      await ctx.endpoints.setHealth(ctx.a.environmentId, record.id, null, {
        failingSince: now,
        lastFailedAt: later,
      })
      await ctx.endpoints.disable(
        ctx.a.environmentId,
        record.id,
        'gone',
        later,
        Audit.none('fixture')
      )
      const kept = await ctx.endpoints.update(
        ctx.a.environmentId,
        record.id,
        { eventTypes: ['user.deleted'] },
        later,
        Audit.none('fixture')
      )
      expect(comparable(kept)).toMatchObject(
        comparable({
          enabled: false,
          disabledReason: 'gone',
          failingSince: now,
          lastFailedAt: later,
        })
      )
      const reset = await ctx.endpoints.update(
        ctx.a.environmentId,
        record.id,
        { enabled: true, resetHealth: true },
        later,
        Audit.none('fixture')
      )
      expect(comparable(reset)).toMatchObject(
        comparable({
          enabled: true,
          disabledReason: null,
          failingSince: null,
          lastFailedAt: null,
        })
      )
    })

    test('another environment cannot mark an endpoint as failing or switch it off', async () => {
      const record = await registered(ctx.a)
      await ctx.endpoints.setHealth(ctx.b.environmentId, record.id, null, {
        failingSince: later,
        lastFailedAt: later,
      })
      expect(
        await ctx.endpoints.disable(
          ctx.b.environmentId,
          record.id,
          'failing',
          later,
          activity(ctx.b, 'webhook_endpoint.disabled', record.id)
        )
      ).toBe(false)
      expect(await ctx.endpoints.find(ctx.a.environmentId, record.id)).toEqual(record)
      expect(await ctx.recorded()).toEqual([])
    })

    test('another environment cannot see, change or remove an endpoint', async () => {
      const record = endpoint(ctx.a)
      await ctx.endpoints.insert(record, Audit.none('fixture'))
      expect(await ctx.endpoints.find(ctx.b.environmentId, record.id)).toBeNull()
      expect(await ctx.endpoints.list(ctx.b.environmentId)).toEqual([])
      expect(
        await ctx.endpoints.update(
          ctx.b.environmentId,
          record.id,
          { enabled: false, url: 'https://attacker.example.com/' },
          later,
          activity(ctx.b, 'webhook_endpoint.updated', record.id)
        )
      ).toBeNull()
      expect(
        await ctx.endpoints.delete(
          ctx.b.environmentId,
          record.id,
          activity(ctx.b, 'webhook_endpoint.deleted', record.id)
        )
      ).toBe(false)
      expect(await ctx.endpoints.find(ctx.a.environmentId, record.id)).toEqual(record)
      expect(await ctx.recorded()).toEqual([])
    })
  })

  describe(`${name} (WebhookDeliveryStore)`, () => {
    beforeEach(async () => {
      ctx = await setup()
    })

    test('pending events are one environment’s undelivered ones, oldest first, up to the limit', async () => {
      const third = await ctx.seedEvent(ctx.a, seeded(3))
      const first = await ctx.seedEvent(ctx.a, seeded(1))
      const second = await ctx.seedEvent(ctx.a, seeded(2, 'session.created'))
      await ctx.seedEvent(ctx.b, seeded(0))
      const pending = await ctx.deliveries.pendingEvents(ctx.a.environmentId, 10)
      expect(pending.map((event) => event.id)).toEqual([first, second, third])
      expect(pending[1]).toEqual({
        id: second,
        projectId: ctx.a.projectId,
        environmentId: ctx.a.environmentId,
        type: 'session.created',
        payload: { type: 'session.created', schemaVersion: 1 },
        occurredAt: seeded(2).occurredAt,
      })
      const limited = await ctx.deliveries.pendingEvents(ctx.a.environmentId, 2)
      expect(limited.map((event) => event.id)).toEqual([first, second])
    })

    test('a payload is read back as it was stored, whatever its shape', async () => {
      const legacy = { actor: { type: 'system', id: null }, target: null, data: { reason: 'x' } }
      const id = await ctx.seedEvent(ctx.a, { ...seeded(0), payload: legacy })
      const [event] = await ctx.deliveries.pendingEvents(ctx.a.environmentId, 1)
      expect(comparable(event)).toMatchObject(comparable({ id, payload: legacy }))
    })

    test('a marked event no longer waits, keeps its first time, and is counted once', async () => {
      const first = await ctx.seedEvent(ctx.a, seeded(1))
      const second = await ctx.seedEvent(ctx.a, seeded(2))
      expect(await ctx.deliveries.markDelivered(ctx.a.environmentId, [first], now)).toBe(1)
      expect(await ctx.deliveredAt(ctx.a, first)).toEqual(now)
      expect(await ctx.deliveredAt(ctx.a, second)).toBeNull()
      expect(
        (await ctx.deliveries.pendingEvents(ctx.a.environmentId, 10)).map((e) => e.id)
      ).toEqual([second])
      expect(await ctx.deliveries.markDelivered(ctx.a.environmentId, [first, second], later)).toBe(
        1
      )
      expect(await ctx.deliveredAt(ctx.a, first)).toEqual(now)
      expect(await ctx.deliveredAt(ctx.a, second)).toEqual(later)
      expect(await ctx.deliveries.markDelivered(ctx.a.environmentId, [], later)).toBe(0)
    })

    test('settling in bulk marks the events before a cutoff, oldest first, up to the limit', async () => {
      const ids = [
        await ctx.seedEvent(ctx.a, seeded(1)),
        await ctx.seedEvent(ctx.a, seeded(2)),
        await ctx.seedEvent(ctx.a, seeded(3)),
        await ctx.seedEvent(ctx.a, seeded(4)),
      ]
      const cutoff = seeded(4).occurredAt
      expect(await ctx.deliveries.settleBefore(ctx.a.environmentId, cutoff, later, 2)).toBe(2)
      expect(await Promise.all(ids.map((id) => ctx.deliveredAt(ctx.a, id)))).toEqual([
        later,
        later,
        null,
        null,
      ])
      expect(await ctx.deliveries.settleBefore(ctx.a.environmentId, cutoff, later, 10)).toBe(1)
      expect(await ctx.deliveries.settleBefore(ctx.a.environmentId, cutoff, later, 10)).toBe(0)
      // The event at the cutoff itself is not before it: it still waits.
      const waiting = await ctx.deliveries.pendingEvents(ctx.a.environmentId, 10)
      expect(waiting.map((event) => event.id)).toEqual([ids[3] as string])
    })

    test('settling in bulk leaves an already settled event its first time', async () => {
      const first = await ctx.seedEvent(ctx.a, seeded(1))
      await ctx.deliveries.markDelivered(ctx.a.environmentId, [first], now)
      const cutoff = seeded(9).occurredAt
      expect(await ctx.deliveries.settleBefore(ctx.a.environmentId, cutoff, later, 10)).toBe(0)
      expect(await ctx.deliveredAt(ctx.a, first)).toEqual(now)
    })

    test('settling in bulk touches one environment only', async () => {
      const mine = await ctx.seedEvent(ctx.a, seeded(1))
      const theirs = await ctx.seedEvent(ctx.b, seeded(1))
      const cutoff = seeded(9).occurredAt
      expect(await ctx.deliveries.settleBefore(ctx.b.environmentId, cutoff, later, 10)).toBe(1)
      expect(await ctx.deliveredAt(ctx.a, mine)).toBeNull()
      expect(await ctx.deliveredAt(ctx.b, theirs)).toEqual(later)
    })

    test('another environment cannot mark an event delivered', async () => {
      const event = await ctx.seedEvent(ctx.a, seeded(1))
      expect(await ctx.deliveries.markDelivered(ctx.b.environmentId, [event], now)).toBe(0)
      expect(await ctx.deliveredAt(ctx.a, event)).toBeNull()
    })

    test('events are read by id whether or not they are settled, and only in their own environment', async () => {
      const waiting = await ctx.seedEvent(ctx.a, seeded(1))
      const settled = await ctx.seedEvent(ctx.a, seeded(2))
      const theirs = await ctx.seedEvent(ctx.b, seeded(3))
      await ctx.deliveries.markDelivered(ctx.a.environmentId, [settled], now)
      const found = await ctx.deliveries.eventsById(ctx.a.environmentId, [
        waiting,
        settled,
        theirs,
        Bun.randomUUIDv7(),
      ])
      expect(found.map((event) => event.id).sort()).toEqual([waiting, settled].sort())
      expect(await ctx.deliveries.eventsById(ctx.a.environmentId, [])).toEqual([])
      expect(await ctx.deliveries.eventsById(ctx.b.environmentId, [waiting, settled])).toEqual([])
    })

    test('a queued delivery is pending, due at once, and no request has been made for it', async () => {
      const target = await registered(ctx.a)
      const { id, eventId } = await queued(ctx.a, target.id)
      expect(await read(ctx.a, target.id, id)).toEqual({
        delivery: {
          id,
          projectId: ctx.a.projectId,
          environmentId: ctx.a.environmentId,
          endpointId: target.id,
          eventId,
          eventType: 'user.created',
          test: false,
          state: 'pending',
          attempts: 0,
          nextAttemptAt: now,
          lastAttemptAt: null,
          statusCode: null,
          failureReason: null,
          completedAt: null,
          createdAt: now,
        },
        attempts: [],
      })
      expect(
        (await ctx.deliveries.due(ctx.a.environmentId, target.id, now, 10)).map((row) => row.id)
      ).toEqual([id])
    })

    test('a delivery is queued once per endpoint and event; a second one changes nothing', async () => {
      const target = await registered(ctx.a)
      const { id, eventId } = await queued(ctx.a, target.id)
      await ctx.deliveries.recordAttempt(ctx.a.environmentId, id, attempt(), retry, 'pending')
      const again = {
        id: Bun.randomUUIDv7(),
        ...ctx.a,
        endpointId: target.id,
        eventId,
        eventType: 'user.created',
        at: later,
      }
      expect(await ctx.deliveries.enqueue([again])).toBe(0)
      expect(await read(ctx.a, target.id, again.id)).toBeNull()
      // The first row is as the worker left it: not reset to a fresh delivery.
      expect(comparable((await read(ctx.a, target.id, id))?.delivery)).toMatchObject(
        comparable({
          attempts: 1,
          nextAttemptAt: retryAt,
          createdAt: now,
        })
      )
      expect(await ctx.deliveries.enqueue([])).toBe(0)
    })

    test('each endpoint has its own delivery of an event, and each event its own', async () => {
      const one = await registered(ctx.a)
      const two = await registered(ctx.a)
      const first = await ctx.seedEvent(ctx.a, seeded(1))
      const second = await ctx.seedEvent(ctx.a, seeded(2))
      const rows = [one, two].flatMap((target) =>
        [first, second].map((eventId) => ({
          id: Bun.randomUUIDv7(),
          ...ctx.a,
          endpointId: target.id,
          eventId,
          eventType: 'user.created',
          at: now,
        }))
      )
      expect(await ctx.deliveries.enqueue(rows)).toBe(4)
      const listed = await ctx.deliveries.list(ctx.a.environmentId, one.id, {
        page: 1,
        perPage: 10,
        maxCount: 1000,
      })
      expect(listed.totalCount).toBe(2)
      expect(listed.deliveries.map((row) => row.eventId).sort()).toEqual([first, second].sort())
    })

    test('a delivery to an endpoint that is gone is not queued, and the others of the batch are', async () => {
      const target = await registered(ctx.a)
      const eventId = await ctx.seedEvent(ctx.a, seeded(1))
      const row = (endpointId: string) => ({
        id: Bun.randomUUIDv7(),
        ...ctx.a,
        endpointId,
        eventId,
        eventType: 'user.created',
        at: now,
      })
      const kept = row(target.id)
      const lost = row(Bun.randomUUIDv7())
      expect(await ctx.deliveries.enqueue([lost, kept])).toBe(1)
      expect(await read(ctx.a, target.id, kept.id)).not.toBeNull()
      expect(await read(ctx.a, lost.endpointId, lost.id)).toBeNull()
    })

    test('a delivery cannot be queued to another environment’s endpoint', async () => {
      const theirs = await registered(ctx.b)
      const eventId = await ctx.seedEvent(ctx.a, seeded(1))
      const row = {
        id: Bun.randomUUIDv7(),
        ...ctx.a,
        endpointId: theirs.id,
        eventId,
        eventType: 'user.created',
        at: now,
      }
      expect(await ctx.deliveries.enqueue([row])).toBe(0)
      expect(await read(ctx.a, theirs.id, row.id)).toBeNull()
      expect(await read(ctx.b, theirs.id, row.id)).toBeNull()
    })

    test('what is due is one endpoint’s pending deliveries whose time has come, the most overdue first', async () => {
      const target = await registered(ctx.a)
      const other = await registered(ctx.a)
      const early = await queued(ctx.a, target.id, now)
      const middle = await queued(ctx.a, target.id, new Date(now.getTime() + 1_000))
      const future = await queued(ctx.a, target.id, new Date(later.getTime() + 1_000))
      const delivered = await queued(ctx.a, target.id, now)
      await ctx.deliveries.recordAttempt(
        ctx.a.environmentId,
        delivered.id,
        attempt({ statusCode: 204 }),
        done,
        'pending'
      )
      await queued(ctx.a, other.id, now)
      const due = async (at: Date, limit = 10) =>
        (await ctx.deliveries.due(ctx.a.environmentId, target.id, at, limit)).map((row) => row.id)
      expect(await due(later)).toEqual([early.id, middle.id])
      expect(await due(later, 1)).toEqual([early.id])
      // Due at the very instant.
      expect(await due(new Date(later.getTime() + 1_000))).toEqual([early.id, middle.id, future.id])
      expect(await due(new Date(now.getTime() - 1))).toEqual([])
      expect(await ctx.deliveries.due(ctx.b.environmentId, target.id, later, 10)).toEqual([])
    })

    test('a recorded request is counted, logged with its number, and moves the delivery', async () => {
      const target = await registered(ctx.a)
      const { id } = await queued(ctx.a, target.id)
      const first = attempt({ statusCode: null, durationMs: 5_000, failureReason: 'timeout' })
      expect(
        await ctx.deliveries.recordAttempt(ctx.a.environmentId, id, first, retry, 'pending')
      ).toBe(1)
      expect(comparable(await read(ctx.a, target.id, id))).toMatchObject(
        comparable({
          delivery: {
            state: 'pending',
            attempts: 1,
            nextAttemptAt: retryAt,
            lastAttemptAt: later,
            statusCode: null,
            failureReason: 'timeout',
            completedAt: null,
          },
          attempts: [{ ...first, attempt: 1 }],
        })
      )
      const second = attempt({ statusCode: 204, attemptedAt: retryAt })
      expect(
        await ctx.deliveries.recordAttempt(ctx.a.environmentId, id, second, done, 'pending')
      ).toBe(2)
      const found = await read(ctx.a, target.id, id)
      expect(comparable(found?.delivery)).toMatchObject(
        comparable({
          state: 'delivered',
          attempts: 2,
          nextAttemptAt: null,
          lastAttemptAt: retryAt,
          statusCode: 204,
          failureReason: null,
          completedAt: later,
        })
      )
      expect(found?.attempts).toEqual([
        { ...first, attempt: 1 },
        { ...second, attempt: 2 },
      ])
      expect(await ctx.deliveries.due(ctx.a.environmentId, target.id, retryAt, 10)).toEqual([])
    })

    test('requests recorded at the same time each get their own number, and the count is their number', async () => {
      const target = await registered(ctx.a)
      const { id } = await queued(ctx.a, target.id)
      const numbers = await Promise.all(
        Array.from({ length: 5 }, () =>
          ctx.deliveries.recordAttempt(ctx.a.environmentId, id, attempt(), retry, 'pending')
        )
      )
      expect([...numbers].sort()).toEqual([1, 2, 3, 4, 5])
      const found = await read(ctx.a, target.id, id)
      expect(found?.delivery.attempts).toBe(5)
      expect(found?.attempts.map((one) => one.attempt)).toEqual([1, 2, 3, 4, 5])
    })

    test('the worker’s request is recorded only for a delivery that is still pending', async () => {
      const target = await registered(ctx.a)
      const { id } = await queued(ctx.a, target.id)
      await ctx.deliveries.recordAttempt(ctx.a.environmentId, id, attempt(), gaveUp, 'pending')
      const before = await read(ctx.a, target.id, id)
      expect(
        await ctx.deliveries.recordAttempt(ctx.a.environmentId, id, attempt(), retry, 'pending')
      ).toBeNull()
      expect(await read(ctx.a, target.id, id)).toEqual(before)
    })

    test('a request made on demand is recorded only for a delivery that has ended, and may leave its state', async () => {
      const target = await registered(ctx.a)
      const { id } = await queued(ctx.a, target.id)
      expect(
        await ctx.deliveries.recordAttempt(ctx.a.environmentId, id, attempt(), null, 'ended')
      ).toBeNull()
      expect((await read(ctx.a, target.id, id))?.attempts).toEqual([])
      await ctx.deliveries.recordAttempt(ctx.a.environmentId, id, attempt(), gaveUp, 'pending')
      const again = attempt({ statusCode: 503, attemptedAt: retryAt })
      expect(
        await ctx.deliveries.recordAttempt(ctx.a.environmentId, id, again, null, 'ended')
      ).toBe(2)
      expect(comparable((await read(ctx.a, target.id, id))?.delivery)).toMatchObject(
        comparable({
          state: 'failed',
          attempts: 2,
          statusCode: 503,
          lastAttemptAt: retryAt,
          completedAt: later,
          nextAttemptAt: null,
        })
      )
      expect(
        await ctx.deliveries.recordAttempt(
          ctx.a.environmentId,
          id,
          attempt({ statusCode: 200 }),
          done,
          'ended'
        )
      ).toBe(3)
      expect(comparable((await read(ctx.a, target.id, id))?.delivery)).toMatchObject(
        comparable({
          state: 'delivered',
          attempts: 3,
        })
      )
    })

    test('another environment cannot record a request for a delivery, or read it', async () => {
      const target = await registered(ctx.a)
      const { id } = await queued(ctx.a, target.id)
      for (const from of ['pending', 'ended'] as const) {
        expect(
          await ctx.deliveries.recordAttempt(ctx.b.environmentId, id, attempt(), done, from)
        ).toBeNull()
      }
      expect(await read(ctx.b, target.id, id)).toBeNull()
      expect(
        await ctx.deliveries.list(ctx.b.environmentId, target.id, {
          page: 1,
          perPage: 10,
          maxCount: 1000,
        })
      ).toEqual({ deliveries: [], totalCount: 0 })
      expect(comparable((await read(ctx.a, target.id, id))?.delivery)).toMatchObject(
        comparable({
          state: 'pending',
          attempts: 0,
        })
      )
      expect(
        await ctx.deliveries.recordAttempt(
          ctx.a.environmentId,
          Bun.randomUUIDv7(),
          attempt(),
          done,
          'pending'
        )
      ).toBeNull()
    })

    test('a delivery is found only under the endpoint it is of', async () => {
      const target = await registered(ctx.a)
      const other = await registered(ctx.a)
      const { id } = await queued(ctx.a, target.id)
      expect(await read(ctx.a, other.id, id)).toBeNull()
      expect(await read(ctx.a, target.id, Bun.randomUUIDv7())).toBeNull()
    })

    test('putting deliveries off counts no attempt and writes none, and touches only pending ones', async () => {
      const target = await registered(ctx.a)
      const waiting = await queued(ctx.a, target.id)
      const ended = await queued(ctx.a, target.id)
      await ctx.deliveries.recordAttempt(
        ctx.a.environmentId,
        ended.id,
        attempt({ statusCode: 204 }),
        done,
        'pending'
      )
      const ids = [waiting.id, ended.id, Bun.randomUUIDv7()]
      expect(
        await ctx.deliveries.defer(ctx.b.environmentId, ids, 'signing_failed', retryAt, later)
      ).toBe(0)
      expect(
        await ctx.deliveries.defer(
          ctx.a.environmentId,
          ids,
          'endpoint_unresponsive',
          retryAt,
          later
        )
      ).toBe(1)
      expect(comparable(await read(ctx.a, target.id, waiting.id))).toMatchObject(
        comparable({
          delivery: {
            state: 'pending',
            attempts: 0,
            nextAttemptAt: retryAt,
            lastAttemptAt: null,
            statusCode: null,
            failureReason: 'endpoint_unresponsive',
          },
          attempts: [],
        })
      )
      expect(comparable((await read(ctx.a, target.id, ended.id))?.delivery)).toMatchObject(
        comparable({
          state: 'delivered',
          failureReason: null,
        })
      )
      expect(await ctx.deliveries.defer(ctx.a.environmentId, [], 'timeout', retryAt, later)).toBe(0)
    })

    test('giving deliveries up ends pending ones with a word and no attempt', async () => {
      const target = await registered(ctx.a)
      const waiting = await queued(ctx.a, target.id)
      const ended = await queued(ctx.a, target.id)
      await ctx.deliveries.recordAttempt(
        ctx.a.environmentId,
        ended.id,
        attempt({ statusCode: 204 }),
        done,
        'pending'
      )
      const ids = [waiting.id, ended.id]
      expect(await ctx.deliveries.giveUp(ctx.b.environmentId, ids, 'event_gone', later)).toBe(0)
      expect(await ctx.deliveries.giveUp(ctx.a.environmentId, ids, 'event_gone', later)).toBe(1)
      expect(comparable(await read(ctx.a, target.id, waiting.id))).toMatchObject(
        comparable({
          delivery: {
            state: 'failed',
            attempts: 0,
            nextAttemptAt: null,
            failureReason: 'event_gone',
            completedAt: later,
          },
          attempts: [],
        })
      )
      expect((await read(ctx.a, target.id, ended.id))?.delivery.state).toBe('delivered')
      expect(await ctx.deliveries.giveUp(ctx.a.environmentId, [], 'expired', later)).toBe(0)
    })

    test('giving up by age takes pending deliveries queued before a cutoff, oldest first, up to the limit', async () => {
      const target = await registered(ctx.a)
      const minute = (n: number) => new Date(now.getTime() + n * 60_000)
      const first = await queued(ctx.a, target.id, minute(1))
      const second = await queued(ctx.a, target.id, minute(2))
      const third = await queued(ctx.a, target.id, minute(3))
      const atCutoff = await queued(ctx.a, target.id, minute(4))
      const ended = await queued(ctx.a, target.id, minute(0))
      await ctx.deliveries.recordAttempt(
        ctx.a.environmentId,
        ended.id,
        attempt({ statusCode: 204 }),
        done,
        'pending'
      )
      const theirs = await queued(ctx.b, (await registered(ctx.b)).id, minute(1))
      const state = async (tenant: WebhookSuiteTenant, endpointId: string, id: string) =>
        (await read(tenant, endpointId, id))?.delivery.state
      expect(await ctx.deliveries.expire(ctx.a.environmentId, minute(4), later, 2)).toBe(2)
      expect(await state(ctx.a, target.id, first.id)).toBe('failed')
      expect(await state(ctx.a, target.id, second.id)).toBe('failed')
      expect(await state(ctx.a, target.id, third.id)).toBe('pending')
      expect(await ctx.deliveries.expire(ctx.a.environmentId, minute(4), later, 10)).toBe(1)
      expect(await ctx.deliveries.expire(ctx.a.environmentId, minute(4), later, 10)).toBe(0)
      // The one queued at the cutoff itself is not before it; one that ended is not touched.
      expect(await state(ctx.a, target.id, atCutoff.id)).toBe('pending')
      expect(await state(ctx.a, target.id, ended.id)).toBe('delivered')
      expect(comparable((await read(ctx.a, target.id, first.id))?.delivery)).toMatchObject(
        comparable({
          failureReason: 'expired',
          completedAt: later,
          nextAttemptAt: null,
          attempts: 0,
        })
      )
      const theirEndpoint = (await ctx.endpoints.list(ctx.b.environmentId))[0]?.id as string
      expect(await state(ctx.b, theirEndpoint, theirs.id)).toBe('pending')
    })

    test('a test event is recorded with no event, flagged, with the one request made for it', async () => {
      const target = await registered(ctx.a)
      const test: WebhookDeliveryRecord = {
        id: Bun.randomUUIDv7(),
        ...ctx.a,
        endpointId: target.id,
        eventId: null,
        eventType: 'user.banned',
        test: true,
        state: 'failed',
        attempts: 1,
        nextAttemptAt: null,
        lastAttemptAt: later,
        statusCode: 500,
        failureReason: null,
        completedAt: later,
        createdAt: later,
      }
      const made = attempt()
      expect(await ctx.deliveries.recordTest(test, made)).toBe(true)
      expect(await read(ctx.a, target.id, test.id)).toEqual({
        delivery: test,
        attempts: [{ ...made, attempt: 1 }],
      })
      // Never the worker's: it was never pending.
      expect(await ctx.deliveries.due(ctx.a.environmentId, target.id, retryAt, 10)).toEqual([])
      // Any number of tests: there is no event to be unique with.
      const unsent = {
        ...test,
        id: Bun.randomUUIDv7(),
        attempts: 0,
        lastAttemptAt: null,
        statusCode: null,
        failureReason: 'signing_failed' as const,
      }
      expect(await ctx.deliveries.recordTest(unsent, null)).toBe(true)
      expect(await read(ctx.a, target.id, unsent.id)).toEqual({ delivery: unsent, attempts: [] })
    })

    test('a test of an endpoint that is gone, or is another environment’s, records nothing', async () => {
      const theirs = await registered(ctx.b)
      for (const endpointId of [Bun.randomUUIDv7(), theirs.id]) {
        const test: WebhookDeliveryRecord = {
          id: Bun.randomUUIDv7(),
          ...ctx.a,
          endpointId,
          eventId: null,
          eventType: 'user.banned',
          test: true,
          state: 'delivered',
          attempts: 1,
          nextAttemptAt: null,
          lastAttemptAt: later,
          statusCode: 204,
          failureReason: null,
          completedAt: later,
          createdAt: later,
        }
        expect(await ctx.deliveries.recordTest(test, attempt({ statusCode: 204 }))).toBe(false)
        expect(await read(ctx.a, endpointId, test.id)).toBeNull()
        expect(await read(ctx.b, endpointId, test.id)).toBeNull()
      }
    })

    test('an endpoint’s deliveries are listed newest first, by page, state and event type', async () => {
      const target = await registered(ctx.a)
      const other = await registered(ctx.a)
      const minute = (n: number) => new Date(now.getTime() + n * 60_000)
      const oldest = await queued(ctx.a, target.id, minute(1))
      const middle = await queued(ctx.a, target.id, minute(2), 'session.created')
      const newest = await queued(ctx.a, target.id, minute(3))
      await queued(ctx.a, other.id, minute(4))
      await ctx.deliveries.recordAttempt(
        ctx.a.environmentId,
        oldest.id,
        attempt({ statusCode: 204 }),
        done,
        'pending'
      )
      const list = async (query: Parameters<WebhookDeliveryStore['list']>[2]) => {
        const page = await ctx.deliveries.list(ctx.a.environmentId, target.id, query)
        return { ids: page.deliveries.map((row) => row.id), totalCount: page.totalCount }
      }
      expect(await list({ page: 1, perPage: 10, maxCount: 1000 })).toEqual({
        ids: [newest.id, middle.id, oldest.id],
        totalCount: 3,
      })
      expect(await list({ page: 1, perPage: 2, maxCount: 1000 })).toEqual({
        ids: [newest.id, middle.id],
        totalCount: 3,
      })
      expect(await list({ page: 2, perPage: 2, maxCount: 1000 })).toEqual({
        ids: [oldest.id],
        totalCount: 3,
      })
      expect(await list({ page: 3, perPage: 2, maxCount: 1000 })).toEqual({
        ids: [],
        totalCount: 3,
      })
      expect(await list({ state: 'pending', page: 1, perPage: 10, maxCount: 1000 })).toEqual({
        ids: [newest.id, middle.id],
        totalCount: 2,
      })
      expect(await list({ state: 'delivered', page: 1, perPage: 10, maxCount: 1000 })).toEqual({
        ids: [oldest.id],
        totalCount: 1,
      })
      expect(
        await list({ eventType: 'session.created', page: 1, perPage: 10, maxCount: 1000 })
      ).toEqual({
        ids: [middle.id],
        totalCount: 1,
      })
      expect(
        await list({
          state: 'failed',
          eventType: 'user.created',
          page: 1,
          perPage: 10,
          maxCount: 1000,
        })
      ).toEqual({ ids: [], totalCount: 0 })
    })

    test('the count of a list stops at the ceiling it is given, and the page is unaffected by it', async () => {
      const target = await registered(ctx.a)
      const minute = (n: number) => new Date(now.getTime() + n * 60_000)
      const ids: string[] = []
      for (let n = 1; n <= 5; n++) {
        ids.push((await queued(ctx.a, target.id, minute(n))).id)
      }
      const page = await ctx.deliveries.list(ctx.a.environmentId, target.id, {
        page: 1,
        perPage: 2,
        maxCount: 3,
      })
      expect(page.totalCount).toBe(3)
      expect(page.deliveries.map((row) => row.id)).toEqual([ids[4] as string, ids[3] as string])
      const all = await ctx.deliveries.list(ctx.a.environmentId, target.id, {
        page: 1,
        perPage: 2,
        maxCount: 5,
      })
      expect(all.totalCount).toBe(5)
      const more = await ctx.deliveries.list(ctx.a.environmentId, target.id, {
        state: 'pending',
        page: 1,
        perPage: 2,
        maxCount: 50,
      })
      expect(more.totalCount).toBe(5)
    })

    test('how long an endpoint has been failing and when it last failed are kept together, and cleared together', async () => {
      const record = await registered(ctx.a)
      const first = new Date('2026-01-03T00:00:00.000Z')
      const second = new Date('2026-01-04T00:00:00.000Z')
      await ctx.endpoints.setHealth(ctx.a.environmentId, record.id, null, {
        failingSince: first,
        lastFailedAt: second,
      })
      // No administrator changed it: `updatedAt` has not moved.
      expect(await ctx.endpoints.find(ctx.a.environmentId, record.id)).toEqual({
        ...record,
        failingSince: first,
        lastFailedAt: second,
      })
      await ctx.endpoints.setHealth(ctx.b.environmentId, record.id, null, {
        failingSince: null,
        lastFailedAt: null,
      })
      expect((await ctx.endpoints.find(ctx.a.environmentId, record.id))?.failingSince).toEqual(
        first
      )
      await ctx.endpoints.setHealth(ctx.a.environmentId, record.id, null, {
        failingSince: null,
        lastFailedAt: null,
      })
      expect(await ctx.endpoints.find(ctx.a.environmentId, record.id)).toEqual(record)
      await ctx.endpoints.setHealth(ctx.a.environmentId, Bun.randomUUIDv7(), null, {
        failingSince: first,
        lastFailedAt: first,
      })
      expect(await ctx.recorded()).toEqual([])
    })

    test('settled events are deleted before a cutoff, oldest first, up to the limit; waiting ones never', async () => {
      const day = (n: number) => new Date(now.getTime() + n * 86_400_000)
      const first = await ctx.seedEvent(ctx.a, seeded(1))
      const second = await ctx.seedEvent(ctx.a, seeded(2))
      const third = await ctx.seedEvent(ctx.a, seeded(3))
      const atCutoff = await ctx.seedEvent(ctx.a, seeded(4))
      const waiting = await ctx.seedEvent(ctx.a, seeded(0))
      const theirs = await ctx.seedEvent(ctx.b, seeded(1))
      await ctx.deliveries.markDelivered(ctx.a.environmentId, [first], day(1))
      await ctx.deliveries.markDelivered(ctx.a.environmentId, [second], day(2))
      await ctx.deliveries.markDelivered(ctx.a.environmentId, [third], day(3))
      await ctx.deliveries.markDelivered(ctx.a.environmentId, [atCutoff], day(4))
      await ctx.deliveries.markDelivered(ctx.b.environmentId, [theirs], day(1))
      const left = async () =>
        Promise.all(
          [first, second, third, atCutoff, waiting].map((id) => ctx.eventExists(ctx.a, id))
        )
      expect(await ctx.deliveries.deleteSettledEvents(ctx.a.environmentId, day(4), 2)).toBe(2)
      expect(await left()).toEqual([false, false, true, true, true])
      expect(await ctx.deliveries.deleteSettledEvents(ctx.a.environmentId, day(4), 10)).toBe(1)
      expect(await ctx.deliveries.deleteSettledEvents(ctx.a.environmentId, day(4), 10)).toBe(0)
      // The one settled at the cutoff itself is not before it; one that waits is never deleted.
      expect(await left()).toEqual([false, false, false, true, true])
      expect(await ctx.eventExists(ctx.b, theirs)).toBe(true)
    })

    test('an event is kept while a delivery of it is pending, and its ended deliveries outlive it', async () => {
      const target = await registered(ctx.a)
      const cutoff = new Date(later.getTime() + 86_400_000)
      const stillSending = await queued(ctx.a, target.id)
      const finished = await queued(ctx.a, target.id)
      await ctx.deliveries.recordAttempt(
        ctx.a.environmentId,
        finished.id,
        attempt({ statusCode: 204 }),
        done,
        'pending'
      )
      await ctx.deliveries.markDelivered(
        ctx.a.environmentId,
        [stillSending.eventId, finished.eventId],
        later
      )
      expect(await ctx.deliveries.deleteSettledEvents(ctx.a.environmentId, cutoff, 10)).toBe(1)
      expect(await ctx.eventExists(ctx.a, stillSending.eventId)).toBe(true)
      expect(await ctx.eventExists(ctx.a, finished.eventId)).toBe(false)
      // The record of the delivery, and of its request, is still there without its event.
      expect(comparable(await read(ctx.a, target.id, finished.id))).toMatchObject(
        comparable({
          delivery: { eventId: finished.eventId, state: 'delivered' },
          attempts: [{ attempt: 1, statusCode: 204 }],
        })
      )
      // Once that delivery has ended too, its event goes.
      await ctx.deliveries.giveUp(ctx.a.environmentId, [stillSending.id], 'expired', later)
      expect(await ctx.deliveries.deleteSettledEvents(ctx.a.environmentId, cutoff, 10)).toBe(1)
      expect(await ctx.eventExists(ctx.a, stillSending.eventId)).toBe(false)
    })

    test('ended deliveries are deleted before a cutoff with their attempts, oldest first; pending ones never', async () => {
      const target = await registered(ctx.a)
      const minute = (n: number) => new Date(now.getTime() + n * 60_000)
      const end = (id: string) =>
        ctx.deliveries.recordAttempt(ctx.a.environmentId, id, attempt(), gaveUp, 'pending')
      const first = await queued(ctx.a, target.id, minute(1))
      const second = await queued(ctx.a, target.id, minute(2))
      const third = await queued(ctx.a, target.id, minute(3))
      const atCutoff = await queued(ctx.a, target.id, minute(4))
      const pending = await queued(ctx.a, target.id, minute(0))
      for (const { id } of [first, second, third, atCutoff]) {
        await end(id)
      }
      const theirEndpoint = await registered(ctx.b)
      const theirs = await queued(ctx.b, theirEndpoint.id, minute(1))
      await ctx.deliveries.giveUp(ctx.b.environmentId, [theirs.id], 'expired', later)
      const left = async () =>
        Promise.all(
          [first, second, third, atCutoff, pending].map(
            async ({ id }) => (await read(ctx.a, target.id, id)) !== null
          )
        )
      expect(await ctx.deliveries.deleteEndedBefore(ctx.a.environmentId, minute(4), 2)).toBe(2)
      expect(await left()).toEqual([false, false, true, true, true])
      expect(await ctx.deliveries.deleteEndedBefore(ctx.a.environmentId, minute(4), 10)).toBe(1)
      expect(await ctx.deliveries.deleteEndedBefore(ctx.a.environmentId, minute(4), 10)).toBe(0)
      expect(await left()).toEqual([false, false, false, true, true])
      expect(await read(ctx.b, theirEndpoint.id, theirs.id)).not.toBeNull()
      // The events are not this purge's to delete.
      expect(await ctx.eventExists(ctx.a, first.eventId)).toBe(true)
    })

    test('removing an endpoint removes the record of its deliveries and their attempts, and only its own', async () => {
      const doomed = await registered(ctx.a)
      const kept = await registered(ctx.a)
      const gone = await queued(ctx.a, doomed.id)
      const stays = await queued(ctx.a, kept.id)
      await ctx.deliveries.recordAttempt(ctx.a.environmentId, gone.id, attempt(), retry, 'pending')
      await ctx.deliveries.recordAttempt(ctx.a.environmentId, stays.id, attempt(), retry, 'pending')
      await ctx.endpoints.delete(ctx.a.environmentId, doomed.id, Audit.none('fixture'))
      expect(await read(ctx.a, doomed.id, gone.id)).toBeNull()
      expect(await ctx.deliveries.due(ctx.a.environmentId, doomed.id, retryAt, 10)).toEqual([])
      expect(
        await ctx.deliveries.recordAttempt(ctx.a.environmentId, gone.id, attempt(), done, 'pending')
      ).toBeNull()
      expect((await read(ctx.a, kept.id, stays.id))?.attempts).toHaveLength(1)
      // The event outlives the endpoint.
      expect(await ctx.eventExists(ctx.a, gone.eventId)).toBe(true)
    })
  })
}
