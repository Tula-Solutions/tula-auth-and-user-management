import { beforeEach, describe, expect, test } from 'bun:test'
import * as Audit from '~/modules/audit/service'
import type { Activity } from '~/ports/activity-log'
import type {
  ScimGroupRecord,
  ScimStore,
  ScimTokenRecord,
  ScimUserRecord,
} from '~/ports/scim-store'

/** A tenant for the suite. */
export interface ScimSuiteTenant {
  projectId: string
  environmentId: string
}

/** What the store under test provides. */
export interface ScimSuiteContext {
  store: ScimStore
  /** The audit actions recorded so far in tenant `a`, oldest first. */
  recorded: () => Promise<string[]>
  /** Makes an organization of the tenant and returns its id. */
  organization: (tenant: ScimSuiteTenant) => Promise<string>
  /** Makes a user of the tenant and returns its id. */
  user: (tenant: ScimSuiteTenant) => Promise<string>
  a: ScimSuiteTenant
  b: ScimSuiteTenant
}

/**
 * Behaviour every `ScimStore` must have. Run against each adapter so the memory store used by
 * unit tests can't drift from Postgres.
 *
 * @param name - Adapter name for the report.
 * @param setup - Builds a fresh context; called before each test.
 */
export function describeScimStore(name: string, setup: () => Promise<ScimSuiteContext>): void {
  const now = new Date('2026-01-01T00:00:00.000Z')
  const later = new Date('2026-01-02T00:00:00.000Z')
  let ctx: ScimSuiteContext
  let org: string

  function entry(
    tenant: ScimSuiteTenant,
    type:
      | 'scim_token.created'
      | 'scim_token.revoked'
      | 'user.scim_provisioned'
      | 'scim_group.created'
      | 'scim_group.updated'
      | 'scim_group.deleted',
    id: string
  ): Activity {
    const scope = { projectId: tenant.projectId, environmentId: tenant.environmentId }
    const deps = { ids: { next: () => Bun.randomUUIDv7() }, clock: { now: () => now } }
    const actor = { type: 'directory', id: null, ipAddress: null, userAgent: null } as const
    const organizationId = org
    if (type === 'user.scim_provisioned') {
      return Audit.entry(deps, scope, {
        type,
        actor,
        target: { type: 'user', id },
        data: { organizationId, method: 'created' },
      })
    }
    if (type === 'scim_group.created' || type === 'scim_group.deleted') {
      return Audit.entry(deps, scope, {
        type,
        actor,
        target: { type: 'scim_group', id },
        data: { organizationId },
      })
    }
    if (type === 'scim_group.updated') {
      return Audit.entry(deps, scope, {
        type,
        actor,
        target: { type: 'scim_group', id },
        data: { organizationId, changed: ['members'] },
      })
    }
    return Audit.entry(deps, scope, {
      type,
      actor,
      target: { type: 'scim_token', id },
      data: { organizationId },
    })
  }

  function token(overrides: Partial<ScimTokenRecord> = {}): ScimTokenRecord {
    return {
      id: Bun.randomUUIDv7(),
      projectId: ctx.a.projectId,
      environmentId: ctx.a.environmentId,
      organizationId: org,
      name: 'Okta',
      prefix: 'tula_scim_dev',
      tokenHash: Bun.randomUUIDv7(),
      viaSetupLink: false,
      lastUsedAt: null,
      revokedAt: null,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    }
  }

  async function member(
    externalId: string | null,
    overrides: Partial<ScimUserRecord> = {}
  ): Promise<ScimUserRecord> {
    return {
      id: Bun.randomUUIDv7(),
      projectId: ctx.a.projectId,
      environmentId: ctx.a.environmentId,
      organizationId: org,
      userId: await ctx.user(ctx.a),
      externalId,
      active: true,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    }
  }

  const add = (record: ScimUserRecord) =>
    ctx.store.insertUser(record, entry(ctx.a, 'user.scim_provisioned', record.userId))

  describe(`ScimStore (${name})`, () => {
    beforeEach(async () => {
      ctx = await setup()
      org = await ctx.organization(ctx.a)
    })

    test('stores a token with its audit entry and finds it by hash in its environment only', async () => {
      const record = token()
      await ctx.store.insertToken(record, entry(ctx.a, 'scim_token.created', record.id))
      expect(await ctx.store.findTokenByHash(ctx.a.environmentId, record.tokenHash)).toEqual(record)
      expect(await ctx.store.findTokenByHash(ctx.b.environmentId, record.tokenHash)).toBeNull()
      expect(await ctx.store.findTokenByHash(ctx.a.environmentId, 'unknown')).toBeNull()
      expect(await ctx.recorded()).toEqual(['scim_token.created'])
    })

    test('keeps whether a setup link minted the token', async () => {
      const record = token({ viaSetupLink: true })
      await ctx.store.insertToken(record, entry(ctx.a, 'scim_token.created', record.id))
      expect(
        (await ctx.store.findTokenByHash(ctx.a.environmentId, record.tokenHash))?.viaSetupLink
      ).toBe(true)
    })

    test('lists an organization’s tokens newest first, revoked ones included', async () => {
      const first = token()
      const second = token({ createdAt: later, updatedAt: later })
      await ctx.store.insertToken(first, entry(ctx.a, 'scim_token.created', first.id))
      await ctx.store.insertToken(second, entry(ctx.a, 'scim_token.created', second.id))
      const other = await ctx.organization(ctx.a)
      expect((await ctx.store.listTokens(ctx.a.environmentId, org)).map((one) => one.id)).toEqual([
        second.id,
        first.id,
      ])
      expect(await ctx.store.listTokens(ctx.a.environmentId, other)).toEqual([])
      expect(await ctx.store.listTokens(ctx.b.environmentId, org)).toEqual([])
    })

    test('revokes once: a second revocation, or another organization’s, writes nothing', async () => {
      const record = token()
      await ctx.store.insertToken(record, entry(ctx.a, 'scim_token.created', record.id))
      const other = await ctx.organization(ctx.a)
      expect(
        await ctx.store.revokeToken(
          ctx.a.environmentId,
          other,
          record.id,
          later,
          entry(ctx.a, 'scim_token.revoked', record.id)
        )
      ).toBeNull()
      const revoked = await ctx.store.revokeToken(
        ctx.a.environmentId,
        org,
        record.id,
        later,
        entry(ctx.a, 'scim_token.revoked', record.id)
      )
      expect(revoked?.revokedAt).toEqual(later)
      expect(
        await ctx.store.revokeToken(
          ctx.a.environmentId,
          org,
          record.id,
          later,
          entry(ctx.a, 'scim_token.revoked', record.id)
        )
      ).toBeNull()
      expect(await ctx.recorded()).toEqual(['scim_token.created', 'scim_token.revoked'])
    })

    test('records the last use of a token', async () => {
      const record = token()
      await ctx.store.insertToken(record, entry(ctx.a, 'scim_token.created', record.id))
      await ctx.store.touchToken(ctx.a.environmentId, record.id, later)
      expect(
        (await ctx.store.findTokenByHash(ctx.a.environmentId, record.tokenHash))?.lastUsedAt
      ).toEqual(later)
    })

    test('stores a directory user and finds it by user and by external id', async () => {
      const record = await member('ext-1')
      expect(await add(record)).toBeNull()
      expect(await ctx.store.findUser(ctx.a.environmentId, org, record.userId)).toEqual(record)
      expect(await ctx.store.findUserByExternalId(ctx.a.environmentId, org, 'ext-1')).toEqual(
        record
      )
      expect(await ctx.store.findUserByExternalId(ctx.b.environmentId, org, 'ext-1')).toBeNull()
      expect(await ctx.recorded()).toEqual(['user.scim_provisioned'])
    })

    test('refuses a second record of a user and an external id that is taken, writing no entry', async () => {
      const record = await member('ext-1')
      await add(record)
      expect(await add({ ...record, id: Bun.randomUUIDv7(), externalId: 'ext-2' })).toBe('exists')
      expect(await add(await member('ext-1'))).toBe('external_id_taken')
      expect(await ctx.recorded()).toEqual(['user.scim_provisioned'])
    })

    test('allows several users with no external id, and the same external id in another organization', async () => {
      expect(await add(await member(null))).toBeNull()
      expect(await add(await member(null))).toBeNull()
      const other = await ctx.organization(ctx.a)
      await add(await member('shared'))
      expect(await add(await member('shared', { organizationId: other }))).toBeNull()
    })

    test('lists a page of users oldest first with the total', async () => {
      const records = [
        await member('a', { createdAt: now }),
        await member('b', { createdAt: later }),
        await member('c', { createdAt: new Date('2026-01-03T00:00:00.000Z') }),
      ]
      for (const record of records.reverse()) {
        await add(record)
      }
      const page = await ctx.store.listUsers(ctx.a.environmentId, org, 1, 1)
      expect(page.total).toBe(3)
      expect(page.records.map((one) => one.externalId)).toEqual(['b'])
      expect((await ctx.store.listUsers(ctx.a.environmentId, org, 5, 10)).records).toEqual([])
    })

    test('updates active and external id, and refuses a taken external id or a missing user', async () => {
      const one = await member('x')
      const two = await member('y')
      await add(one)
      await add(two)
      expect(
        await ctx.store.updateUser(ctx.a.environmentId, org, one.userId, { active: false }, later)
      ).toBeNull()
      const updated = await ctx.store.findUser(ctx.a.environmentId, org, one.userId)
      expect(updated?.active).toBe(false)
      expect(updated?.externalId).toBe('x')
      expect(updated?.updatedAt).toEqual(later)
      expect(
        await ctx.store.updateUser(ctx.a.environmentId, org, one.userId, { externalId: 'y' }, later)
      ).toBe('external_id_taken')
      expect(
        await ctx.store.updateUser(
          ctx.a.environmentId,
          org,
          one.userId,
          { externalId: null },
          later
        )
      ).toBeNull()
      expect(
        await ctx.store.updateUser(
          ctx.a.environmentId,
          org,
          Bun.randomUUIDv7(),
          { active: true },
          later
        )
      ).toBe('missing')
    })

    test('deletes a directory user and tolerates a missing one', async () => {
      const record = await member('x')
      await add(record)
      await ctx.store.deleteUser(ctx.a.environmentId, org, record.userId)
      await ctx.store.deleteUser(ctx.a.environmentId, org, record.userId)
      expect(await ctx.store.findUser(ctx.a.environmentId, org, record.userId)).toBeNull()
    })

    function group(memberIds: string[], overrides: Partial<ScimGroupRecord> = {}): ScimGroupRecord {
      return {
        id: Bun.randomUUIDv7(),
        projectId: ctx.a.projectId,
        environmentId: ctx.a.environmentId,
        organizationId: org,
        displayName: `Group-${Bun.randomUUIDv7()}`,
        externalId: null,
        memberIds,
        createdAt: now,
        updatedAt: now,
        ...overrides,
      }
    }

    test('stores a group with its members and audit entry, and finds it by id and by name', async () => {
      const one = await member('g1')
      await add(one)
      const record = group([one.userId])
      expect(
        await ctx.store.insertGroup(record, entry(ctx.a, 'scim_group.created', record.id))
      ).toBeNull()
      expect(await ctx.store.findGroup(ctx.a.environmentId, org, record.id)).toEqual(record)
      expect(
        (await ctx.store.findGroupByName(ctx.a.environmentId, org, record.displayName))?.id
      ).toBe(record.id)
      expect(await ctx.store.groupNamesOfUser(ctx.a.environmentId, org, one.userId)).toEqual([
        record.displayName,
      ])
      expect(await ctx.recorded()).toContain('scim_group.created')
    })

    test('refuses a taken name in the organization, writing nothing', async () => {
      const first = group([])
      await ctx.store.insertGroup(first, entry(ctx.a, 'scim_group.created', first.id))
      const second = group([], { displayName: first.displayName })
      const before = (await ctx.recorded()).length
      expect(
        await ctx.store.insertGroup(second, entry(ctx.a, 'scim_group.created', second.id))
      ).toBe('name_taken')
      expect(await ctx.store.findGroup(ctx.a.environmentId, org, second.id)).toBeNull()
      expect((await ctx.recorded()).length).toBe(before)
    })

    test('replaces name, external id and members; refuses a taken name or a missing group', async () => {
      const one = await member('g2')
      const two = await member('g3')
      await add(one)
      await add(two)
      const record = group([one.userId])
      const other = group([])
      await ctx.store.insertGroup(record, entry(ctx.a, 'scim_group.created', record.id))
      await ctx.store.insertGroup(other, entry(ctx.a, 'scim_group.created', other.id))
      const next = { displayName: 'Renamed', externalId: 'ext-g', memberIds: [two.userId] }
      expect(
        await ctx.store.replaceGroup(
          ctx.a.environmentId,
          org,
          record.id,
          next,
          later,
          entry(ctx.a, 'scim_group.updated', record.id)
        )
      ).toBeNull()
      const stored = await ctx.store.findGroup(ctx.a.environmentId, org, record.id)
      expect(stored).toMatchObject(next)
      expect(stored?.updatedAt.toISOString()).toBe(later.toISOString())
      expect(await ctx.store.groupNamesOfUser(ctx.a.environmentId, org, one.userId)).toEqual([])
      expect(
        await ctx.store.replaceGroup(
          ctx.a.environmentId,
          org,
          record.id,
          { ...next, displayName: other.displayName },
          later,
          entry(ctx.a, 'scim_group.updated', record.id)
        )
      ).toBe('name_taken')
      expect(
        await ctx.store.replaceGroup(
          ctx.a.environmentId,
          org,
          Bun.randomUUIDv7(),
          next,
          later,
          entry(ctx.a, 'scim_group.updated', record.id)
        )
      ).toBe('missing')
    })

    test('lists a page of groups with the total, and deletes one once', async () => {
      const records = [group([]), group([]), group([])]
      for (const record of records) {
        await ctx.store.insertGroup(record, entry(ctx.a, 'scim_group.created', record.id))
      }
      const page = await ctx.store.listGroups(ctx.a.environmentId, org, 1, 1)
      expect(page.total).toBe(3)
      expect(page.records).toHaveLength(1)
      const [gone] = records
      if (!gone) {
        throw new Error('no group')
      }
      expect(
        await ctx.store.deleteGroup(
          ctx.a.environmentId,
          org,
          gone.id,
          entry(ctx.a, 'scim_group.deleted', gone.id)
        )
      ).toBe(true)
      expect(
        await ctx.store.deleteGroup(
          ctx.a.environmentId,
          org,
          gone.id,
          entry(ctx.a, 'scim_group.deleted', gone.id)
        )
      ).toBe(false)
    })

    test('a group is invisible from another environment and another organization', async () => {
      const record = group([])
      await ctx.store.insertGroup(record, entry(ctx.a, 'scim_group.created', record.id))
      expect(await ctx.store.findGroup(ctx.b.environmentId, org, record.id)).toBeNull()
      expect(
        await ctx.store.findGroup(ctx.a.environmentId, Bun.randomUUIDv7(), record.id)
      ).toBeNull()
      expect(
        await ctx.store.deleteGroup(
          ctx.b.environmentId,
          org,
          record.id,
          entry(ctx.b, 'scim_group.deleted', record.id)
        )
      ).toBe(false)
      expect(await ctx.store.findGroup(ctx.a.environmentId, org, record.id)).not.toBeNull()
    })

    test('deleting a directory user takes them out of their groups', async () => {
      const one = await member('g4')
      await add(one)
      const record = group([one.userId])
      await ctx.store.insertGroup(record, entry(ctx.a, 'scim_group.created', record.id))
      await ctx.store.deleteUser(ctx.a.environmentId, org, one.userId)
      expect((await ctx.store.findGroup(ctx.a.environmentId, org, record.id))?.memberIds).toEqual(
        []
      )
    })
  })
}
