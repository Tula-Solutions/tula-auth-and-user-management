import { afterAll, beforeAll, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { organizationMemberships, organizationRoles, organizations, users } from './schema'
import { withTenant } from './tenant'
import { createTestDatabase, createTestTenant, type TestDatabase, type TestTenant } from './testing'

let testDb: TestDatabase
let tenant: TestTenant
let other: TestTenant

beforeAll(async () => {
  testDb = await createTestDatabase()
  tenant = await createTestTenant(testDb.db)
  other = await createTestTenant(testDb.db)
})

afterAll(() => testDb.close())

/** A statement's outcome: Drizzle builders are thenables, not promises. */
async function refused(work: () => Promise<unknown>): Promise<string | null> {
  try {
    await work()
    return null
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause
    return String((cause as { message?: string } | undefined)?.message ?? error)
  }
}

const ids = (scope: TestTenant) => ({
  projectId: scope.projectId,
  environmentId: scope.environmentId,
})

async function addUser(scope: TestTenant): Promise<string> {
  const id = Bun.randomUUIDv7()
  await withTenant(testDb.db, scope.environmentId, (tx) =>
    tx.insert(users).values({ id, ...ids(scope) })
  )
  return id
}

async function addOrganization(scope: TestTenant, slug = 'acme'): Promise<string> {
  const id = Bun.randomUUIDv7()
  await withTenant(testDb.db, scope.environmentId, (tx) =>
    tx.insert(organizations).values({ id, ...ids(scope), name: 'Acme', slug })
  )
  return id
}

async function addRole(
  scope: TestTenant,
  overrides: Partial<typeof organizationRoles.$inferInsert> = {}
): Promise<string> {
  const id = Bun.randomUUIDv7()
  await withTenant(testDb.db, scope.environmentId, (tx) =>
    tx.insert(organizationRoles).values({
      id,
      ...ids(scope),
      key: 'member',
      name: 'Member',
      permissions: ['org:sys:memberships:read'],
      builtIn: true,
      ...overrides,
    })
  )
  return id
}

async function addMember(
  scope: TestTenant,
  organizationId: string,
  userId: string,
  roleId: string
) {
  await withTenant(testDb.db, scope.environmentId, (tx) =>
    tx.insert(organizationMemberships).values({
      ...ids(scope),
      organizationId,
      userId,
      roleId,
    })
  )
}

const count = (scope: TestTenant) =>
  withTenant(testDb.db, scope.environmentId, async (tx) => {
    const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(organizationMemberships)
    return row?.n ?? 0
  })

test('another environment’s organizations are invisible, even to a direct query', async () => {
  const mine = await addOrganization(tenant, 'visible')
  const seen = await withTenant(testDb.db, other.environmentId, (tx) =>
    tx.select().from(organizations).where(eq(organizations.id, mine))
  )
  expect(seen).toEqual([])
  expect(await testDb.db.select().from(organizations).where(eq(organizations.id, mine))).toEqual([])
})

test('a slug is unique per environment and not across environments', async () => {
  await addOrganization(tenant, 'unique-slug')
  expect(await refused(() => addOrganization(tenant, 'unique-slug'))).toContain(
    'organizations_environment_slug_key'
  )
  await addOrganization(other, 'unique-slug')
})

test.each(['A', 'a', 'Acme', '-acme', 'acme-', 'ac--me', 'ac me', 'x'.repeat(49)])(
  'the database refuses the slug %j',
  async (slug) => {
    expect(await refused(() => addOrganization(tenant, slug))).toContain('organizations_slug_shape')
  }
)

test('a name is 1 to 100 characters', async () => {
  const insert = (name: string) =>
    withTenant(testDb.db, tenant.environmentId, (tx) =>
      tx.insert(organizations).values({ ...ids(tenant), name, slug: 'name-check' })
    )
  expect(await refused(() => insert(''))).toContain('organizations_name_length')
  expect(await refused(() => insert('x'.repeat(101)))).toContain('organizations_name_length')
})

test('a membership cannot join an organization, a user or a role of another environment', async () => {
  const org = await addOrganization(tenant, 'cross-env')
  const user = await addUser(tenant)
  const role = await addRole(tenant, { key: 'cross_env', builtIn: false })
  const theirOrg = await addOrganization(other, 'cross-env-theirs')
  const theirUser = await addUser(other)
  const theirRole = await addRole(other, { key: 'cross_env', builtIn: false })
  // A direct insert as the owner would bypass RLS; the composite keys still refuse it.
  expect(await refused(() => addMember(tenant, theirOrg, user, role))).not.toBeNull()
  expect(await refused(() => addMember(tenant, org, theirUser, role))).not.toBeNull()
  expect(await refused(() => addMember(tenant, org, user, theirRole))).not.toBeNull()
  await addMember(tenant, org, user, role)
})

test('a user is a member of an organization once', async () => {
  const org = await addOrganization(tenant, 'once')
  const user = await addUser(tenant)
  const role = await addRole(tenant, { key: 'once_role', builtIn: false })
  await addMember(tenant, org, user, role)
  expect(await refused(() => addMember(tenant, org, user, role))).toContain(
    'organization_memberships_organization_user_key'
  )
})

test('memberships go with their organization and with their user', async () => {
  const role = await addRole(tenant, { key: 'cascade_role', builtIn: false })
  const org = await addOrganization(tenant, 'cascade-org')
  const user = await addUser(tenant)
  const stays = await addUser(tenant)
  await addMember(tenant, org, user, role)
  await addMember(tenant, org, stays, role)
  const before = await count(tenant)

  await withTenant(testDb.db, tenant.environmentId, (tx) =>
    tx.delete(users).where(eq(users.id, user))
  )
  expect(await count(tenant)).toBe(before - 1)

  await withTenant(testDb.db, tenant.environmentId, (tx) =>
    tx.delete(organizations).where(eq(organizations.id, org))
  )
  expect(await count(tenant)).toBe(before - 2)
})

test('a role that is still assigned cannot be deleted', async () => {
  await testDb.setRole('postgres')
  try {
    const role = await addRoleAsOwner()
    const org = await addOrganizationAsOwner()
    const user = await addUserAsOwner()
    await testDb.db.insert(organizationMemberships).values({
      ...ids(tenant),
      organizationId: org,
      userId: user,
      roleId: role,
    })
    const removed = await refused(() =>
      testDb.db.delete(organizationRoles).where(eq(organizationRoles.id, role))
    )
    expect(removed).toContain('organization_memberships_role_fk')
  } finally {
    await testDb.setRole('tula_app')
  }
})

async function addRoleAsOwner(): Promise<string> {
  const id = Bun.randomUUIDv7()
  await testDb.db.insert(organizationRoles).values({
    id,
    ...ids(tenant),
    key: 'assigned',
    name: 'Assigned',
    permissions: [],
  })
  return id
}
async function addOrganizationAsOwner(): Promise<string> {
  const id = Bun.randomUUIDv7()
  await testDb.db
    .insert(organizations)
    .values({ id, ...ids(tenant), name: 'Owned', slug: 'owned-by-owner' })
  return id
}
async function addUserAsOwner(): Promise<string> {
  const id = Bun.randomUUIDv7()
  await testDb.db.insert(users).values({ id, ...ids(tenant) })
  return id
}

test.each([
  ['a key outside the grammar', ['billing.read']],
  ['two keys in one element', ['org:a:b,org:c:d']],
  ['a custom key in the reserved feature', ['org:sys:read']],
  ['a null element', ['org:a:b', null as unknown as string]],
  ['more than 32 keys', Array.from({ length: 33 }, (_, i) => `org:feature${i}:read`)],
])('a role cannot hold %s', async (_name, permissions) => {
  expect(
    await refused(() => addRole(tenant, { key: 'bad_perms', builtIn: false, permissions }))
  ).toContain('organization_roles_permissions_shape')
})

test('a role holds system permissions and custom ones', async () => {
  await addRole(tenant, {
    key: 'good_perms',
    builtIn: false,
    permissions: ['org:sys:memberships:manage', 'org:billing:read'],
  })
})

test('only the two built-in keys may be built in, and a key follows the grammar', async () => {
  expect(await refused(() => addRole(tenant, { key: 'custom', builtIn: true }))).toContain(
    'organization_roles_built_in_known'
  )
  expect(await refused(() => addRole(tenant, { key: 'Not-A-Key', builtIn: false }))).toContain(
    'organization_roles_key_shape'
  )
})

test('the runtime role may rename an organization but not rewrite who created it', async () => {
  const id = await addOrganization(tenant, 'grants')
  await withTenant(testDb.db, tenant.environmentId, (tx) =>
    tx
      .update(organizations)
      .set({ name: 'Renamed', slug: 'grants-2' })
      .where(eq(organizations.id, id))
  )
  expect(
    await refused(() =>
      withTenant(testDb.db, tenant.environmentId, (tx) =>
        tx
          .update(organizations)
          .set({ createdBy: Bun.randomUUIDv7() })
          .where(eq(organizations.id, id))
      )
    )
  ).toContain('permission denied')
})

test('the runtime role can neither change nor delete a role', async () => {
  const id = await addRole(tenant, { key: 'frozen', builtIn: false })
  const inScope = <T>(work: (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) => Promise<T>) =>
    withTenant(testDb.db, tenant.environmentId, work)
  expect(
    await refused(() =>
      inScope((tx) =>
        tx.update(organizationRoles).set({ permissions: [] }).where(eq(organizationRoles.id, id))
      )
    )
  ).toContain('permission denied')
  expect(
    await refused(() =>
      inScope((tx) => tx.delete(organizationRoles).where(eq(organizationRoles.id, id)))
    )
  ).toContain('permission denied')
})

test('a membership can change its role and nothing else', async () => {
  const org = await addOrganization(tenant, 'grants-member')
  const user = await addUser(tenant)
  const role = await addRole(tenant, { key: 'grant_a', builtIn: false })
  const next = await addRole(tenant, { key: 'grant_b', builtIn: false })
  await addMember(tenant, org, user, role)
  await withTenant(testDb.db, tenant.environmentId, (tx) =>
    tx
      .update(organizationMemberships)
      .set({ roleId: next })
      .where(eq(organizationMemberships.userId, user))
  )
  expect(
    await refused(() =>
      withTenant(testDb.db, tenant.environmentId, (tx) =>
        tx
          .update(organizationMemberships)
          .set({ userId: Bun.randomUUIDv7() })
          .where(eq(organizationMemberships.userId, user))
      )
    )
  ).toContain('permission denied')
})
