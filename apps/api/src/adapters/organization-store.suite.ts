import { beforeEach, describe, expect, test } from 'bun:test'
import { BUILT_IN_ROLES } from '@tula-tech/contract'
import * as Audit from '~/modules/audit/service'
import type { Activity } from '~/ports/activity-log'
import type {
  InvitationRecord,
  MembershipRecord,
  OrganizationRecord,
  OrganizationRoleRecord,
  OrganizationStore,
} from '~/ports/organization-store'
import type { DeleteUserOutcome } from '~/ports/user-repository'

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
   * Delete a user through the users repository's `delete`; the store must drop their
   * memberships (the database cascades, the memory store is told by the users repository), and
   * the deletion is refused while the user is the only manager of an organization (TULA-124).
   */
  deleteUser: (tenant: OrganizationSuiteTenant, userId: string) => Promise<DeleteUserOutcome>
  /** Make a throwaway user of a sign-in test (the reserved address, ADR 0058); returns its id. */
  testUser: (tenant: OrganizationSuiteTenant) => Promise<string>
  /**
   * Run the retention job's purge of sign-in test users over a tenant, as if every one were old
   * enough, and return how many were deleted.
   */
  purgeTestUsers: (tenant: OrganizationSuiteTenant, limit?: number) => Promise<number>
  a: OrganizationSuiteTenant
  b: OrganizationSuiteTenant
}

