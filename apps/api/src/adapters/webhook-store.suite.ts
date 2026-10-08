import { beforeEach, describe, expect, test } from 'bun:test'
import * as Audit from '~/modules/audit/service'
import type { Activity } from '~/ports/activity-log'
import type { WebhookDeliveryRecord, WebhookDeliveryStore } from '~/ports/webhook-delivery-store'
import type { WebhookEndpointRecord, WebhookEndpointStore } from '~/ports/webhook-endpoint-store'

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
      createdAt: now,
      updatedAt: now,
      ...overrides,
    }
  }

  function activity(
    tenant: WebhookSuiteTenant,
    type: 'webhook_endpoint.created' | 'webhook_endpoint.updated' | 'webhook_endpoint.deleted',
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
      data: type === 'webhook_endpoint.updated' ? { changed: ['enabled'] } : {},
      occurredAt: now,
    }
  }

  function delivery(
    tenant: WebhookSuiteTenant,
    endpointId: string,
    eventId: string,
    overrides: Partial<WebhookDeliveryRecord> = {}
  ): WebhookDeliveryRecord {
    return {
      id: Bun.randomUUIDv7(),
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      endpointId,
      eventId,
      attemptedAt: now,
      outcome: 'delivered',
      statusCode: 204,
      durationMs: 12,
      failureReason: null,
      ...overrides,
    }
  }

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
      expect(updated).toMatchObject({ id: record.id, secret: record.secret, createdAt: now })
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
      expect(event).toMatchObject({ id, payload: legacy })
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

    test('another environment cannot mark an event delivered', async () => {
      const event = await ctx.seedEvent(ctx.a, seeded(1))
      expect(await ctx.deliveries.markDelivered(ctx.b.environmentId, [event], now)).toBe(0)
      expect(await ctx.deliveredAt(ctx.a, event)).toBeNull()
    })

    test('a delivery is recorded once per endpoint and event; a second one changes nothing', async () => {
      const target = endpoint(ctx.a)
      await ctx.endpoints.insert(target, Audit.none('fixture'))
      const event = await ctx.seedEvent(ctx.a, seeded(1))
      const first = delivery(ctx.a, target.id, event, {
        outcome: 'failed',
        statusCode: null,
        durationMs: 5000,
        failureReason: 'timeout',
      })
      expect(await ctx.deliveries.insert(first)).toBe('recorded')
      expect(await ctx.deliveries.insert(delivery(ctx.a, target.id, event))).toBe('duplicate')
      expect(await ctx.deliveries.listForEvents(ctx.a.environmentId, [event])).toEqual([first])
    })

    test('each endpoint has its own delivery of an event, and each event its own', async () => {
      const one = endpoint(ctx.a)
      const two = endpoint(ctx.a, { url: 'https://two.example.com/' })
      await ctx.endpoints.insert(one, Audit.none('fixture'))
      await ctx.endpoints.insert(two, Audit.none('fixture'))
      const first = await ctx.seedEvent(ctx.a, seeded(1))
      const second = await ctx.seedEvent(ctx.a, seeded(2))
      for (const [endpointId, eventId] of [
        [one.id, first],
        [two.id, first],
        [one.id, second],
      ] as const) {
        expect(await ctx.deliveries.insert(delivery(ctx.a, endpointId, eventId))).toBe('recorded')
      }
      const rows = await ctx.deliveries.listForEvents(ctx.a.environmentId, [first, second])
      expect(rows.map((row) => `${row.endpointId}:${row.eventId}`).sort()).toEqual(
        [`${one.id}:${first}`, `${two.id}:${first}`, `${one.id}:${second}`].sort()
      )
      expect(await ctx.deliveries.listForEvents(ctx.a.environmentId, [second])).toHaveLength(1)
      expect(await ctx.deliveries.listForEvents(ctx.a.environmentId, [])).toEqual([])
    })

    test('a delivery of an endpoint or an event that does not exist is not recorded', async () => {
      const target = endpoint(ctx.a)
      await ctx.endpoints.insert(target, Audit.none('fixture'))
      const event = await ctx.seedEvent(ctx.a, seeded(1))
      expect(await ctx.deliveries.insert(delivery(ctx.a, Bun.randomUUIDv7(), event))).toBe('gone')
      expect(await ctx.deliveries.insert(delivery(ctx.a, target.id, Bun.randomUUIDv7()))).toBe(
        'gone'
      )
      expect(await ctx.deliveries.listForEvents(ctx.a.environmentId, [event])).toEqual([])
    })

    test('a delivery cannot join one environment’s endpoint to another’s event', async () => {
      const mine = endpoint(ctx.a)
      const theirs = endpoint(ctx.b)
      await ctx.endpoints.insert(mine, Audit.none('fixture'))
      await ctx.endpoints.insert(theirs, Audit.none('fixture'))
      const myEvent = await ctx.seedEvent(ctx.a, seeded(1))
      const theirEvent = await ctx.seedEvent(ctx.b, seeded(1))
      expect(await ctx.deliveries.insert(delivery(ctx.a, theirs.id, myEvent))).toBe('gone')
      expect(await ctx.deliveries.insert(delivery(ctx.a, mine.id, theirEvent))).toBe('gone')
      expect(
        await ctx.deliveries.listForEvents(ctx.a.environmentId, [myEvent, theirEvent])
      ).toEqual([])
    })

    test('another environment does not see a delivery', async () => {
      const target = endpoint(ctx.a)
      await ctx.endpoints.insert(target, Audit.none('fixture'))
      const event = await ctx.seedEvent(ctx.a, seeded(1))
      await ctx.deliveries.insert(delivery(ctx.a, target.id, event))
      expect(await ctx.deliveries.listForEvents(ctx.b.environmentId, [event])).toEqual([])
      expect(await ctx.deliveries.pendingEvents(ctx.b.environmentId, 10)).toEqual([])
    })

    test('removing an endpoint removes the record of its deliveries, and only its own', async () => {
      const doomed = endpoint(ctx.a)
      const kept = endpoint(ctx.a, { url: 'https://kept.example.com/' })
      await ctx.endpoints.insert(doomed, Audit.none('fixture'))
      await ctx.endpoints.insert(kept, Audit.none('fixture'))
      const event = await ctx.seedEvent(ctx.a, seeded(1))
      await ctx.deliveries.insert(delivery(ctx.a, doomed.id, event))
      await ctx.deliveries.insert(delivery(ctx.a, kept.id, event))
      await ctx.endpoints.delete(ctx.a.environmentId, doomed.id, Audit.none('fixture'))
      const rows = await ctx.deliveries.listForEvents(ctx.a.environmentId, [event])
      expect(rows.map((row) => row.endpointId)).toEqual([kept.id])
      // The event itself is untouched: it still waits.
      expect(
        (await ctx.deliveries.pendingEvents(ctx.a.environmentId, 10)).map((e) => e.id)
      ).toEqual([event])
    })
  })
}
