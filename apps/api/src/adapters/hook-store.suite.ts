import { beforeEach, describe, expect, test } from 'bun:test'
import * as Audit from '~/modules/audit/service'
import type { Activity } from '~/ports/activity-log'
import type { HookRecord, HookStore } from '~/ports/hook-store'

/** A tenant for the suite. */
export interface HookSuiteTenant {
  projectId: string
  environmentId: string
}

/** What the store under test provides. */
export interface HookSuiteContext {
  store: HookStore
  /** The audit actions recorded so far in tenant `a`, oldest first. */
  recorded: () => Promise<string[]>
  a: HookSuiteTenant
  b: HookSuiteTenant
}

/**
 * Behaviour every `HookStore` must have. Run against each adapter so the memory store used by
 * unit tests can't drift from Postgres.
 *
 * @param name - Adapter name for the report.
 * @param setup - Builds a fresh context; called before each test.
 */
export function describeHookStore(name: string, setup: () => Promise<HookSuiteContext>): void {
  const now = new Date('2026-01-01T00:00:00.000Z')
  const later = new Date('2026-01-02T00:00:00.000Z')
  const strict = { enabled: true, failureMode: 'deny' } as const
  let ctx: HookSuiteContext

  // The tenant of a real-server fixture carries helpers of its own: only its two ids are taken.
  function hook(tenant: HookSuiteTenant, overrides: Partial<HookRecord> = {}): HookRecord {
    return {
      id: Bun.randomUUIDv7(),
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      point: 'before_sign_up',
      url: 'https://app.example.com/tula/before-sign-up',
      secret: 'v1.sealed.secret',
      enabled: true,
      deadlineMs: 2000,
      failureMode: 'deny',
      lastFailedAt: null,
      lastFailureReason: null,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    }
  }

  function activity(
    tenant: HookSuiteTenant,
    type: 'hook.created' | 'hook.updated' | 'hook.deleted',
    id: string
  ): Activity {
    const scope = { projectId: tenant.projectId, environmentId: tenant.environmentId }
    const deps = { ids: { next: () => Bun.randomUUIDv7() }, clock: { now: () => now } }
    const actor = { type: 'admin', id: null, ipAddress: null, userAgent: null } as const
    const target = { type: 'hook', id } as const
    const point = 'before_sign_up' as const
    if (type === 'hook.created') {
      return Audit.entry(deps, scope, {
        type,
        actor,
        target,
        data: { point, enabled: true, failureMode: 'deny' },
      })
    }
    if (type === 'hook.updated') {
      return Audit.entry(deps, scope, { type, actor, target, data: { point, changed: ['url'] } })
    }
    return Audit.entry(deps, scope, { type, actor, target, data: { point } })
  }

  async function stored(tenant: HookSuiteTenant, overrides: Partial<HookRecord> = {}) {
    const record = hook(tenant, overrides)
    const row = await ctx.store.insert(record, activity(tenant, 'hook.created', record.id))
    if (!row) {
      throw new Error('the hook was not stored')
    }
    return row
  }

  describe(`${name} HookStore`, () => {
    beforeEach(async () => {
      ctx = await setup()
    })

    test('stores a hook and reads it back by id and by point, with its registration recorded', async () => {
      const record = hook(ctx.a)
      expect(await ctx.store.insert(record, activity(ctx.a, 'hook.created', record.id))).toEqual(
        record
      )
      expect(await ctx.store.find(ctx.a.environmentId, record.id)).toEqual(record)
      expect(await ctx.store.findByPoint(ctx.a.environmentId, 'before_sign_up')).toEqual(record)
      expect(await ctx.store.list(ctx.a.environmentId)).toEqual([record])
      expect(await ctx.recorded()).toEqual(['hook.created'])
    })

    test('an environment has one hook per point: a second is not stored and not recorded', async () => {
      const first = await stored(ctx.a)
      const second = hook(ctx.a, { url: 'https://other.example.com/hook' })
      expect(await ctx.store.insert(second, activity(ctx.a, 'hook.created', second.id))).toBeNull()
      expect(await ctx.store.list(ctx.a.environmentId)).toEqual([first])
      expect(await ctx.recorded()).toEqual(['hook.created'])
    })

    test('of two registrations at once exactly one is stored', async () => {
      const [one, two] = [hook(ctx.a), hook(ctx.a)]
      const rows = await Promise.all([
        ctx.store.insert(one, activity(ctx.a, 'hook.created', one.id)),
        ctx.store.insert(two, activity(ctx.a, 'hook.created', two.id)),
      ])
      expect(rows.filter((row) => row !== null)).toHaveLength(1)
      expect(await ctx.store.list(ctx.a.environmentId)).toHaveLength(1)
      expect(await ctx.recorded()).toEqual(['hook.created'])
    })

    test('a hook of another environment is never found, listed, changed, removed or marked', async () => {
      const theirs = await stored(ctx.b)
      const env = ctx.a.environmentId
      expect(await ctx.store.find(env, theirs.id)).toBeNull()
      expect(await ctx.store.findByPoint(env, 'before_sign_up')).toBeNull()
      expect(await ctx.store.list(env)).toEqual([])
      expect(
        await ctx.store.update(
          env,
          theirs.id,
          strict,
          { enabled: false, failureMode: 'allow' },
          later,
          activity(ctx.a, 'hook.updated', theirs.id)
        )
      ).toBeNull()
      expect(
        await ctx.store.delete(env, theirs.id, strict, activity(ctx.a, 'hook.deleted', theirs.id))
      ).toBe(false)
      await ctx.store.noteFailure(env, theirs.id, later, 'timeout')
      expect(await ctx.store.find(ctx.b.environmentId, theirs.id)).toEqual(theirs)
      expect(await ctx.recorded()).toEqual([])
    })

    test('an update sets what it names, keeps the rest, and is recorded', async () => {
      const record = await stored(ctx.a)
      const updated = await ctx.store.update(
        ctx.a.environmentId,
        record.id,
        strict,
        { url: 'https://new.example.com/hook', deadlineMs: 5000 },
        later,
        activity(ctx.a, 'hook.updated', record.id)
      )
      expect(updated).toEqual({
        ...record,
        url: 'https://new.example.com/hook',
        deadlineMs: 5000,
        updatedAt: later,
      })
      expect(await ctx.store.find(ctx.a.environmentId, record.id)).toEqual(updated)
      expect(await ctx.recorded()).toEqual(['hook.created', 'hook.updated'])
    })

    test.each([
      ['switched off meanwhile', { enabled: false }],
      ['set to allow on failure meanwhile', { failureMode: 'allow' }],
    ] as const)(
      'an update judged against a hook that was %s writes nothing and records nothing',
      async (_name, drift) => {
        const record = await stored(ctx.a, drift)
        const outcome = await ctx.store.update(
          ctx.a.environmentId,
          record.id,
          strict,
          { deadlineMs: 300 },
          later,
          activity(ctx.a, 'hook.updated', record.id)
        )
        expect(outcome).toBeNull()
        expect(await ctx.store.find(ctx.a.environmentId, record.id)).toEqual(record)
        expect(await ctx.recorded()).toEqual(['hook.created'])
      }
    )

    test('a removal is recorded, and one judged against a hook that changed removes nothing', async () => {
      const record = await stored(ctx.a, { enabled: false })
      const env = ctx.a.environmentId
      expect(
        await ctx.store.delete(env, record.id, strict, activity(ctx.a, 'hook.deleted', record.id))
      ).toBe(false)
      expect(await ctx.store.find(env, record.id)).toEqual(record)
      expect(
        await ctx.store.delete(
          env,
          record.id,
          { enabled: false, failureMode: 'deny' },
          activity(ctx.a, 'hook.deleted', record.id)
        )
      ).toBe(true)
      expect(await ctx.store.find(env, record.id)).toBeNull()
      expect(await ctx.recorded()).toEqual(['hook.created', 'hook.deleted'])
    })

    test('an unknown hook is neither changed nor removed, and nothing is recorded', async () => {
      const id = Bun.randomUUIDv7()
      const env = ctx.a.environmentId
      expect(
        await ctx.store.update(
          env,
          id,
          strict,
          { enabled: false },
          later,
          activity(ctx.a, 'hook.updated', id)
        )
      ).toBeNull()
      expect(await ctx.store.delete(env, id, strict, activity(ctx.a, 'hook.deleted', id))).toBe(
        false
      )
      await ctx.store.noteFailure(env, id, later, 'timeout')
      expect(await ctx.recorded()).toEqual([])
    })

    test('a failed call is noted with its time and reason, unrecorded, and moves nothing else', async () => {
      const record = await stored(ctx.a)
      await ctx.store.noteFailure(ctx.a.environmentId, record.id, later, 'timeout')
      expect(await ctx.store.find(ctx.a.environmentId, record.id)).toEqual({
        ...record,
        lastFailedAt: later,
        lastFailureReason: 'timeout',
      })
      const again = new Date(later.getTime() + 1000)
      await ctx.store.noteFailure(ctx.a.environmentId, record.id, again, 'answer_invalid')
      expect(await ctx.store.find(ctx.a.environmentId, record.id)).toEqual({
        ...record,
        lastFailedAt: again,
        lastFailureReason: 'answer_invalid',
      })
      expect(await ctx.recorded()).toEqual(['hook.created'])
    })

    test('what is read back is a copy: changing it changes nothing stored', async () => {
      const record = await stored(ctx.a)
      const read = await ctx.store.find(ctx.a.environmentId, record.id)
      if (read) {
        read.enabled = false
        read.url = 'https://changed.example.com'
      }
      expect(await ctx.store.find(ctx.a.environmentId, record.id)).toEqual(record)
    })
  })
}
