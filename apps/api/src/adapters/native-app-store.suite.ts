import { beforeEach, describe, expect, test } from 'bun:test'
import * as Audit from '~/modules/audit/service'
import type { Activity } from '~/ports/activity-log'
import type { NativeAppRecord, NativeAppStore } from '~/ports/native-app-store'

/** A tenant for the suite. */
export interface NativeAppSuiteTenant {
  projectId: string
  environmentId: string
}

/** What the store under test provides. */
export interface NativeAppSuiteContext {
  store: NativeAppStore
  /** The audit actions recorded so far in tenant `a`, oldest first. */
  recorded: () => Promise<string[]>
  a: NativeAppSuiteTenant
  b: NativeAppSuiteTenant
}

/** A fingerprint in the stored form, every byte the same. */
const fingerprint = (byte: string) => Array.from({ length: 32 }, () => byte).join(':')

/**
 * Behaviour every `NativeAppStore` must have. Run against each adapter so the memory store
 * used by unit tests can't drift from Postgres.
 *
 * @param name - Adapter name for the report.
 * @param setup - Builds a fresh context; called before each test.
 */
export function describeNativeAppStore(
  name: string,
  setup: () => Promise<NativeAppSuiteContext>
): void {
  const now = new Date('2026-01-01T00:00:00.000Z')
  const later = new Date('2026-01-02T00:00:00.000Z')
  const AA = fingerprint('AA')
  const BB = fingerprint('BB')
  let ctx: NativeAppSuiteContext

  function ios(tenant: NativeAppSuiteTenant, overrides: Partial<NativeAppRecord> = {}) {
    return {
      id: Bun.randomUUIDv7(),
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      platform: 'ios',
      identifier: 'com.example.app',
      teamId: 'A1B2C3D4E5',
      sha256CertFingerprints: [],
      createdAt: now,
      updatedAt: now,
      ...overrides,
    } satisfies NativeAppRecord
  }

  function android(tenant: NativeAppSuiteTenant, overrides: Partial<NativeAppRecord> = {}) {
    return ios(tenant, {
      platform: 'android',
      teamId: null,
      sha256CertFingerprints: [AA],
      ...overrides,
    })
  }

  function activity(
    tenant: NativeAppSuiteTenant,
    type: 'native_app.created' | 'native_app.updated' | 'native_app.deleted',
    id: string
  ): Activity {
    const scope = { projectId: tenant.projectId, environmentId: tenant.environmentId }
    const deps = { ids: { next: () => Bun.randomUUIDv7() }, clock: { now: () => now } }
    const actor = { type: 'admin', id: null, ipAddress: null, userAgent: null } as const
    const target = { type: 'native_app', id } as const
    const platform = 'android' as const
    if (type === 'native_app.created') {
      return Audit.entry(deps, scope, {
        type,
        actor,
        target,
        data: { platform, fingerprints: 1, weakened: true },
      })
    }
    if (type === 'native_app.updated') {
      return Audit.entry(deps, scope, {
        type,
        actor,
        target,
        data: { platform, changed: ['sha256CertFingerprints'], fingerprints: 2 },
      })
    }
    return Audit.entry(deps, scope, { type, actor, target, data: { platform } })
  }

  async function stored(record: NativeAppRecord) {
    const tenant = { projectId: record.projectId, environmentId: record.environmentId }
    const row = await ctx.store.insert(record, activity(tenant, 'native_app.created', record.id))
    if (!row) {
      throw new Error('the app was not stored')
    }
    return row
  }

  describe(`${name} NativeAppStore`, () => {
    beforeEach(async () => {
      ctx = await setup()
    })

    test('stores an app of each platform and reads them back, oldest first, with each registration recorded', async () => {
      const one = ios(ctx.a)
      const two = android(ctx.a, { createdAt: later, updatedAt: later })
      expect(await ctx.store.insert(two, activity(ctx.a, 'native_app.created', two.id))).toEqual(
        two
      )
      expect(await ctx.store.insert(one, activity(ctx.a, 'native_app.created', one.id))).toEqual(
        one
      )
      expect(await ctx.store.find(ctx.a.environmentId, one.id)).toEqual(one)
      expect(await ctx.store.list(ctx.a.environmentId)).toEqual([one, two])
      expect(await ctx.recorded()).toEqual(['native_app.created', 'native_app.created'])
    })

    test('an environment has one app per platform and identifier: a second is not stored and not recorded', async () => {
      const first = await stored(ios(ctx.a))
      const second = ios(ctx.a, { teamId: 'ZZZZZZZZZZ' })
      expect(
        await ctx.store.insert(second, activity(ctx.a, 'native_app.created', second.id))
      ).toBeNull()
      expect(await ctx.store.list(ctx.a.environmentId)).toEqual([first])
      expect(await ctx.recorded()).toEqual(['native_app.created'])
    })

    test('the same name on the other platform, and in another environment, is another app', async () => {
      const first = await stored(ios(ctx.a))
      const droid = await stored(android(ctx.a, { createdAt: later, updatedAt: later }))
      const theirs = await stored(ios(ctx.b))
      expect(await ctx.store.list(ctx.a.environmentId)).toEqual([first, droid])
      expect(await ctx.store.list(ctx.b.environmentId)).toEqual([theirs])
    })

    test('of two registrations of one app at once exactly one is stored', async () => {
      const [one, two] = [android(ctx.a), android(ctx.a)]
      const rows = await Promise.all([
        ctx.store.insert(one, activity(ctx.a, 'native_app.created', one.id)),
        ctx.store.insert(two, activity(ctx.a, 'native_app.created', two.id)),
      ])
      expect(rows.filter((row) => row !== null)).toHaveLength(1)
      expect(await ctx.store.list(ctx.a.environmentId)).toHaveLength(1)
      expect(await ctx.recorded()).toEqual(['native_app.created'])
    })

    test('an app of another environment is never found, listed, changed or removed', async () => {
      const theirs = await stored(android(ctx.b))
      const env = ctx.a.environmentId
      expect(await ctx.store.find(env, theirs.id)).toBeNull()
      expect(await ctx.store.list(env)).toEqual([])
      expect(
        await ctx.store.update(
          env,
          theirs.id,
          theirs,
          { sha256CertFingerprints: [AA, BB] },
          later,
          activity(ctx.a, 'native_app.updated', theirs.id)
        )
      ).toBeNull()
      expect(
        await ctx.store.delete(env, theirs.id, activity(ctx.a, 'native_app.deleted', theirs.id))
      ).toBe(false)
      expect(await ctx.store.find(ctx.b.environmentId, theirs.id)).toEqual(theirs)
      expect(await ctx.recorded()).toEqual([])
    })

    test('an update sets an Android app’s fingerprints, keeps the rest, and is recorded', async () => {
      const record = await stored(android(ctx.a))
      const updated = await ctx.store.update(
        ctx.a.environmentId,
        record.id,
        record,
        { sha256CertFingerprints: [AA, BB] },
        later,
        activity(ctx.a, 'native_app.updated', record.id)
      )
      expect(updated).toEqual({ ...record, sha256CertFingerprints: [AA, BB], updatedAt: later })
      expect(await ctx.store.find(ctx.a.environmentId, record.id)).toEqual(updated)
      expect(await ctx.recorded()).toEqual(['native_app.created', 'native_app.updated'])
    })

    test('an update sets an iOS app’s team and nothing else', async () => {
      const record = await stored(ios(ctx.a))
      const updated = await ctx.store.update(
        ctx.a.environmentId,
        record.id,
        record,
        { teamId: 'ZZZZZZZZZZ' },
        later,
        activity(ctx.a, 'native_app.updated', record.id)
      )
      expect(updated).toEqual({ ...record, teamId: 'ZZZZZZZZZZ', updatedAt: later })
    })

    test.each([
      ['fingerprints were added meanwhile', { sha256CertFingerprints: [AA, BB] }],
      ['fingerprints were replaced meanwhile', { sha256CertFingerprints: [BB] }],
    ] as const)(
      'an update judged against an app whose %s writes nothing and records nothing',
      async (_name, drift) => {
        const record = await stored(
          android(ctx.a, { sha256CertFingerprints: [...drift.sha256CertFingerprints] })
        )
        const outcome = await ctx.store.update(
          ctx.a.environmentId,
          record.id,
          { teamId: null, sha256CertFingerprints: [AA] },
          { sha256CertFingerprints: [AA] },
          later,
          activity(ctx.a, 'native_app.updated', record.id)
        )
        expect(outcome).toBeNull()
        expect(await ctx.store.find(ctx.a.environmentId, record.id)).toEqual(record)
        expect(await ctx.recorded()).toEqual(['native_app.created'])
      }
    )

    test('an update judged against an iOS app that moved to another team meanwhile writes nothing', async () => {
      const record = await stored(ios(ctx.a, { teamId: 'ZZZZZZZZZZ' }))
      expect(
        await ctx.store.update(
          ctx.a.environmentId,
          record.id,
          { teamId: 'A1B2C3D4E5', sha256CertFingerprints: [] },
          { teamId: 'YYYYYYYYYY' },
          later,
          activity(ctx.a, 'native_app.updated', record.id)
        )
      ).toBeNull()
      expect(await ctx.store.find(ctx.a.environmentId, record.id)).toEqual(record)
      expect(await ctx.recorded()).toEqual(['native_app.created'])
    })

    test('a removal is recorded and the name can be registered again', async () => {
      const record = await stored(ios(ctx.a))
      const env = ctx.a.environmentId
      expect(
        await ctx.store.delete(env, record.id, activity(ctx.a, 'native_app.deleted', record.id))
      ).toBe(true)
      expect(await ctx.store.find(env, record.id)).toBeNull()
      expect(await ctx.store.list(env)).toEqual([])
      expect(await ctx.recorded()).toEqual(['native_app.created', 'native_app.deleted'])
      expect(await ctx.store.insert(ios(ctx.a), Audit.none('fixture'))).not.toBeNull()
    })

    test('an unknown app is neither changed nor removed, and nothing is recorded', async () => {
      const id = Bun.randomUUIDv7()
      const env = ctx.a.environmentId
      expect(
        await ctx.store.update(
          env,
          id,
          { teamId: null, sha256CertFingerprints: [AA] },
          { sha256CertFingerprints: [BB] },
          later,
          activity(ctx.a, 'native_app.updated', id)
        )
      ).toBeNull()
      expect(await ctx.store.delete(env, id, activity(ctx.a, 'native_app.deleted', id))).toBe(false)
      expect(await ctx.recorded()).toEqual([])
    })

    test('what is read back is a copy: changing it changes nothing stored', async () => {
      const record = await stored(android(ctx.a))
      const read = await ctx.store.find(ctx.a.environmentId, record.id)
      if (read) {
        read.identifier = 'com.changed.app'
        read.sha256CertFingerprints.push(BB)
      }
      const [listed] = await ctx.store.list(ctx.a.environmentId)
      listed?.sha256CertFingerprints.push(BB)
      expect(await ctx.store.find(ctx.a.environmentId, record.id)).toEqual(record)
    })
  })
}
