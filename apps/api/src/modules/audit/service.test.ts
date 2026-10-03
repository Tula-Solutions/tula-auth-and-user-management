import { beforeEach, describe, expect, test } from 'bun:test'
import { MAX_USER_AGENT_LENGTH } from '~/lib/actor'
import * as Audit from '~/modules/audit/service'
import { createTestDeps, TEST_ACTOR, TEST_TENANT, type TestDeps } from '~/testing'

const scope: { projectId: string; environmentId: string } = {
  projectId: TEST_TENANT.projectId,
  environmentId: TEST_TENANT.environmentId,
}
const other = { ...scope, environmentId: TEST_TENANT.productionEnvironmentId }
const USER = '00000000-0000-7000-8000-0000000000a1'
let deps: TestDeps

beforeEach(() => {
  deps = createTestDeps()
})

describe('entry', () => {
  test('builds a record in the scope, with a new id and the current time', () => {
    const entry = Audit.entry(deps, scope, {
      type: 'user.banned',
      actor: TEST_ACTOR,
      target: { type: 'user', id: USER },
    })
    expect(entry).toEqual({
      id: '00000000-0000-7000-8000-000000000001',
      ...scope,
      type: 'user.banned',
      actor: { type: 'admin', id: TEST_ACTOR.id },
      target: { type: 'user', id: USER },
      ipAddress: TEST_ACTOR.ipAddress,
      userAgent: TEST_ACTOR.userAgent,
      data: {},
      occurredAt: deps.clock.now(),
    })
  })

  // An invalid address in an `inet` column would fail the insert and undo the real change.
  test.each([
    ['unknown', null],
    ['', null],
    ['203.0.113.7, 10.0.0.1', null],
    ['203.0.113.7', '203.0.113.7'],
    ['2001:db8::1', '2001:db8::1'],
  ] as [string, string | null][])('stores the IP %p as %p', (ipAddress, expected) => {
    const entry = Audit.entry(deps, scope, {
      type: 'user.banned',
      actor: { ...TEST_ACTOR, ipAddress },
      target: { type: 'user', id: USER },
    })
    expect(entry.ipAddress).toBe(expected)
  })

  test('caps the user agent and keeps only the actor’s type and id', () => {
    const entry = Audit.entry(deps, scope, {
      type: 'session.created',
      actor: { ...TEST_ACTOR, userAgent: 'x'.repeat(5_000), client: 'web' } as typeof TEST_ACTOR,
      target: { type: 'session', id: USER },
      data: { client: 'web' },
    })
    expect(entry.userAgent).toHaveLength(MAX_USER_AGENT_LENGTH)
    expect(entry.actor).toEqual({ type: 'admin', id: TEST_ACTOR.id })
    expect(entry.data).toEqual({ client: 'web' })
  })
})

describe('list', () => {
  function record(type: 'user.banned' | 'user.unbanned', target = USER, tenant = scope) {
    deps.clock.advance(1_000)
    const entry = Audit.entry(deps, tenant, {
      type,
      actor: TEST_ACTOR,
      target: { type: 'user', id: target },
      data: { n: 1 },
    })
    deps.activityLog.record([entry])
    return entry
  }

  test('returns the contract shape, newest first, with paging details', async () => {
    const first = record('user.banned')
    const second = record('user.unbanned')
    expect(await Audit.list(deps, scope, {})).toEqual({
      meta: { totalCount: 2, totalPages: 1, page: 1, perPage: 20 },
      data: [
        {
          id: second.id,
          action: 'user.unbanned',
          actor: { type: 'admin', id: TEST_ACTOR.id },
          target: { type: 'user', id: USER },
          ipAddress: TEST_ACTOR.ipAddress,
          userAgent: TEST_ACTOR.userAgent,
          metadata: { n: 1 },
          occurredAt: second.occurredAt.toISOString(),
        },
        expect.objectContaining({ id: first.id, action: 'user.banned' }),
      ],
    })
  })

  test('pages and filters', async () => {
    const entries = [record('user.banned'), record('user.unbanned'), record('user.banned')]
    const elsewhere = record('user.banned', '00000000-0000-7000-8000-0000000000a2')
    const page = await Audit.list(deps, scope, { page: 2, size: 3 })
    expect(page.meta).toEqual({ totalCount: 4, totalPages: 2, page: 2, perPage: 3 })
    expect(page.data.map((entry) => entry.id)).toEqual([entries[0]?.id ?? ''])
    const banned = await Audit.list(deps, scope, { action: 'user.banned', targetId: USER })
    expect(banned.data.map((entry) => entry.id)).toEqual([
      entries[2]?.id,
      entries[0]?.id,
    ] as string[])
    const byActor = await Audit.list(deps, scope, { actorId: TEST_ACTOR.id ?? '' })
    expect(byActor.meta.totalCount).toBe(4)
    expect((await Audit.list(deps, scope, { actorId: USER })).data).toEqual([])
    expect(
      (await Audit.list(deps, scope, { targetId: elsewhere.target.id })).data.map((e) => e.id)
    ).toEqual([elsewhere.id])
  })

  test('an empty log has no pages, and another environment’s entries are invisible', async () => {
    record('user.banned', USER, other)
    expect(await Audit.list(deps, scope, {})).toEqual({
      meta: { totalCount: 0, totalPages: 0, page: 1, perPage: 20 },
      data: [],
    })
    expect((await Audit.list(deps, other, {})).meta.totalCount).toBe(1)
  })
})