/** The audit entry of a user's deletion, for the purge of sign-in test users the suite runs. */
export function userDeletion(tenant: OrganizationSuiteTenant, userId: string): Activity {
  return Audit.entry(
    { ids: { next: () => Bun.randomUUIDv7() }, clock: { now: () => new Date() } },
    tenant,
    {
      type: 'user.deleted',
      actor: { type: 'admin', id: null, ipAddress: null, userAgent: null },
      target: { type: 'user', id: userId },
    }
  )
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
      version: 1,
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
    | 'organization_role.created'
    | 'organization_role.updated'
    | 'organization_role.deleted'
    | 'organization_invitation.created'
    | 'organization_invitation.accepted'
    | 'organization_invitation.declined'
    | 'organization_invitation.revoked'

  /** An activity of the given type, about the given id, with data that passes the contract. */
  function activity(tenant: OrganizationSuiteTenant, type: Type, id: string): Activity {
    const scope = { projectId: tenant.projectId, environmentId: tenant.environmentId }
    const deps = { ids: { next: () => Bun.randomUUIDv7() }, clock: { now: () => now } }
    const actor = { type: 'admin', id: null, ipAddress: null, userAgent: null } as const
    const user = Bun.randomUUIDv7()
    const orgTarget = { type: 'organization', id } as const
    const memberTarget = { type: 'organization_membership', id } as const
    const roleTarget = { type: 'organization_role', id } as const
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
      case 'organization_role.created':
        return Audit.entry(deps, scope, {
          type,
          actor,
          target: roleTarget,
          data: { role: 'billing', permissions: 1 },
        })
      case 'organization_role.updated':
        return Audit.entry(deps, scope, {
          type,
          actor,
          target: roleTarget,
          data: { role: 'billing', changed: ['permissions'], permissions: 2 },
        })
      case 'organization_role.deleted':
        return Audit.entry(deps, scope, {
          type,
          actor,
          target: roleTarget,
          data: { role: 'billing' },
        })
      case 'organization_invitation.created':
      case 'organization_invitation.revoked':
        return Audit.entry(deps, scope, {
          type,
          actor,
          target: { type: 'organization_invitation', id },
          data: { organizationId: id, role: 'member' },
        })
      case 'organization_invitation.accepted':
      case 'organization_invitation.declined':
        return Audit.entry(deps, scope, {
          type,
          actor,
          target: { type: 'organization_invitation', id },
          data: { organizationId: id, role: 'member', userId: user },
        })
    }
  }

  const inAWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)

  /** An invitation of a tenant's organization, not stored yet. */
  function invitation(
    tenant: OrganizationSuiteTenant,
    org: OrganizationRecord,
    overrides: Partial<InvitationRecord> = {}
  ): InvitationRecord {
    return {
      id: Bun.randomUUIDv7(),
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      organizationId: org.id,
      email: 'Ada@Example.com',
      emailNormalized: 'ada@example.com',
      roleKey: 'member',
      tokenHash: Bun.randomUUIDv7().replaceAll('-', ''),
      status: 'pending',
      invitedBy: null,
      expiresAt: inAWeek,
      resolvedAt: null,
      resolvedBy: null,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    }
  }

  /** Store an invitation, failing the test if it was not stored. */
  async function invited(
    tenant: OrganizationSuiteTenant,
    org: OrganizationRecord,
    overrides: Partial<InvitationRecord> = {}
  ): Promise<InvitationRecord> {
    const record = invitation(tenant, org, overrides)
    const result = await ctx.store.insertInvitation(
      record,
      now,
      activity(tenant, 'organization_invitation.created', org.id)
    )
    if (result.outcome !== 'created') {
      throw new Error(`the invitation was not stored: ${result.outcome}`)
    }
    return result.record
  }

  /** A custom role of a tenant, not stored yet. */
  function customRole(
    tenant: OrganizationSuiteTenant,
    overrides: Partial<OrganizationRoleRecord> = {}
  ): OrganizationRoleRecord {
    return {
      id: Bun.randomUUIDv7(),
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      key: 'billing',
      name: 'Billing',
      permissions: ['org:billing:read'],
      builtIn: false,
      version: 1,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    }
  }

  /** Store a custom role, failing the test if it was not stored. */
  async function storedRole(
    tenant: OrganizationSuiteTenant,
    overrides: Partial<OrganizationRoleRecord> = {}
  ): Promise<OrganizationRoleRecord> {
    const record = customRole(tenant, overrides)
    const row = await ctx.store.insertRole(
      record,
      activity(tenant, 'organization_role.created', record.id)
    )
    if (!row) {
      throw new Error('the role was not stored')
    }
    return row
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

    test('searches a name or a slug by prefix, ignoring case, with the total of the match', async () => {
      const acme = await stored(organization(ctx.a, { name: 'Acme Corp', slug: 'acme' }))
      const apex = await stored(
        organization(ctx.a, { name: 'Zeta', slug: 'apex', createdAt: later, updatedAt: later })
      )
      await stored(organization(ctx.a, { name: 'Other', slug: 'other' }))
      await stored(organization(ctx.b, { name: 'Acme Foreign', slug: 'acme' }))
      const env = ctx.a.environmentId
      expect(await ctx.store.list(env, { page: 1, size: 10, q: 'ac' })).toEqual({
        records: [acme],
        total: 1,
      })
      expect(await ctx.store.list(env, { page: 1, size: 10, q: 'ACME C' })).toEqual({
        records: [acme],
        total: 1,
      })
      expect((await ctx.store.list(env, { page: 1, size: 10, q: 'a' })).records).toEqual([
        apex,
        acme,
      ])
      // A prefix, not a substring.
      expect((await ctx.store.list(env, { page: 1, size: 10, q: 'cme' })).total).toBe(0)
      // Paging applies to the match.
      expect(await ctx.store.list(env, { page: 2, size: 1, q: 'a' })).toEqual({
        records: [acme],
        total: 2,
      })
    })

    test('a non-ASCII name is found by a prefix in either case', async () => {
      const unal = await stored(organization(ctx.a, { name: 'Ünal Works', slug: 'unal' }))
      const env = ctx.a.environmentId
      for (const q of ['ÜN', 'ün']) {
        expect(await ctx.store.list(env, { page: 1, size: 10, q })).toEqual({
          records: [unal],
          total: 1,
        })
      }
    })

    test('LIKE wildcards in a search term match themselves only', async () => {
      await stored(organization(ctx.a, { name: 'Acme', slug: 'acme' }))
      await stored(organization(ctx.a, { name: '100% Real', slug: 'real' }))
      await stored(organization(ctx.a, { name: 'a_b', slug: 'ab-under' }))
      const env = ctx.a.environmentId
      for (const q of ['%', '_', 'a%', '\\', '%cme']) {
        const found = await ctx.store.list(env, { page: 1, size: 10, q })
        expect(found.records.map((one) => one.name)).not.toContain('Acme')
      }
      expect((await ctx.store.list(env, { page: 1, size: 10, q: '100%' })).total).toBe(1)
      expect((await ctx.store.list(env, { page: 1, size: 10, q: 'a_' })).total).toBe(1)
      expect((await ctx.store.list(env, { page: 1, size: 10, q: '%' })).total).toBe(0)
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

    test('lists the members whose role holds a permission, oldest first, bounded, and none of another environment', async () => {
      const record = await stored(organization(ctx.a))
      const { admin, member } = await builtIns(ctx.a)
      const first = await join(ctx.a, record, admin, { createdAt: new Date(now.getTime() - 2000) })
      await join(ctx.a, record, member)
      const third = await join(ctx.a, record, admin, { createdAt: new Date(now.getTime() - 1000) })
      const key = 'org:sys:domains:manage'
      expect(
        await ctx.store.listMembersWithPermission(ctx.a.environmentId, record.id, key, 10)
      ).toEqual([first.userId, third.userId])
      expect(
        await ctx.store.listMembersWithPermission(ctx.a.environmentId, record.id, key, 1)
      ).toEqual([first.userId])
      expect(
        await ctx.store.listMembersWithPermission(
          ctx.a.environmentId,
          record.id,
          'org:sys:nothing',
          10
        )
      ).toEqual([])
      expect(
        await ctx.store.listMembersWithPermission(ctx.b.environmentId, record.id, key, 10)
      ).toEqual([])
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

    test('a user who is the only manager of an organization is not deleted, and keeps their membership', async () => {
      const first = await stored(organization(ctx.a, { slug: 'first' }))
      const second = await stored(organization(ctx.a, { slug: 'second' }))
      const fine = await stored(organization(ctx.a, { slug: 'fine' }))
      const { admin, member } = await builtIns(ctx.a)
      const sole = await join(ctx.a, first, admin)
      await join(ctx.a, first, member)
      await join(ctx.a, second, admin, { userId: sole.userId })
      // In a third organization another manager exists, so it does not count.
      await join(ctx.a, fine, admin, { userId: sole.userId })
      await join(ctx.a, fine, admin)
      const before = await ctx.recorded()
      expect(await ctx.deleteUser(ctx.a, sole.userId)).toEqual({
        outcome: 'last_manager',
        organizationIds: [first.id, second.id].sort(),
      })
      expect(await ctx.recorded()).toEqual(before)
      for (const record of [first, second, fine]) {
        expect(
          await ctx.store.findMembership(ctx.a.environmentId, record.id, sole.userId)
        ).not.toBeNull()
      }
    })

    test('once another manager exists, or the organization is gone, the user is deleted', async () => {
      const record = await stored(organization(ctx.a))
      const { admin } = await builtIns(ctx.a)
      const sole = await join(ctx.a, record, admin)
      expect((await ctx.deleteUser(ctx.a, sole.userId)).outcome).toBe('last_manager')
      const other = await join(ctx.a, record, admin)
      expect(await ctx.deleteUser(ctx.a, sole.userId)).toEqual({ outcome: 'deleted' })
      expect(await ctx.store.findMembership(ctx.a.environmentId, record.id, sole.userId)).toBe(null)
      // The other is now the only manager.
      expect((await ctx.deleteUser(ctx.a, other.userId)).outcome).toBe('last_manager')
      expect(
        await ctx.store.delete(
          ctx.a.environmentId,
          record.id,
          activity(ctx.a, 'organization.deleted', record.id)
        )
      ).toBe(true)
      expect(await ctx.deleteUser(ctx.a, other.userId)).toEqual({ outcome: 'deleted' })
    })

    test('a user who manages no organization is deleted as before', async () => {
      const record = await stored(organization(ctx.a))
      const { admin, member } = await builtIns(ctx.a)
      await join(ctx.a, record, admin)
      const plain = await join(ctx.a, record, member)
      expect(await ctx.deleteUser(ctx.a, plain.userId)).toEqual({ outcome: 'deleted' })
      const loner = await ctx.user(ctx.a)
      expect(await ctx.deleteUser(ctx.a, loner)).toEqual({ outcome: 'deleted' })
      expect(await ctx.deleteUser(ctx.a, loner)).toEqual({ outcome: 'not_found' })
    })

    test('the purge of sign-in test users leaves the only manager of an organization and deletes the rest', async () => {
      const record = await stored(organization(ctx.a))
      const { admin, member } = await builtIns(ctx.a)
      const keeper = await join(ctx.a, record, admin, { userId: await ctx.testUser(ctx.a) })
      const plain = await join(ctx.a, record, member, { userId: await ctx.testUser(ctx.a) })
      const loner = await ctx.testUser(ctx.a)
      expect(await ctx.purgeTestUsers(ctx.a)).toBe(2)
      expect(await ctx.store.findMembership(ctx.a.environmentId, record.id, keeper.userId)).toEqual(
        keeper
      )
      expect(await ctx.store.findMembership(ctx.a.environmentId, record.id, plain.userId)).toBe(
        null
      )
      // Once the organization has another manager the next round deletes them too.
      await join(ctx.a, record, admin)
      expect(await ctx.purgeTestUsers(ctx.a)).toBe(1)
      expect(await ctx.deleteUser(ctx.a, loner)).toEqual({ outcome: 'not_found' })
    })

    test('the purge reaches past test users it must leave, so they cannot starve the rest', async () => {
      const { admin } = await builtIns(ctx.a)
      for (const slug of ['one', 'two']) {
        const record = await stored(organization(ctx.a, { slug }))
        await join(ctx.a, record, admin, { userId: await ctx.testUser(ctx.a) })
      }
      const free = await ctx.testUser(ctx.a)
      // The batch is two: both places go to users that stay, and the free one is still reached.
      expect(await ctx.purgeTestUsers(ctx.a, 2)).toBe(1)
      expect(await ctx.deleteUser(ctx.a, free)).toEqual({ outcome: 'not_found' })
    })

    test('of the deletion of one manager and the demotion of the other at once exactly one is made', async () => {
      const record = await stored(organization(ctx.a))
      const { admin, member } = await builtIns(ctx.a)
      const first = await join(ctx.a, record, admin)
      const second = await join(ctx.a, record, admin)
      const [deleted, demoted] = await Promise.all([
        ctx.deleteUser(ctx.a, first.userId),
        ctx.store.changeRole(
          ctx.a.environmentId,
          record.id,
          second.userId,
          admin.id,
          member,
          later,
          activity(ctx.a, 'organization_membership.role_changed', second.id)
        ),
      ])
      // Whichever took the organization's lock first is made; the other is refused.
      expect(['deleted last_manager', 'last_manager done']).toContain(
        `${deleted.outcome} ${demoted.outcome}`
      )
      const managers = await ctx.store.listMemberships(ctx.a.environmentId, record.id, {
        page: 1,
        size: 10,
      })
      expect(managers.records.filter((one) => one.roleKey === 'admin').length).toBe(1)
    })

    test('of the deletions of the last two managers at once exactly one is made', async () => {
      const record = await stored(organization(ctx.a))
      const { admin } = await builtIns(ctx.a)
      const first = await join(ctx.a, record, admin)
      const second = await join(ctx.a, record, admin)
      const results = await Promise.all([
        ctx.deleteUser(ctx.a, first.userId),
        ctx.deleteUser(ctx.a, second.userId),
      ])
      expect(results.map((result) => result.outcome).sort()).toEqual(['deleted', 'last_manager'])
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

    test('stores a custom role at version 1, reads it back by key and by id and records it', async () => {
      const record = customRole(ctx.a)
      expect(
        await ctx.store.insertRole(record, activity(ctx.a, 'organization_role.created', record.id))
      ).toEqual(record)
      expect(await ctx.store.findRole(ctx.a.environmentId, 'billing')).toEqual(record)
      expect(await ctx.store.findRoleById(ctx.a.environmentId, record.id)).toEqual(record)
      expect((await ctx.store.listRoles(ctx.a.environmentId)).map((role) => role.key)).toEqual([
        'billing',
      ])
      expect(await ctx.recorded()).toEqual(['organization_role.created'])
    })

    test('lists the built-in roles first, then the custom ones by key', async () => {
      await builtIns(ctx.a)
      await storedRole(ctx.a, { key: 'zeta' })
      await storedRole(ctx.a, { key: 'alpha' })
      expect((await ctx.store.listRoles(ctx.a.environmentId)).map((role) => role.key)).toEqual([
        'admin',
        'member',
        'alpha',
        'zeta',
      ])
    })

    test('a role key is unique in an environment: a second is not stored and not recorded', async () => {
      await storedRole(ctx.a)
      const again = customRole(ctx.a, { name: 'Other' })
      expect(
        await ctx.store.insertRole(again, activity(ctx.a, 'organization_role.created', again.id))
      ).toBeNull()
      expect(await ctx.recorded()).toEqual(['organization_role.created'])
    })

    test('the same key in another environment is another role', async () => {
      const mine = await storedRole(ctx.a)
      const theirs = await storedRole(ctx.b)
      expect(mine.id).not.toBe(theirs.id)
      expect(await ctx.store.findRole(ctx.b.environmentId, 'billing')).toEqual(theirs)
      expect(await ctx.store.findRoleById(ctx.a.environmentId, theirs.id)).toBeNull()
    })

    test('a custom role cannot take the key of a built-in one', async () => {
      const taken = customRole(ctx.a, { key: 'admin' })
      expect(
        await ctx.store.insertRole(taken, activity(ctx.a, 'organization_role.created', taken.id))
      ).toBeNull()
      expect(await ctx.store.listRoles(ctx.a.environmentId)).toEqual([])
      expect(await ctx.recorded()).toEqual([])
    })

    test('of two definitions of one key at once exactly one is stored', async () => {
      const [one, two] = [customRole(ctx.a), customRole(ctx.a)]
      const rows = await Promise.all([
        ctx.store.insertRole(one, activity(ctx.a, 'organization_role.created', one.id)),
        ctx.store.insertRole(two, activity(ctx.a, 'organization_role.created', two.id)),
      ])
      expect(rows.filter((row) => row !== null)).toHaveLength(1)
      expect(await ctx.recorded()).toEqual(['organization_role.created'])
    })

    test('an update sets the name and the permissions, bumps the version and is recorded', async () => {
      const role = await storedRole(ctx.a)
      const result = await ctx.store.updateRole(
        ctx.a.environmentId,
        role.id,
        1,
        { name: 'Billing team', permissions: ['org:billing:read', 'org:billing:write'] },
        later,
        activity(ctx.a, 'organization_role.updated', role.id)
      )
      expect(result).toEqual({
        outcome: 'updated',
        record: {
          ...role,
          name: 'Billing team',
          permissions: ['org:billing:read', 'org:billing:write'],
          version: 2,
          updatedAt: later,
        },
      })
      expect(await ctx.store.findRole(ctx.a.environmentId, 'billing')).toMatchObject({
        version: 2,
        permissions: ['org:billing:read', 'org:billing:write'],
      })
      expect(await ctx.recorded()).toEqual([
        'organization_role.created',
        'organization_role.updated',
      ])
    })

    test('an update leaves the fields it does not name as they are', async () => {
      const role = await storedRole(ctx.a)
      await ctx.store.updateRole(
        ctx.a.environmentId,
        role.id,
        1,
        { name: 'Renamed' },
        later,
        activity(ctx.a, 'organization_role.updated', role.id)
      )
      expect(await ctx.store.findRole(ctx.a.environmentId, 'billing')).toMatchObject({
        name: 'Renamed',
        permissions: ['org:billing:read'],
        key: 'billing',
      })
    })

    test('an update over a version that moved is stale: not written, not recorded', async () => {
      const role = await storedRole(ctx.a)
      await ctx.store.updateRole(
        ctx.a.environmentId,
        role.id,
        1,
        { name: 'First' },
        later,
        activity(ctx.a, 'organization_role.updated', role.id)
      )
      expect(
        await ctx.store.updateRole(
          ctx.a.environmentId,
          role.id,
          1,
          { name: 'Second' },
          later,
          activity(ctx.a, 'organization_role.updated', role.id)
        )
      ).toEqual({ outcome: 'stale', version: 2 })
      expect(await ctx.store.findRole(ctx.a.environmentId, 'billing')).toMatchObject({
        name: 'First',
        version: 2,
      })
      expect(await ctx.recorded()).toEqual([
        'organization_role.created',
        'organization_role.updated',
      ])
    })

    test('of two updates over one version at once exactly one is written', async () => {
      const role = await storedRole(ctx.a)
      const change = (name: string) =>
        ctx.store.updateRole(
          ctx.a.environmentId,
          role.id,
          1,
          { name },
          later,
          activity(ctx.a, 'organization_role.updated', role.id)
        )
      const results = await Promise.all([change('One'), change('Two')])
      expect(results.map((result) => result.outcome).sort()).toEqual(['stale', 'updated'])
      expect(await ctx.store.findRole(ctx.a.environmentId, 'billing')).toMatchObject({
        version: 2,
      })
    })

    test('a built-in role is never updated or deleted, and nothing is recorded', async () => {
      const { admin, member } = await builtIns(ctx.a)
      for (const role of [admin, member]) {
        expect(
          await ctx.store.updateRole(
            ctx.a.environmentId,
            role.id,
            1,
            { permissions: [] },
            later,
            activity(ctx.a, 'organization_role.updated', role.id)
          )
        ).toEqual({ outcome: 'built_in' })
        expect(
          await ctx.store.deleteRole(
            ctx.a.environmentId,
            role.id,
            null,
            activity(ctx.a, 'organization_role.deleted', role.id)
          )
        ).toEqual({ outcome: 'built_in' })
      }
      expect(await ctx.store.findRole(ctx.a.environmentId, 'admin')).toEqual(admin)
      expect(await ctx.store.findRole(ctx.a.environmentId, 'member')).toEqual(member)
      expect(await ctx.recorded()).toEqual([])
    })

    test('a role of another environment is never updated or deleted', async () => {
      const theirs = await storedRole(ctx.b)
      expect(
        await ctx.store.updateRole(
          ctx.a.environmentId,
          theirs.id,
          1,
          { name: 'Taken over' },
          later,
          activity(ctx.a, 'organization_role.updated', theirs.id)
        )
      ).toEqual({ outcome: 'not_found' })
      expect(
        await ctx.store.deleteRole(
          ctx.a.environmentId,
          theirs.id,
          null,
          activity(ctx.a, 'organization_role.deleted', theirs.id)
        )
      ).toEqual({ outcome: 'not_found' })
      expect(await ctx.store.findRole(ctx.b.environmentId, 'billing')).toEqual(theirs)
      expect(await ctx.recorded()).toEqual([])
    })

    test('a role that no member holds is deleted and recorded', async () => {
      const role = await storedRole(ctx.a)
      expect(
        await ctx.store.deleteRole(
          ctx.a.environmentId,
          role.id,
          1,
          activity(ctx.a, 'organization_role.deleted', role.id)
        )
      ).toEqual({ outcome: 'deleted', record: role })
      expect(await ctx.store.findRole(ctx.a.environmentId, 'billing')).toBeNull()
      expect(await ctx.recorded()).toEqual([
        'organization_role.created',
        'organization_role.deleted',
      ])
    })

    test('a deletion over a version that moved is stale and deletes nothing', async () => {
      const role = await storedRole(ctx.a)
      expect(
        await ctx.store.deleteRole(
          ctx.a.environmentId,
          role.id,
          7,
          activity(ctx.a, 'organization_role.deleted', role.id)
        )
      ).toEqual({ outcome: 'stale', version: 1 })
      expect(await ctx.store.findRole(ctx.a.environmentId, 'billing')).toEqual(role)
      expect(await ctx.recorded()).toEqual(['organization_role.created'])
    })

    test('a role that a member holds, in any organization, is not deleted', async () => {
      const record = await stored(organization(ctx.a))
      const role = await storedRole(ctx.a)
      const held = await join(ctx.a, record, role)
      expect(
        await ctx.store.deleteRole(
          ctx.a.environmentId,
          role.id,
          null,
          activity(ctx.a, 'organization_role.deleted', role.id)
        )
      ).toEqual({ outcome: 'in_use' })
      expect(await ctx.store.findRole(ctx.a.environmentId, 'billing')).toEqual(role)
      expect(await ctx.recorded()).toEqual([
        'organization.created',
        'organization_role.created',
        'organization_membership.added',
      ])
      // Once nobody holds it, it can go.
      const { admin } = await builtIns(ctx.a)
      await join(ctx.a, record, admin)
      await ctx.store.removeMembership(
        ctx.a.environmentId,
        record.id,
        held.userId,
        role.id,
        activity(ctx.a, 'organization_membership.removed', held.id)
      )
      expect(
        (
          await ctx.store.deleteRole(
            ctx.a.environmentId,
            role.id,
            null,
            activity(ctx.a, 'organization_role.deleted', role.id)
          )
        ).outcome
      ).toBe('deleted')
    })

    test('a role change reaches members through the role: nothing is copied into the membership', async () => {
      const record = await stored(organization(ctx.a))
      const role = await storedRole(ctx.a)
      const member = await join(ctx.a, record, role)
      await ctx.store.updateRole(
        ctx.a.environmentId,
        role.id,
        1,
        { permissions: ['org:billing:read', 'org:billing:write'] },
        later,
        activity(ctx.a, 'organization_role.updated', role.id)
      )
      const seen = await ctx.store.findMembership(ctx.a.environmentId, record.id, member.userId)
      expect(seen).toEqual(member)
      expect(Object.keys(seen ?? {})).not.toContain('permissions')
      expect(await ctx.store.findRoleById(ctx.a.environmentId, seen?.roleId ?? '')).toMatchObject({
        permissions: ['org:billing:read', 'org:billing:write'],
      })
    })

    test('permissions cannot be taken from the only role that manages an organization’s members', async () => {
      const record = await stored(organization(ctx.a))
      const owner = await storedRole(ctx.a, {
        key: 'owner',
        permissions: ['org:billing:read', 'org:sys:memberships:manage'],
      })
      await join(ctx.a, record, owner)
      expect(
        await ctx.store.updateRole(
          ctx.a.environmentId,
          owner.id,
          1,
          { permissions: ['org:billing:read'] },
          later,
          activity(ctx.a, 'organization_role.updated', owner.id)
        )
      ).toEqual({ outcome: 'last_manager' })
      expect(await ctx.store.findRole(ctx.a.environmentId, 'owner')).toEqual(owner)
      // Other permissions of the same role may change, and the manage permission may stay.
      expect(
        (
          await ctx.store.updateRole(
            ctx.a.environmentId,
            owner.id,
            1,
            { permissions: ['org:sys:memberships:manage'] },
            later,
            activity(ctx.a, 'organization_role.updated', owner.id)
          )
        ).outcome
      ).toBe('updated')
      expect(await ctx.recorded()).toEqual([
        'organization.created',
        'organization_role.created',
        'organization_membership.added',
        'organization_role.updated',
      ])
    })

    test('with another manager in every organization the role is used in, its permission can go', async () => {
      const covered = await stored(organization(ctx.a, { slug: 'covered' }))
      const { admin } = await builtIns(ctx.a)
      const owner = await storedRole(ctx.a, {
        key: 'owner',
        permissions: ['org:sys:memberships:manage'],
      })
      await join(ctx.a, covered, owner)
      await join(ctx.a, covered, admin)
      expect(
        (
          await ctx.store.updateRole(
            ctx.a.environmentId,
            owner.id,
            1,
            { permissions: [] },
            later,
            activity(ctx.a, 'organization_role.updated', owner.id)
          )
        ).outcome
      ).toBe('updated')
    })

    test('one organization without another manager refuses the change for all of them', async () => {
      const covered = await stored(organization(ctx.a, { slug: 'covered' }))
      const alone = await stored(organization(ctx.a, { slug: 'alone' }))
      const { admin } = await builtIns(ctx.a)
      const owner = await storedRole(ctx.a, {
        key: 'owner',
        permissions: ['org:sys:memberships:manage'],
      })
      await join(ctx.a, covered, owner)
      await join(ctx.a, covered, admin)
      await join(ctx.a, alone, owner)
      expect(
        await ctx.store.updateRole(
          ctx.a.environmentId,
          owner.id,
          1,
          { permissions: [] },
          later,
          activity(ctx.a, 'organization_role.updated', owner.id)
        )
      ).toEqual({ outcome: 'last_manager' })
      expect(await ctx.store.findRole(ctx.a.environmentId, 'owner')).toEqual(owner)
    })

    test('a role nobody holds loses its manage permission freely', async () => {
      const owner = await storedRole(ctx.a, {
        key: 'owner',
        permissions: ['org:sys:memberships:manage'],
      })
      expect(
        (
          await ctx.store.updateRole(
            ctx.a.environmentId,
            owner.id,
            1,
            { permissions: [] },
            later,
            activity(ctx.a, 'organization_role.updated', owner.id)
          )
        ).outcome
      ).toBe('updated')
    })

    test('stripping a role of the manage permission and demoting the other manager at once leaves a manager', async () => {
      const record = await stored(organization(ctx.a))
      const { admin, member } = await builtIns(ctx.a)
      const owner = await storedRole(ctx.a, {
        key: 'owner',
        permissions: ['org:sys:memberships:manage'],
      })
      await join(ctx.a, record, owner)
      const other = await join(ctx.a, record, admin)
      const [stripped, demoted] = await Promise.all([
        ctx.store.updateRole(
          ctx.a.environmentId,
          owner.id,
          1,
          { permissions: [] },
          later,
          activity(ctx.a, 'organization_role.updated', owner.id)
        ),
        ctx.store.changeRole(
          ctx.a.environmentId,
          record.id,
          other.userId,
          admin.id,
          member,
          later,
          activity(ctx.a, 'organization_membership.role_changed', other.id)
        ),
      ])
      // Whichever came second saw what the first had done: they cannot both succeed.
      const pair = `${stripped.outcome}/${demoted.outcome}`
      expect(['updated/last_manager', 'last_manager/done']).toContain(pair)
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

    /** What `insertOwned` is handed for a user who creates an organization with `role`. */
    function owned(
      tenant: OrganizationSuiteTenant,
      userId: string,
      role: OrganizationRoleRecord,
      overrides: Partial<OrganizationRecord> = {},
      limit: number | null = null
    ) {
      const org = organization(tenant, { createdBy: userId, ...overrides })
      const membership: MembershipRecord = {
        id: Bun.randomUUIDv7(),
        projectId: tenant.projectId,
        environmentId: tenant.environmentId,
        organizationId: org.id,
        userId,
        roleId: role.id,
        roleKey: role.key,
        createdAt: now,
        updatedAt: now,
      }
      return {
        input: { organization: org, membership, permissions: role.permissions, limit },
        activities: {
          organization: activity(tenant, 'organization.created', org.id),
          membership: activity(tenant, 'organization_membership.added', membership.id),
        },
      }
    }

    test('a user creates an organization and becomes its member in one write, and both are recorded', async () => {
      const { admin } = await builtIns(ctx.a)
      const userId = await ctx.user(ctx.a)
      const { input, activities } = owned(ctx.a, userId, admin)
      const result = await ctx.store.insertOwned(input, activities)
      expect(result).toEqual({
        outcome: 'created',
        record: {
          organization: input.organization,
          membership: input.membership,
          permissions: admin.permissions,
        },
      })
      expect(await ctx.store.find(ctx.a.environmentId, input.organization.id)).toEqual(
        input.organization
      )
      expect(
        await ctx.store.findUserMembership(ctx.a.environmentId, input.organization.id, userId)
      ).toEqual({
        organization: input.organization,
        membership: input.membership,
        permissions: admin.permissions,
      })
      expect(await ctx.recorded()).toEqual([
        'organization.created',
        'organization_membership.added',
      ])
    })

    test('a slug an organization has is slug_taken and leaves no organization, no member and no entry', async () => {
      const { admin } = await builtIns(ctx.a)
      await stored(organization(ctx.a))
      const userId = await ctx.user(ctx.a)
      const { input, activities } = owned(ctx.a, userId, admin)
      expect(await ctx.store.insertOwned(input, activities)).toEqual({ outcome: 'slug_taken' })
      expect(await ctx.store.find(ctx.a.environmentId, input.organization.id)).toBeNull()
      expect(
        await ctx.store.findUserMembership(ctx.a.environmentId, input.organization.id, userId)
      ).toBeNull()
      expect(await ctx.recorded()).toEqual(['organization.created'])
    })

    test('the limit counts what the user created, and not what others did', async () => {
      const { admin } = await builtIns(ctx.a)
      const userId = await ctx.user(ctx.a)
      const other = await ctx.user(ctx.a)
      const first = owned(ctx.a, userId, admin, { slug: 'one' }, 1)
      expect((await ctx.store.insertOwned(first.input, first.activities)).outcome).toBe('created')
      const theirs = owned(ctx.a, other, admin, { slug: 'theirs' }, 1)
      expect((await ctx.store.insertOwned(theirs.input, theirs.activities)).outcome).toBe('created')
      const second = owned(ctx.a, userId, admin, { slug: 'two' }, 1)
      expect(await ctx.store.insertOwned(second.input, second.activities)).toEqual({
        outcome: 'limit_reached',
      })
      expect(await ctx.store.find(ctx.a.environmentId, second.input.organization.id)).toBeNull()
      // No limit: as many as are asked for.
      const free = owned(ctx.a, userId, admin, { slug: 'three' }, null)
      expect((await ctx.store.insertOwned(free.input, free.activities)).outcome).toBe('created')
      expect(await ctx.recorded()).toHaveLength(6)
    })

    test('of two creations by one user at the limit exactly one is made', async () => {
      const { admin } = await builtIns(ctx.a)
      const userId = await ctx.user(ctx.a)
      const one = owned(ctx.a, userId, admin, { slug: 'one' }, 1)
      const two = owned(ctx.a, userId, admin, { slug: 'two' }, 1)
      const results = await Promise.all([
        ctx.store.insertOwned(one.input, one.activities),
        ctx.store.insertOwned(two.input, two.activities),
      ])
      expect(results.map((result) => result.outcome).sort()).toEqual(['created', 'limit_reached'])
      expect(await ctx.recorded()).toHaveLength(2)
    })

    test('a user that does not exist is gone and nothing is stored', async () => {
      const { admin } = await builtIns(ctx.a)
      const { input, activities } = owned(ctx.a, Bun.randomUUIDv7(), admin)
      expect(await ctx.store.insertOwned(input, activities)).toEqual({ outcome: 'gone' })
      expect(await ctx.store.find(ctx.a.environmentId, input.organization.id)).toBeNull()
      expect(await ctx.recorded()).toEqual([])
    })

    test('a user’s memberships are listed oldest first with their role’s permissions, a page at a time', async () => {
      const { admin, member } = await builtIns(ctx.a)
      const userId = await ctx.user(ctx.a)
      const first = await stored(organization(ctx.a, { slug: 'first' }))
      const second = await stored(organization(ctx.a, { slug: 'second' }))
      const third = await stored(organization(ctx.a, { slug: 'third' }))
      await join(ctx.a, first, member, { userId, createdAt: now })
      await join(ctx.a, second, admin, { userId, createdAt: later })
      // Another user's membership is not listed.
      await join(ctx.a, third, admin)
      const all = await ctx.store.listUserMemberships(ctx.a.environmentId, userId, {
        page: 1,
        size: 10,
      })
      expect(all.total).toBe(2)
      expect(all.records.map((row) => [row.organization.slug, row.membership.roleKey])).toEqual([
        ['first', 'member'],
        ['second', 'admin'],
      ])
      expect(all.records.map((row) => row.permissions)).toEqual([
        member.permissions,
        admin.permissions,
      ])
      const paged = await ctx.store.listUserMemberships(ctx.a.environmentId, userId, {
        page: 2,
        size: 1,
      })
      expect(paged.total).toBe(2)
      expect(paged.records.map((row) => row.organization.slug)).toEqual(['second'])
      // Nothing of another environment is seen.
      expect(
        await ctx.store.listUserMemberships(ctx.b.environmentId, userId, { page: 1, size: 10 })
      ).toEqual({ records: [], total: 0 })
    })

    test('a membership is found for its user only, and in its environment only', async () => {
      const { member } = await builtIns(ctx.a)
      const record = await stored(organization(ctx.a))
      const joined = await join(ctx.a, record, member)
      expect(
        (await ctx.store.findUserMembership(ctx.a.environmentId, record.id, joined.userId))
          ?.membership
      ).toEqual(joined)
      expect(
        await ctx.store.findUserMembership(ctx.a.environmentId, record.id, Bun.randomUUIDv7())
      ).toBeNull()
      expect(
        await ctx.store.findUserMembership(ctx.b.environmentId, record.id, joined.userId)
      ).toBeNull()
    })

    describe('invitations', () => {
      async function setup2() {
        const roleSet = await builtIns(ctx.a)
        const org = await stored(organization(ctx.a))
        return { ...roleSet, org }
      }

      test('stores an invitation, finds it by id and by token hash, and records it', async () => {
        const { org } = await setup2()
        const record = await invited(ctx.a, org)
        expect(record).toEqual(
          invitation(ctx.a, org, { id: record.id, tokenHash: record.tokenHash })
        )
        expect(await ctx.store.findInvitation(ctx.a.environmentId, org.id, record.id)).toEqual(
          record
        )
        expect(
          await ctx.store.findInvitationByTokenHash(ctx.a.environmentId, record.tokenHash)
        ).toEqual(record)
        expect(await ctx.recorded()).toContain('organization_invitation.created')
      })

      test('an invitation is found in its own environment and its own organization only', async () => {
        const { org } = await setup2()
        const other = await stored(organization(ctx.a, { slug: 'other' }))
        const record = await invited(ctx.a, org)
        expect(await ctx.store.findInvitation(ctx.a.environmentId, other.id, record.id)).toBeNull()
        expect(await ctx.store.findInvitation(ctx.b.environmentId, org.id, record.id)).toBeNull()
        expect(
          await ctx.store.findInvitationByTokenHash(ctx.b.environmentId, record.tokenHash)
        ).toBeNull()
        expect(await ctx.store.findInvitationByTokenHash(ctx.a.environmentId, 'nope')).toBeNull()
      })

      test('finds an invitation by id in its own environment only', async () => {
        const { org } = await setup2()
        const record = await invited(ctx.a, org)
        expect(await ctx.store.findInvitationById(ctx.a.environmentId, record.id)).toEqual(record)
        expect(await ctx.store.findInvitationById(ctx.b.environmentId, record.id)).toBeNull()
        expect(
          await ctx.store.findInvitationById(ctx.a.environmentId, Bun.randomUUIDv7())
        ).toBeNull()
      })

      test('lists the pending, unexpired invitations to one address across organizations', async () => {
        const { org } = await setup2()
        const other = await stored(organization(ctx.a, { slug: 'other', name: 'Other Org' }))
        const first = await invited(ctx.a, org)
        const second = await invited(ctx.a, other, { createdAt: new Date(now.getTime() + 1000) })
        // Not listed: another address, a lapsed one, a revoked one, another environment's.
        await invited(ctx.a, org, { email: 'x@example.com', emailNormalized: 'x@example.com' })
        const lapsedOrg = await stored(organization(ctx.a, { slug: 'lapsed-org' }))
        await invited(ctx.a, lapsedOrg, { expiresAt: new Date(now.getTime() + 1000) })
        const revokedOrg = await stored(organization(ctx.a, { slug: 'revoked-org' }))
        const revoked = await invited(ctx.a, revokedOrg)
        await ctx.store.revokeInvitation(
          ctx.a.environmentId,
          revokedOrg.id,
          revoked.id,
          now,
          activity(ctx.a, 'organization_invitation.revoked', revokedOrg.id)
        )
        const at = new Date(now.getTime() + 5000)
        const listed = await ctx.store.listPendingInvitationsForEmail(
          ctx.a.environmentId,
          'ada@example.com',
          at,
          { page: 1, size: 10 }
        )
        expect(listed.total).toBe(2)
        expect(listed.records.map((row) => row.record.id)).toEqual([second.id, first.id])
        expect(listed.records.map((row) => row.organizationName)).toEqual(['Other Org', org.name])
        const paged = await ctx.store.listPendingInvitationsForEmail(
          ctx.a.environmentId,
          'ada@example.com',
          at,
          { page: 2, size: 1 }
        )
        expect(paged.total).toBe(2)
        expect(paged.records.map((row) => row.record.id)).toEqual([first.id])
        expect(
          await ctx.store.listPendingInvitationsForEmail(
            ctx.b.environmentId,
            'ada@example.com',
            at,
            { page: 1, size: 10 }
          )
        ).toEqual({ records: [], total: 0 })
        // Past the expiry nothing is listed.
        const later = new Date(inAWeek.getTime() + 1000)
        expect(
          (
            await ctx.store.listPendingInvitationsForEmail(
              ctx.a.environmentId,
              'ada@example.com',
              later,
              { page: 1, size: 10 }
            )
          ).total
        ).toBe(0)
      })

      test('a second pending invitation to the same address is not stored and not recorded', async () => {
        const { org } = await setup2()
        await invited(ctx.a, org)
        const before = (await ctx.recorded()).length
        const second = invitation(ctx.a, org, { email: ' ADA@example.com ' })
        expect(
          await ctx.store.insertInvitation(
            second,
            now,
            activity(ctx.a, 'organization_invitation.created', org.id)
          )
        ).toEqual({ outcome: 'exists' })
        expect(
          await ctx.store.findInvitationByTokenHash(ctx.a.environmentId, second.tokenHash)
        ).toBeNull()
        expect((await ctx.recorded()).length).toBe(before)
      })

      test('the same address may be invited to another organization and by another environment', async () => {
        const { org } = await setup2()
        const other = await stored(organization(ctx.a, { slug: 'other' }))
        await invited(ctx.a, org)
        await invited(ctx.a, other)
        const foreign = await stored(organization(ctx.b))
        await invited(ctx.b, foreign)
      })

      test('a pending invitation that has expired is replaced by a new one, in one step', async () => {
        const { org } = await setup2()
        const lapsed = await invited(ctx.a, org, { expiresAt: new Date(now.getTime() + 1000) })
        const later_ = new Date(now.getTime() + 2000)
        const fresh = invitation(ctx.a, org, { expiresAt: inAWeek })
        expect(
          await ctx.store.insertInvitation(
            fresh,
            later_,
            activity(ctx.a, 'organization_invitation.created', org.id)
          )
        ).toEqual({ outcome: 'created', record: fresh })
        expect(await ctx.store.findInvitation(ctx.a.environmentId, org.id, lapsed.id)).toBeNull()
      })

      test('an address whose earlier invitation was answered may be invited again', async () => {
        const { org } = await setup2()
        const first = await invited(ctx.a, org)
        await ctx.store.revokeInvitation(
          ctx.a.environmentId,
          org.id,
          first.id,
          now,
          activity(ctx.a, 'organization_invitation.revoked', org.id)
        )
        await invited(ctx.a, org)
      })

      test('an invitation to an organization that does not exist is gone', async () => {
        await setup2()
        const ghost = organization(ctx.a, { slug: 'ghost' })
        expect(
          await ctx.store.insertInvitation(
            invitation(ctx.a, ghost),
            now,
            activity(ctx.a, 'organization_invitation.created', ghost.id)
          )
        ).toEqual({ outcome: 'gone' })
      })

      test('lists pending, expired and answered invitations apart, newest first, a page at a time', async () => {
        const { org } = await setup2()
        const first = await invited(ctx.a, org, {
          email: 'a@example.com',
          emailNormalized: 'a@example.com',
          createdAt: now,
        })
        const second = await invited(ctx.a, org, {
          email: 'b@example.com',
          emailNormalized: 'b@example.com',
          createdAt: later,
        })
        const lapsed = await invited(ctx.a, org, {
          email: 'c@example.com',
          emailNormalized: 'c@example.com',
          expiresAt: new Date(now.getTime() + 1000),
        })
        const revoked = await invited(ctx.a, org, {
          email: 'd@example.com',
          emailNormalized: 'd@example.com',
        })
        await ctx.store.revokeInvitation(
          ctx.a.environmentId,
          org.id,
          revoked.id,
          now,
          activity(ctx.a, 'organization_invitation.revoked', org.id)
        )
        const at = new Date(now.getTime() + 5000)
        const ids = async (status: 'pending' | 'expired' | 'revoked' | 'accepted') =>
          (
            await ctx.store.listInvitations(ctx.a.environmentId, org.id, status, at, {
              page: 1,
              size: 10,
            })
          ).records.map((row) => row.id)
        expect(await ids('pending')).toEqual([second.id, first.id])
        expect(await ids('expired')).toEqual([lapsed.id])
        expect(await ids('revoked')).toEqual([revoked.id])
        expect(await ids('accepted')).toEqual([])
        const paged = await ctx.store.listInvitations(ctx.a.environmentId, org.id, 'pending', at, {
          page: 2,
          size: 1,
        })
        expect(paged.total).toBe(2)
        expect(paged.records.map((row) => row.id)).toEqual([first.id])
        // Nothing of another environment or organization is listed.
        expect(
          await ctx.store.listInvitations(ctx.b.environmentId, org.id, 'pending', at, {
            page: 1,
            size: 10,
          })
        ).toEqual({ records: [], total: 0 })
      })

      test('a revoked invitation is used up: it cannot be revoked, declined or accepted again', async () => {
        const { org, member } = await setup2()
        const record = await invited(ctx.a, org)
        const userId = await ctx.user(ctx.a)
        const done = await ctx.store.revokeInvitation(
          ctx.a.environmentId,
          org.id,
          record.id,
          later,
          activity(ctx.a, 'organization_invitation.revoked', org.id)
        )
        expect(done).toEqual({
          outcome: 'done',
          record: { ...record, status: 'revoked', resolvedAt: later, updatedAt: later },
        })
        const before = (await ctx.recorded()).length
        const gone = {
          outcome: 'unavailable' as const,
          record: (done as { record: InvitationRecord }).record,
        }
        expect(
          await ctx.store.revokeInvitation(
            ctx.a.environmentId,
            org.id,
            record.id,
            later,
            activity(ctx.a, 'organization_invitation.revoked', org.id)
          )
        ).toEqual(gone)
        expect(
          await ctx.store.declineInvitation(
            ctx.a.environmentId,
            record.id,
            userId,
            later,
            activity(ctx.a, 'organization_invitation.declined', org.id)
          )
        ).toEqual(gone)
        const membership: MembershipRecord = {
          id: Bun.randomUUIDv7(),
          projectId: ctx.a.projectId,
          environmentId: ctx.a.environmentId,
          organizationId: org.id,
          userId,
          roleId: member.id,
          roleKey: member.key,
          createdAt: later,
          updatedAt: later,
        }
        expect(
          await ctx.store.acceptInvitation(ctx.a.environmentId, record.id, membership, later, {
            invitation: activity(ctx.a, 'organization_invitation.accepted', org.id),
            membership: activity(ctx.a, 'organization_membership.added', membership.id),
          })
        ).toEqual(gone)
        expect(await ctx.store.findUserMembership(ctx.a.environmentId, org.id, userId)).toBeNull()
        // Nothing was recorded by the refusals.
        expect((await ctx.recorded()).length).toBe(before)
      })

      test('an invitation of another organization or environment cannot be revoked', async () => {
        const { org } = await setup2()
        const other = await stored(organization(ctx.a, { slug: 'other' }))
        const record = await invited(ctx.a, org)
        const activityOf = activity(ctx.a, 'organization_invitation.revoked', org.id)
        expect(
          await ctx.store.revokeInvitation(
            ctx.a.environmentId,
            other.id,
            record.id,
            now,
            activityOf
          )
        ).toEqual({ outcome: 'not_found' })
        expect(
          await ctx.store.revokeInvitation(ctx.b.environmentId, org.id, record.id, now, activityOf)
        ).toEqual({ outcome: 'not_found' })
        expect(
          (await ctx.store.findInvitation(ctx.a.environmentId, org.id, record.id))?.status
        ).toBe('pending')
      })

      test('an expired invitation cannot be revoked, declined or accepted', async () => {
        const { org, member } = await setup2()
        const record = await invited(ctx.a, org, { expiresAt: new Date(now.getTime() + 1000) })
        const userId = await ctx.user(ctx.a)
        const at = new Date(now.getTime() + 2000)
        const expired = { outcome: 'unavailable' as const, record }
        expect(
          await ctx.store.revokeInvitation(
            ctx.a.environmentId,
            org.id,
            record.id,
            at,
            activity(ctx.a, 'organization_invitation.revoked', org.id)
          )
        ).toEqual(expired)
        expect(
          await ctx.store.declineInvitation(
            ctx.a.environmentId,
            record.id,
            userId,
            at,
            activity(ctx.a, 'organization_invitation.declined', org.id)
          )
        ).toEqual(expired)
        const membership: MembershipRecord = {
          id: Bun.randomUUIDv7(),
          projectId: ctx.a.projectId,
          environmentId: ctx.a.environmentId,
          organizationId: org.id,
          userId,
          roleId: member.id,
          roleKey: member.key,
          createdAt: at,
          updatedAt: at,
        }
        expect(
          await ctx.store.acceptInvitation(ctx.a.environmentId, record.id, membership, at, {
            invitation: activity(ctx.a, 'organization_invitation.accepted', org.id),
            membership: activity(ctx.a, 'organization_membership.added', membership.id),
          })
        ).toEqual(expired)
        expect(await ctx.store.findUserMembership(ctx.a.environmentId, org.id, userId)).toBeNull()
      })

      test('declining uses the invitation up and names who declined', async () => {
        const { org } = await setup2()
        const record = await invited(ctx.a, org)
        const userId = await ctx.user(ctx.a)
        expect(
          await ctx.store.declineInvitation(
            ctx.a.environmentId,
            record.id,
            userId,
            later,
            activity(ctx.a, 'organization_invitation.declined', org.id)
          )
        ).toEqual({
          outcome: 'done',
          record: {
            ...record,
            status: 'declined',
            resolvedAt: later,
            resolvedBy: userId,
            updatedAt: later,
          },
        })
        expect(await ctx.recorded()).toContain('organization_invitation.declined')
        expect(
          await ctx.store.declineInvitation(
            ctx.a.environmentId,
            Bun.randomUUIDv7(),
            userId,
            later,
            activity(ctx.a, 'organization_invitation.declined', org.id)
          )
        ).toEqual({ outcome: 'not_found' })
      })

      test('accepting uses the invitation up and stores the membership, with both records', async () => {
        const { org, member } = await setup2()
        const record = await invited(ctx.a, org)
        const userId = await ctx.user(ctx.a)
        const membership: MembershipRecord = {
          id: Bun.randomUUIDv7(),
          projectId: ctx.a.projectId,
          environmentId: ctx.a.environmentId,
          organizationId: org.id,
          userId,
          roleId: member.id,
          roleKey: member.key,
          createdAt: later,
          updatedAt: later,
        }
        const result = await ctx.store.acceptInvitation(
          ctx.a.environmentId,
          record.id,
          membership,
          later,
          {
            invitation: activity(ctx.a, 'organization_invitation.accepted', org.id),
            membership: activity(ctx.a, 'organization_membership.added', membership.id),
          }
        )
        expect(result).toEqual({
          outcome: 'accepted',
          record: {
            ...record,
            status: 'accepted',
            resolvedAt: later,
            resolvedBy: userId,
            updatedAt: later,
          },
          membership,
        })
        expect(
          (await ctx.store.findUserMembership(ctx.a.environmentId, org.id, userId))?.membership
        ).toEqual(membership)
        const types = await ctx.recorded()
        expect(types).toContain('organization_invitation.accepted')
        expect(types).toContain('organization_membership.added')
      })

      test('two acceptances at once make one membership', async () => {
        const { org, member } = await setup2()
        const record = await invited(ctx.a, org)
        const userId = await ctx.user(ctx.a)
        const accept = () => {
          const membership: MembershipRecord = {
            id: Bun.randomUUIDv7(),
            projectId: ctx.a.projectId,
            environmentId: ctx.a.environmentId,
            organizationId: org.id,
            userId,
            roleId: member.id,
            roleKey: member.key,
            createdAt: later,
            updatedAt: later,
          }
          return ctx.store.acceptInvitation(ctx.a.environmentId, record.id, membership, later, {
            invitation: activity(ctx.a, 'organization_invitation.accepted', org.id),
            membership: activity(ctx.a, 'organization_membership.added', membership.id),
          })
        }
        const outcomes = (await Promise.all([accept(), accept()])).map((result) => result.outcome)
        expect(outcomes.filter((outcome) => outcome === 'accepted')).toHaveLength(1)
        expect(
          (await ctx.store.listMemberships(ctx.a.environmentId, org.id, { page: 1, size: 10 }))
            .total
        ).toBe(1)
      })

      test('a user who is a member already is a duplicate: the invitation stays pending', async () => {
        const { org, member } = await setup2()
        const joined = await join(ctx.a, org, member)
        const record = await invited(ctx.a, org)
        const before = (await ctx.recorded()).length
        const membership: MembershipRecord = {
          ...joined,
          id: Bun.randomUUIDv7(),
          createdAt: later,
          updatedAt: later,
        }
        expect(
          await ctx.store.acceptInvitation(ctx.a.environmentId, record.id, membership, later, {
            invitation: activity(ctx.a, 'organization_invitation.accepted', org.id),
            membership: activity(ctx.a, 'organization_membership.added', membership.id),
          })
        ).toEqual({ outcome: 'duplicate' })
        expect(
          (await ctx.store.findInvitation(ctx.a.environmentId, org.id, record.id))?.status
        ).toBe('pending')
        expect((await ctx.recorded()).length).toBe(before)
      })

      test('a user or a role that is gone is gone: the invitation stays pending', async () => {
        const { org, member } = await setup2()
        const record = await invited(ctx.a, org)
        const stranger: MembershipRecord = {
          id: Bun.randomUUIDv7(),
          projectId: ctx.a.projectId,
          environmentId: ctx.a.environmentId,
          organizationId: org.id,
          userId: Bun.randomUUIDv7(),
          roleId: member.id,
          roleKey: member.key,
          createdAt: later,
          updatedAt: later,
        }
        expect(
          await ctx.store.acceptInvitation(ctx.a.environmentId, record.id, stranger, later, {
            invitation: activity(ctx.a, 'organization_invitation.accepted', org.id),
            membership: activity(ctx.a, 'organization_membership.added', stranger.id),
          })
        ).toEqual({ outcome: 'gone' })
        const userId = await ctx.user(ctx.a)
        const noRole: MembershipRecord = { ...stranger, userId, roleId: Bun.randomUUIDv7() }
        expect(
          await ctx.store.acceptInvitation(ctx.a.environmentId, record.id, noRole, later, {
            invitation: activity(ctx.a, 'organization_invitation.accepted', org.id),
            membership: activity(ctx.a, 'organization_membership.added', noRole.id),
          })
        ).toEqual({ outcome: 'gone' })
        expect(
          (await ctx.store.findInvitation(ctx.a.environmentId, org.id, record.id))?.status
        ).toBe('pending')
      })

      test('an unknown invitation is not found when accepted', async () => {
        const { org, member } = await setup2()
        const userId = await ctx.user(ctx.a)
        const membership: MembershipRecord = {
          id: Bun.randomUUIDv7(),
          projectId: ctx.a.projectId,
          environmentId: ctx.a.environmentId,
          organizationId: org.id,
          userId,
          roleId: member.id,
          roleKey: member.key,
          createdAt: later,
          updatedAt: later,
        }
        expect(
          await ctx.store.acceptInvitation(
            ctx.a.environmentId,
            Bun.randomUUIDv7(),
            membership,
            later,
            {
              invitation: activity(ctx.a, 'organization_invitation.accepted', org.id),
              membership: activity(ctx.a, 'organization_membership.added', membership.id),
            }
          )
        ).toEqual({ outcome: 'not_found' })
      })

      test('deleting the organization deletes its invitations', async () => {
        const { org } = await setup2()
        const record = await invited(ctx.a, org)
        await ctx.store.delete(
          ctx.a.environmentId,
          org.id,
          activity(ctx.a, 'organization.deleted', org.id)
        )
        expect(
          await ctx.store.findInvitationByTokenHash(ctx.a.environmentId, record.tokenHash)
        ).toBeNull()
      })

      test('the purge deletes invitations that expired before the cutoff, whatever became of them, a batch at a time', async () => {
        const { org } = await setup2()
        const old = new Date(now.getTime() + 1000)
        const a = await invited(ctx.a, org, {
          email: 'a@example.com',
          emailNormalized: 'a@example.com',
          expiresAt: old,
        })
        const b = await invited(ctx.a, org, {
          email: 'b@example.com',
          emailNormalized: 'b@example.com',
          expiresAt: old,
        })
        await ctx.store.revokeInvitation(
          ctx.a.environmentId,
          org.id,
          b.id,
          now,
          activity(ctx.a, 'organization_invitation.revoked', org.id)
        )
        const keep = await invited(ctx.a, org, {
          email: 'c@example.com',
          emailNormalized: 'c@example.com',
          expiresAt: inAWeek,
        })
        const foreign = await stored(organization(ctx.b))
        const other = await invited(ctx.b, foreign, { expiresAt: old })
        const cutoff = new Date(now.getTime() + 60_000)
        expect(await ctx.store.deleteExpiredInvitations(ctx.a.environmentId, cutoff, 1)).toBe(1)
        expect(await ctx.store.deleteExpiredInvitations(ctx.a.environmentId, cutoff, 10)).toBe(1)
        expect(await ctx.store.deleteExpiredInvitations(ctx.a.environmentId, cutoff, 10)).toBe(0)
        expect(await ctx.store.findInvitation(ctx.a.environmentId, org.id, a.id)).toBeNull()
        expect(await ctx.store.findInvitation(ctx.a.environmentId, org.id, b.id)).toBeNull()
        expect(await ctx.store.findInvitation(ctx.a.environmentId, org.id, keep.id)).not.toBeNull()
        // Another environment's rows are not touched by this environment's purge.
        expect(
          await ctx.store.findInvitation(ctx.b.environmentId, foreign.id, other.id)
        ).not.toBeNull()
      })
    })
  })
}
