import { expect, test } from 'bun:test'
import { EVENT_SCHEMA_VERSION, EVENT_SCHEMAS } from '@tula/contract'
import { describeActivityLog } from '~/adapters/activity-log.suite'
import { MemoryActivityLog } from '~/adapters/memory/activity-log'
import { MemoryApiKeyRepository } from '~/adapters/memory/api-keys'
import { MemorySessionStore } from '~/adapters/memory/sessions'
import { MemorySigningKeyStore } from '~/adapters/memory/signing-keys'
import { MemoryUserRepository } from '~/adapters/memory/users'
import type { Activity } from '~/ports/activity-log'

const tenant = (environmentId: string = Bun.randomUUIDv7()) => ({
  projectId: '00000000-0000-7000-8000-00000000a001',
  environmentId,
})

describeActivityLog('memory stores', async () => {
  const log = new MemoryActivityLog()
  return {
    log,
    sessions: new MemorySessionStore(log),
    users: new MemoryUserRepository(log),
    apiKeys: new MemoryApiKeyRepository(log),
    signingKeys: new MemorySigningKeyStore(log),
    a: tenant('00000000-0000-7000-8000-00000000e001'),
    b: tenant('00000000-0000-7000-8000-00000000e002'),
    freshTenant: async () => tenant(),
  }
})

test('MemoryActivityLog keeps its own copies, so later mutation cannot rewrite history', async () => {
  const log = new MemoryActivityLog()
  const entry: Activity = {
    id: Bun.randomUUIDv7(),
    ...tenant('00000000-0000-7000-8000-00000000e001'),
    type: 'user.banned',
    actor: { type: 'system', id: null },
    target: { type: 'user', id: 'u1' },
    ipAddress: null,
    userAgent: null,
    data: { reason: 'original' },
    occurredAt: new Date(0),
  }
  log.record([entry])
  entry.data.reason = 'tampered'
  const [read] = log.ofType('user.banned')
  expect(read?.data).toEqual({ reason: 'original' })
  const listed = await log.listAudit(entry.environmentId, { page: 1, size: 10 })
  ;(listed.entries[0] as Activity).data.reason = 'tampered'
  expect(log.entries[0]?.data).toEqual({ reason: 'original' })
  expect(log.ofType('user.deleted')).toEqual([])
})

test('MemoryActivityLog keeps the outbox the Postgres stores write: the typed event, not the activity', () => {
  const log = new MemoryActivityLog()
  const entry: Activity = {
    id: '00000000-0000-7000-8000-0000000000e1',
    ...tenant('00000000-0000-7000-8000-00000000e001'),
    type: 'session.created',
    actor: { type: 'user', id: '00000000-0000-7000-8000-0000000000a1' },
    target: { type: 'session', id: '00000000-0000-7000-8000-0000000000b1' },
    ipAddress: '203.0.113.7',
    userAgent: 'suite/1.0',
    data: { userId: '00000000-0000-7000-8000-0000000000a1', client: 'web', note: 'audit only' },
    occurredAt: new Date('2026-01-01T00:00:00.000Z'),
  }
  log.record([entry])
  const payload = {
    id: entry.id,
    type: 'session.created',
    schemaVersion: EVENT_SCHEMA_VERSION,
    occurredAt: '2026-01-01T00:00:00.000Z',
    actor: entry.actor,
    target: entry.target,
    data: { userId: entry.actor.id, client: 'web' },
  }
  expect(log.events).toEqual([payload as never])
  expect(EVENT_SCHEMAS['session.created'].parse(log.events[0])).toEqual(payload as never)
  // The audit entry keeps what it was given.
  expect(log.entries[0]?.data).toEqual(entry.data)
})

test('a purge removes audit entries only: their outbox events stay, as in Postgres', async () => {
  const log = new MemoryActivityLog()
  const old: Activity = {
    id: Bun.randomUUIDv7(),
    ...tenant('00000000-0000-7000-8000-00000000e001'),
    type: 'user.banned',
    actor: { type: 'system', id: null },
    target: { type: 'user', id: '00000000-0000-7000-8000-0000000000a1' },
    ipAddress: null,
    userAgent: null,
    data: {},
    occurredAt: new Date('2000-06-01T00:00:00.000Z'),
  }
  log.record([old])
  expect(await log.deleteAuditBefore(old.environmentId, new Date('2001-01-01'), 100)).toBe(1)
  expect(log.entries).toEqual([])
  expect(log.events.map((event) => event.id)).toEqual([old.id])
})
