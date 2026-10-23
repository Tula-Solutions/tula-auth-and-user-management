import { beforeEach, describe, expect, test } from 'bun:test'
import { BUILT_IN_ROLES } from '@tula-tech/contract'
import * as Audit from '~/modules/audit/service'
import type { Activity } from '~/ports/activity-log'
import type {
  MembershipRecord,
  OrganizationRecord,
  OrganizationRoleRecord,
  OrganizationStore,
} from '~/ports/organization-store'

/** A tenant for the suite. */
export interface OrganizationSuiteTenant {
  projectId: string
  environmentId: string
}

/** What the store under test provides. */
export interface OrganizationSuiteContext {
  store: OrganizationStore
  /** The audit actions recorded so far in tenant `a`, oldest first. */
  recorded: () => Promise<string[]>
  /** Make a user in a tenant (a database needs the row a membership refers to); returns its id. */
  user: (tenant: OrganizationSuiteTenant) => Promise<string>
  /**
   * Delete a user the way the users repository does; the store must drop their memberships
   * (the database cascades, the memory store is told by the users repository).
   */
  deleteUser: (tenant: OrganizationSuiteTenant, userId: string) => Promise<void>
  a: OrganizationSuiteTenant
  b: OrganizationSuiteTenant
}

/**
 * Behaviour every `OrganizationStore` must have. Run against each adapter so the memory store
 * used by unit tests can't drift from Postgres.
 *
 * @param name - Adapter name for the report.
 * @param setup - Builds a fresh context; called before each test.
 */
