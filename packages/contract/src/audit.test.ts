import { describe, expect, test } from 'bun:test'
import { ACTIVITY_TYPES, ActivityTypeSchema, AuditLogListSchema, AuditLogSchema } from './audit'

const entry = {
  id: 'a_1',
  action: 'user.banned',
  actor: { type: 'admin', id: 'key_1' },
  target: { type: 'user', id: 'u_1' },
  ipAddress: '203.0.113.7',
  userAgent: 'acme-backend/2.1',
  metadata: { reason: 'abuse' },
  occurredAt: '2026-01-01T00:00:00.000Z',
}

describe('AuditLog', () => {
  test('accepts an entry and strips anything that is not part of the contract', () => {
    const parsed = AuditLogSchema.parse({ ...entry, projectId: 'p_1' })
    expect(parsed).toEqual(entry as never)
    expect(parsed).not.toHaveProperty('projectId')
  })

  test('accepts a system action with no actor id, origin or target', () => {
    const system = {
      ...entry,
      actor: { type: 'system', id: null },
      target: null,
      ipAddress: null,
      userAgent: null,
      metadata: {},
    }
    expect(AuditLogSchema.parse(system)).toEqual(system as never)
  })

  test('accepts an action, target or kind of actor this version does not know', () => {
    for (const change of [
      { action: 'organization.created' },
      { target: { type: 'organization', id: 'o_1' } },
      { actor: { type: 'service_account', id: 'sa_1' } },
    ]) {
      expect(AuditLogSchema.safeParse({ ...entry, ...change }).success).toBe(true)
    }
  })

  test('a list carries paging details', () => {
    const list = AuditLogListSchema.parse({
      meta: { totalCount: 1, totalPages: 1, page: 1, perPage: 20 },
      data: [entry],
    })
    expect(list.data).toHaveLength(1)
  })
})

describe('ActivityType', () => {
  test('every type is `area.reason`, unique, and accepted by the schema', () => {
    expect(new Set(ACTIVITY_TYPES).size).toBe(ACTIVITY_TYPES.length)
    for (const type of ACTIVITY_TYPES) {
      expect(type).toMatch(/^[a-z_]+\.[a-z_]+$/)
      expect(ActivityTypeSchema.parse(type)).toBe(type)
    }
    expect(ActivityTypeSchema.safeParse('user.exploded').success).toBe(false)
  })
})
