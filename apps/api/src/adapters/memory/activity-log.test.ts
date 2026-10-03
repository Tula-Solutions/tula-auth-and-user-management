import { expect, test } from 'bun:test'
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