export function describeOrganizationStore(
  name: string,
  setup: () => Promise<OrganizationSuiteContext>
): void {
  const now = new Date('2026-01-01T00:00:00.000Z')
  const later = new Date('2026-01-02T00:00:00.000Z')
  let ctx: OrganizationSuiteContext

  function organization(
    tenant: OrganizationSuiteTenant,
    overrides: Partial<OrganizationRecord> = {}
  ): OrganizationRecord {
    return {
      id: Bun.randomUUIDv7(),
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      name: 'Acme',
      slug: 'acme',
      createdBy: null,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    }
  }

  function roles(tenant: OrganizationSuiteTenant): OrganizationRoleRecord[] {
    return BUILT_IN_ROLES.map((role) => ({
      id: Bun.randomUUIDv7(),
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      key: role.key,
      name: role.name,
      permissions: [...role.permissions],
      builtIn: true,
      createdAt: now,
      updatedAt: now,
    }))
  }

  type Type =
    | 'organization.created'
    | 'organization.updated'
    | 'organization.deleted'
    | 'organization_membership.added'
    | 'organization_membership.role_changed'
    | 'organization_membership.removed'

  /** An activity of the given type, about the given id, with data that passes the contract. */
  function activity(tenant: OrganizationSuiteTenant, type: Type, id: string): Activity {
    const scope = { projectId: tenant.projectId, environmentId: tenant.environmentId }
    const deps = { ids: { next: () => Bun.randomUUIDv7() }, clock: { now: () => now } }
    const actor = { type: 'admin', id: null, ipAddress: null, userAgent: null } as const
    const user = Bun.randomUUIDv7()
    const orgTarget = { type: 'organization', id } as const
    const memberTarget = { type: 'organization_membership', id } as const
    const member = { organizationId: id, userId: user, role: 'member' } as const
    switch (type) {
      case 'organization.created':
        return Audit.entry(deps, scope, { type, actor, target: orgTarget })
      case 'organization.updated':
        return Audit.entry(deps, scope, {
          type,
          actor,
          target: orgTarget,
          data: { changed: ['name'] },
        })
      case 'organization.deleted':
        return Audit.entry(deps, scope, {
          type,
          actor,
          target: orgTarget,
          data: { memberships: 0 },
        })
      case 'organization_membership.added':
        return Audit.entry(deps, scope, { type, actor, target: memberTarget, data: member })
      case 'organization_membership.role_changed':
        return Audit.entry(deps, scope, {
          type,
          actor,
          target: memberTarget,
          data: { ...member, previousRole: 'admin' },
        })
      case 'organization_membership.removed':
        return Audit.entry(deps, scope, { type, actor, target: memberTarget, data: member })
    }
  }

  async function stored(record: OrganizationRecord): Promise<OrganizationRecord> {
    const tenant = { projectId: record.projectId, environmentId: record.environmentId }
    const row = await ctx.store.insert(record, activity(tenant, 'organization.created', record.id))
    if (!row) {
      throw new Error('the organization was not stored')
    }
    return row
  }

  /** The two built-in roles of a tenant, as the store has them. */
  async function builtIns(tenant: OrganizationSuiteTenant) {
    await ctx.store.ensureBuiltInRoles(roles(tenant))
    const admin = await ctx.store.findRole(tenant.environmentId, 'admin')
    const member = await ctx.store.findRole(tenant.environmentId, 'member')
    if (!admin || !member) {
      throw new Error('the built-in roles were not stored')
    }
    return { admin, member }
  }

  async function join(
    tenant: OrganizationSuiteTenant,
    org: OrganizationRecord,
    role: OrganizationRoleRecord,
    overrides: Partial<MembershipRecord> = {}
  ): Promise<MembershipRecord> {
    const userId = overrides.userId ?? (await ctx.user(tenant))
    const record: MembershipRecord = {
      id: Bun.randomUUIDv7(),
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      organizationId: org.id,
      userId,
      roleId: role.id,
      roleKey: role.key,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    }
    const result = await ctx.store.addMembership(
      record,
      activity(tenant, 'organization_membership.added', record.id)
    )
    if (result.outcome !== 'added') {
      throw new Error(`the member was not added: ${result.outcome}`)
    }
    return result.record
  }

  describe(`${name} OrganizationStore`, () => {
    beforeEach(async () => {
      ctx = await setup()
    })

    test('stores an organization, reads it back and records the creation', async () => {
      const record = organization(ctx.a)
      expect(
        await ctx.store.insert(record, activity(ctx.a, 'organization.created', record.id))
      ).toEqual(record)
      expect(await ctx.store.find(ctx.a.environmentId, record.id)).toEqual(record)
      expect(await ctx.recorded()).toEqual(['organization.created'])
    })

    test('a slug is unique in an environment: a second is not stored and not recorded', async () => {
      const first = await stored(organization(ctx.a))
      const second = organization(ctx.a, { name: 'Other' })
      expect(
        await ctx.store.insert(second, activity(ctx.a, 'organization.created', second.id))
      ).toBeNull()
      expect((await ctx.store.list(ctx.a.environmentId, { page: 1, size: 10 })).records).toEqual([
        first,
      ])
      expect(await ctx.recorded()).toEqual(['organization.created'])
    })

    test('the same slug in another environment is another organization', async () => {
      const mine = await stored(organization(ctx.a))
      const theirs = await stored(organization(ctx.b))
      expect(mine.id).not.toBe(theirs.id)
      expect((await ctx.store.list(ctx.b.environmentId, { page: 1, size: 10 })).records).toEqual([
        theirs,
      ])
    })

    test('of two creations of one slug at once exactly one is stored', async () => {
      const [one, two] = [organization(ctx.a), organization(ctx.a)]
      const rows = await Promise.all([
        ctx.store.insert(one, activity(ctx.a, 'organization.created', one.id)),
        ctx.store.insert(two, activity(ctx.a, 'organization.created', two.id)),
      ])
      expect(rows.filter((row) => row !== null)).toHaveLength(1)
      expect(await ctx.recorded()).toEqual(['organization.created'])
    })

    test('lists newest first, a page at a time, with the total', async () => {
      const first = await stored(organization(ctx.a, { slug: 'first' }))
      const second = await stored(
        organization(ctx.a, { slug: 'second', createdAt: later, updatedAt: later })
      )
      const third = await stored(
        organization(ctx.a, {
          slug: 'third',
          createdAt: new Date('2026-01-03T00:00:00.000Z'),
          updatedAt: new Date('2026-01-03T00:00:00.000Z'),
        })
      )
      expect(await ctx.store.list(ctx.a.environmentId, { page: 1, size: 2 })).toEqual({
        records: [third, second],
        total: 3,
      })
      expect(await ctx.store.list(ctx.a.environmentId, { page: 2, size: 2 })).toEqual({
        records: [first],
        total: 3,
      })
      expect(await ctx.store.list(ctx.a.environmentId, { page: 3, size: 2 })).toEqual({
        records: [],
        total: 3,
      })
    })

    test('an organization of another environment is never found, listed, changed or deleted', async () => {
      const theirs = await stored(organization(ctx.b))
      const env = ctx.a.environmentId
      expect(await ctx.store.find(env, theirs.id)).toBeNull()
      expect(await ctx.store.list(env, { page: 1, size: 10 })).toEqual({ records: [], total: 0 })
      expect(
        await ctx.store.update(
          env,
          theirs.id,
          { name: 'Taken over' },
          later,
          activity(ctx.a, 'organization.updated', theirs.id)
        )
      ).toEqual({ outcome: 'not_found' })
      expect(
        await ctx.store.delete(env, theirs.id, activity(ctx.a, 'organization.deleted', theirs.id))
      ).toBe(false)
      expect(await ctx.store.find(ctx.b.environmentId, theirs.id)).toEqual(theirs)
      expect(await ctx.recorded()).toEqual([])
    })

    test('an update sets the name and the slug, keeps the rest and is recorded', async () => {
      const record = await stored(organization(ctx.a))
      const result = await ctx.store.update(
        ctx.a.environmentId,
        record.id,
        { name: 'Acme Corp', slug: 'acme-corp' },
        later,
        activity(ctx.a, 'organization.updated', record.id)
      )
      expect(result).toEqual({
        outcome: 'updated',
        record: { ...record, name: 'Acme Corp', slug: 'acme-corp', updatedAt: later },
      })
      expect(await ctx.recorded()).toEqual(['organization.created', 'organization.updated'])
    })

    test('an update to a slug another organization has is refused and not recorded', async () => {
      await stored(organization(ctx.a, { slug: 'taken' }))
      const record = await stored(organization(ctx.a, { slug: 'mine' }))
      expect(
        await ctx.store.update(
          ctx.a.environmentId,
          record.id,
          { slug: 'taken' },
          later,
          activity(ctx.a, 'organization.updated', record.id)
        )
      ).toEqual({ outcome: 'slug_taken' })
      expect(await ctx.store.find(ctx.a.environmentId, record.id)).toEqual(record)
      expect(await ctx.recorded()).toEqual(['organization.created', 'organization.created'])
    })

    test('a deleted organization takes its memberships with it', async () => {
      const record = await stored(organization(ctx.a))
      const { admin } = await builtIns(ctx.a)
      const member = await join(ctx.a, record, admin)
      expect(
        await ctx.store.delete(
          ctx.a.environmentId,
          record.id,
          activity(ctx.a, 'organization.deleted', record.id)
        )
      ).toBe(true)
      expect(await ctx.store.find(ctx.a.environmentId, record.id)).toBeNull()
      expect(
        await ctx.store.findMembership(ctx.a.environmentId, record.id, member.userId)
      ).toBeNull()
      expect(await ctx.recorded()).toEqual([
        'organization.created',
        'organization_membership.added',
        'organization.deleted',
      ])
    })

    test('a missing organization is not deleted and nothing is recorded', async () => {
      expect(
        await ctx.store.delete(
          ctx.a.environmentId,
          Bun.randomUUIDv7(),
          activity(ctx.a, 'organization.deleted', Bun.randomUUIDv7())
        )
      ).toBe(false)
      expect(await ctx.recorded()).toEqual([])
    })

    test('the built-in roles are stored once, however often they are ensured', async () => {
      await ctx.store.ensureBuiltInRoles(roles(ctx.a))
      await ctx.store.ensureBuiltInRoles(roles(ctx.a))
      const listed = await ctx.store.listRoles(ctx.a.environmentId)
      expect(listed.map((role) => role.key)).toEqual(['admin', 'member'])
      expect(listed.every((role) => role.builtIn)).toBe(true)
      expect(listed[0]?.permissions).toContain('org:sys:memberships:manage')
      expect(listed[1]?.permissions).toEqual(['org:sys:memberships:read'])
      expect(await ctx.store.findRole(ctx.a.environmentId, 'admin')).toEqual(listed[0] ?? null)
      expect(await ctx.store.findRole(ctx.a.environmentId, 'nobody')).toBeNull()
    })

    test('roles are per environment', async () => {
      await ctx.store.ensureBuiltInRoles(roles(ctx.a))
      expect(await ctx.store.listRoles(ctx.b.environmentId)).toEqual([])
      expect(await ctx.store.findRole(ctx.b.environmentId, 'admin')).toBeNull()
    })

    test('adds a member with a role, reads them back and records it', async () => {
      const record = await stored(organization(ctx.a))
      const { admin } = await builtIns(ctx.a)
      const member = await join(ctx.a, record, admin)
      expect(member.roleKey).toBe('admin')
      expect(await ctx.store.findMembership(ctx.a.environmentId, record.id, member.userId)).toEqual(
        member
      )
      expect(
        await ctx.store.listMemberships(ctx.a.environmentId, record.id, { page: 1, size: 10 })
      ).toEqual({ records: [member], total: 1 })
      expect(await ctx.recorded()).toEqual([
        'organization.created',
        'organization_membership.added',
      ])
    })

    test('a user is a member of an organization once', async () => {
      const record = await stored(organization(ctx.a))
      const { admin, member } = await builtIns(ctx.a)
      const first = await join(ctx.a, record, admin)
      const again: MembershipRecord = {
        ...first,
        id: Bun.randomUUIDv7(),
        roleId: member.id,
        roleKey: member.key,
      }
      expect(
        await ctx.store.addMembership(
          again,
          activity(ctx.a, 'organization_membership.added', again.id)
        )
      ).toEqual({ outcome: 'duplicate' })
      expect(await ctx.recorded()).toEqual([
        'organization.created',
        'organization_membership.added',
      ])
    })

    test('adding a membership for an unknown user is gone', async () => {
      const record = await stored(organization(ctx.a))
      const { admin } = await builtIns(ctx.a)
      const stranger: MembershipRecord = {
        id: Bun.randomUUIDv7(),
        projectId: ctx.a.projectId,
        environmentId: ctx.a.environmentId,
        organizationId: record.id,
        userId: Bun.randomUUIDv7(),
        roleId: admin.id,
        roleKey: admin.key,
        createdAt: now,
        updatedAt: now,
      }
      expect(
        await ctx.store.addMembership(
          stranger,
          activity(ctx.a, 'organization_membership.added', stranger.id)
        )
      ).toEqual({ outcome: 'gone' })
      expect(await ctx.recorded()).toEqual(['organization.created'])
    })

    test('deleting a user removes their memberships', async () => {
      const record = await stored(organization(ctx.a))
      const { admin, member } = await builtIns(ctx.a)
      const staying = await join(ctx.a, record, admin)
      const leaving = await join(ctx.a, record, member)
      await ctx.deleteUser(ctx.a, leaving.userId)
      expect(await ctx.store.findMembership(ctx.a.environmentId, record.id, leaving.userId)).toBe(
        null
      )
      expect(
        await ctx.store.listMemberships(ctx.a.environmentId, record.id, { page: 1, size: 10 })
      ).toMatchObject({ total: 1 })
      expect(
        await ctx.store.findMembership(ctx.a.environmentId, record.id, staying.userId)
      ).not.toBeNull()
    })

    test('a member cannot be added to an organization that is gone', async () => {
      const { admin } = await builtIns(ctx.a)
      const ghost = organization(ctx.a)
      const record: MembershipRecord = {
        id: Bun.randomUUIDv7(),
        projectId: ctx.a.projectId,
        environmentId: ctx.a.environmentId,
        organizationId: ghost.id,
        userId: await ctx.user(ctx.a),
        roleId: admin.id,
        roleKey: admin.key,
        createdAt: now,
        updatedAt: now,
      }
      expect(
        await ctx.store.addMembership(
          record,
          activity(ctx.a, 'organization_membership.added', record.id)
        )
      ).toEqual({ outcome: 'gone' })
      expect(await ctx.recorded()).toEqual([])
    })

    test('an organization or a role of another environment cannot be joined', async () => {
      const theirs = await stored(organization(ctx.b))
      const mine = await stored(organization(ctx.a))
      const { admin } = await builtIns(ctx.a)
      const { admin: theirAdmin } = await builtIns(ctx.b)
      const attempt = async (org: OrganizationRecord, role: OrganizationRoleRecord) => {
        const record: MembershipRecord = {
          id: Bun.randomUUIDv7(),
          projectId: ctx.a.projectId,
          environmentId: ctx.a.environmentId,
          organizationId: org.id,
          userId: await ctx.user(ctx.a),
          roleId: role.id,
          roleKey: role.key,
          createdAt: now,
          updatedAt: now,
        }
        return ctx.store.addMembership(
          record,
          activity(ctx.a, 'organization_membership.added', record.id)
        )
      }
      expect(await attempt(theirs, admin)).toEqual({ outcome: 'gone' })
      expect(await attempt(mine, theirAdmin)).toEqual({ outcome: 'gone' })
      expect(await ctx.recorded()).toEqual(['organization.created'])
    })

    test('members of another environment’s organization are not listed or found here', async () => {
      const theirs = await stored(organization(ctx.b))
      const { admin } = await builtIns(ctx.b)
      const member = await join(ctx.b, theirs, admin)
      expect(
        await ctx.store.listMemberships(ctx.a.environmentId, theirs.id, { page: 1, size: 10 })
      ).toEqual({ records: [], total: 0 })
      expect(
        await ctx.store.findMembership(ctx.a.environmentId, theirs.id, member.userId)
      ).toBeNull()
      expect(
        await ctx.store.removeMembership(
          ctx.a.environmentId,
          theirs.id,
          member.userId,
          admin.id,
          activity(ctx.a, 'organization_membership.removed', member.id)
        )
      ).toEqual({ outcome: 'not_found' })
      expect(await ctx.store.findMembership(ctx.b.environmentId, theirs.id, member.userId)).toEqual(
        member
      )
    })

    test('changes a member’s role, guarded by the role they were read with, and records it', async () => {
      const record = await stored(organization(ctx.a))
      const { admin, member } = await builtIns(ctx.a)
      await join(ctx.a, record, admin)
      const second = await join(ctx.a, record, admin)
      const result = await ctx.store.changeRole(
        ctx.a.environmentId,
        record.id,
        second.userId,
        admin.id,
        member,
        later,
        activity(ctx.a, 'organization_membership.role_changed', second.id)
      )
      expect(result).toEqual({
        outcome: 'done',
        record: { ...second, roleId: member.id, roleKey: 'member', updatedAt: later },
      })
      expect(await ctx.store.findMembership(ctx.a.environmentId, record.id, second.userId)).toEqual(
        {
          ...second,
          roleId: member.id,
          roleKey: 'member',
          updatedAt: later,
        }
      )
      // Read as an admin, but they are a member now: nothing is written over that.
      expect(
        await ctx.store.changeRole(
          ctx.a.environmentId,
          record.id,
          second.userId,
          admin.id,
          admin,
          later,
          activity(ctx.a, 'organization_membership.role_changed', second.id)
        )
      ).toEqual({ outcome: 'conflict' })
      expect(await ctx.recorded()).toEqual([
        'organization.created',
        'organization_membership.added',
        'organization_membership.added',
        'organization_membership.role_changed',
      ])
    })

    test('the last member who can manage members cannot be demoted or removed', async () => {
      const record = await stored(organization(ctx.a))
      const { admin, member } = await builtIns(ctx.a)
      const only = await join(ctx.a, record, admin)
      const plain = await join(ctx.a, record, member)
      expect(
        await ctx.store.changeRole(
          ctx.a.environmentId,
          record.id,
          only.userId,
          admin.id,
          member,
          later,
          activity(ctx.a, 'organization_membership.role_changed', only.id)
        )
      ).toEqual({ outcome: 'last_manager' })
      expect(
        await ctx.store.removeMembership(
          ctx.a.environmentId,
          record.id,
          only.userId,
          admin.id,
          activity(ctx.a, 'organization_membership.removed', only.id)
        )
      ).toEqual({ outcome: 'last_manager' })
      // A member who cannot manage members is removable, and being the only one is nothing to it.
      expect(
        (
          await ctx.store.removeMembership(
            ctx.a.environmentId,
            record.id,
            plain.userId,
            member.id,
            activity(ctx.a, 'organization_membership.removed', plain.id)
          )
        ).outcome
      ).toBe('done')
      expect(await ctx.store.findMembership(ctx.a.environmentId, record.id, only.userId)).toEqual(
        only
      )
      expect(await ctx.recorded()).toEqual([
        'organization.created',
        'organization_membership.added',
        'organization_membership.added',
        'organization_membership.removed',
      ])
    })

    test('with a second manager the first can be demoted, then removed', async () => {
      const record = await stored(organization(ctx.a))
      const { admin, member } = await builtIns(ctx.a)
      const first = await join(ctx.a, record, admin)
      const second = await join(ctx.a, record, admin)
      expect(
        (
          await ctx.store.changeRole(
            ctx.a.environmentId,
            record.id,
            first.userId,
            admin.id,
            member,
            later,
            activity(ctx.a, 'organization_membership.role_changed', first.id)
          )
        ).outcome
      ).toBe('done')
      // The second is now the only manager.
      expect(
        (
          await ctx.store.removeMembership(
            ctx.a.environmentId,
            record.id,
            second.userId,
            admin.id,
            activity(ctx.a, 'organization_membership.removed', second.id)
          )
        ).outcome
      ).toBe('last_manager')
      expect(
        (
          await ctx.store.removeMembership(
            ctx.a.environmentId,
            record.id,
            first.userId,
            member.id,
            activity(ctx.a, 'organization_membership.removed', first.id)
          )
        ).outcome
      ).toBe('done')
    })

    test('of two demotions of the last two managers at once exactly one is made', async () => {
      const record = await stored(organization(ctx.a))
      const { admin, member } = await builtIns(ctx.a)
      const first = await join(ctx.a, record, admin)
      const second = await join(ctx.a, record, admin)
      const demote = (m: MembershipRecord) =>
        ctx.store.changeRole(
          ctx.a.environmentId,
          record.id,
          m.userId,
          admin.id,
          member,
          later,
          activity(ctx.a, 'organization_membership.role_changed', m.id)
        )
      const results = await Promise.all([demote(first), demote(second)])
      expect(results.map((result) => result.outcome).sort()).toEqual(['done', 'last_manager'])
    })

    test('removing a member that is not one is not found, and nothing is recorded', async () => {
      const record = await stored(organization(ctx.a))
      const { admin } = await builtIns(ctx.a)
      expect(
        await ctx.store.removeMembership(
          ctx.a.environmentId,
          record.id,
          Bun.randomUUIDv7(),
          admin.id,
          activity(ctx.a, 'organization_membership.removed', Bun.randomUUIDv7())
        )
      ).toEqual({ outcome: 'not_found' })
      expect(await ctx.recorded()).toEqual(['organization.created'])
    })
  })
}
