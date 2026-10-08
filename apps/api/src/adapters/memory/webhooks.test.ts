import { expect, test } from 'bun:test'
import { MemoryActivityLog } from '~/adapters/memory/activity-log'
import { MemoryWebhookDeliveryStore } from '~/adapters/memory/webhook-deliveries'
import { MemoryWebhookEndpointStore } from '~/adapters/memory/webhook-endpoints'
import { describeWebhookStores } from '~/adapters/webhook-store.suite'
import * as Audit from '~/modules/audit/service'

const tenant = (environmentId: string) => ({
  projectId: '00000000-0000-7000-8000-00000000a001',
  environmentId,
})

describeWebhookStores('Memory', async () => {
  const log = new MemoryActivityLog()
  const endpoints = new MemoryWebhookEndpointStore(log)
  const a = tenant('00000000-0000-7000-8000-00000000e001')
  return {
    endpoints,
    deliveries: new MemoryWebhookDeliveryStore(log, endpoints),
    recorded: async () =>
      log.entries
        .filter((entry) => entry.environmentId === a.environmentId)
        .map((entry) => entry.type),
    seedEvent: async (owner, event) => {
      const id = Bun.randomUUIDv7()
      log.outbox.push({ id, ...owner, ...event, deliveredAt: null })
      return id
    },
    deliveredAt: async (_owner, eventId) =>
      log.outbox.find((row) => row.id === eventId)?.deliveredAt ?? null,
    eventExists: async (owner, eventId) =>
      log.outbox.some((row) => row.id === eventId && row.environmentId === owner.environmentId),
    a,
    b: tenant('00000000-0000-7000-8000-00000000e002'),
  }
})

test('the memory stores work without being handed a shared log', async () => {
  const endpoints = new MemoryWebhookEndpointStore()
  const deliveries = new MemoryWebhookDeliveryStore()
  expect(await endpoints.list('00000000-0000-7000-8000-00000000e001')).toEqual([])
  expect(await deliveries.pendingEvents('00000000-0000-7000-8000-00000000e001', 5)).toEqual([])
})

test('an endpoint id is stored once', async () => {
  const endpoints = new MemoryWebhookEndpointStore()
  const record = {
    id: Bun.randomUUIDv7(),
    ...tenant('00000000-0000-7000-8000-00000000e001'),
    url: 'https://hooks.example.com/',
    eventTypes: ['user.created'],
    secret: 'v1.sealed',
    enabled: true,
    disabledReason: null,
    failingSince: null,
    lastFailedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  }
  await endpoints.insert(record, Audit.none('fixture'))
  expect(endpoints.insert(record, Audit.none('fixture'))).rejects.toThrow('unique constraint')
})

test('every recorded activity becomes an outbox row that waits', async () => {
  const log = new MemoryActivityLog()
  const occurredAt = new Date('2026-03-01T00:00:00.000Z')
  log.record([
    {
      id: '0199c2f5-0000-7000-8000-000000000001',
      ...tenant('00000000-0000-7000-8000-00000000e001'),
      type: 'user.deleted',
      actor: { type: 'system', id: null },
      target: { type: 'user', id: '0199c2f4-7a10-7c3e-9b1a-5d2e8f4a6c01' },
      ipAddress: '203.0.113.9',
      userAgent: 'agent',
      data: {},
      occurredAt,
    },
  ])
  expect(log.outbox).toEqual([
    {
      id: '0199c2f5-0000-7000-8000-000000000001',
      ...tenant('00000000-0000-7000-8000-00000000e001'),
      type: 'user.deleted',
      payload: log.events[0] as never,
      occurredAt,
      deliveredAt: null,
    },
  ])
})
