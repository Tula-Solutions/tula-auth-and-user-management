import { afterAll, beforeAll, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { organizationInvitations, organizations } from './schema'
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

async function addOrganization(scope: TestTenant, slug: string): Promise<string> {
  const id = Bun.randomUUIDv7()
  await withTenant(testDb.db, scope.environmentId, (tx) =>
    tx.insert(organizations).values({ id, ...ids(scope), name: 'Acme', slug })
  )
  return id
}

const later = new Date('2030-01-08T00:00:00.000Z')

function invite(
  scope: TestTenant,
  organizationId: string,
  overrides: Partial<typeof organizationInvitations.$inferInsert> = {}
) {
  const id = Bun.randomUUIDv7()
  return {
    id,
    work: () =>
      withTenant(testDb.db, scope.environmentId, (tx) =>
        tx.insert(organizationInvitations).values({
          id,
          ...ids(scope),
          organizationId,
          email: 'Ada@Example.com',
          emailNormalized: 'ada@example.com',
          roleKey: 'member',
          tokenHash: Bun.randomUUIDv7().replaceAll('-', ''),
          expiresAt: later,
          ...overrides,
        })
      ),
  }
}

const rowOf = (scope: TestTenant, id: string) =>
  withTenant(testDb.db, scope.environmentId, async (tx) => {
    const [row] = await tx
      .select()
      .from(organizationInvitations)
      .where(eq(organizationInvitations.id, id))
    return row
  })

test('another environment’s invitations are invisible, even to a direct query', async () => {
  const org = await addOrganization(tenant, 'invisible')
  const { id, work } = invite(tenant, org)
  await work()
  const seen = await withTenant(testDb.db, other.environmentId, (tx) =>
    tx.select().from(organizationInvitations).where(eq(organizationInvitations.id, id))
  )
  expect(seen).toEqual([])
  expect(
    await testDb.db.select().from(organizationInvitations).where(eq(organizationInvitations.id, id))
  ).toEqual([])
})

test('an organization has one pending invitation per address, and a resolved one frees it', async () => {
  const org = await addOrganization(tenant, 'pending-key')
  const first = invite(tenant, org)
  await first.work()
  expect(await refused(invite(tenant, org).work)).toContain('organization_invitations_pending_key')
  // The key is on the normalized address: a different spelling is the same address.
  expect(
    await refused(
      invite(tenant, org, { email: ' ADA@example.com ', emailNormalized: 'ada@example.com' }).work
    )
  ).toContain('organization_invitations_pending_key')
  // Another address, another organization and another environment are not held up by it.
  await invite(tenant, org, { emailNormalized: 'bo@example.com', email: 'bo@example.com' }).work()
  await invite(tenant, await addOrganization(tenant, 'pending-key-2')).work()
  await invite(other, await addOrganization(other, 'pending-key')).work()
  await withTenant(testDb.db, tenant.environmentId, (tx) =>
    tx
      .update(organizationInvitations)
      .set({ status: 'revoked', resolvedAt: later, updatedAt: later })
      .where(eq(organizationInvitations.id, first.id))
  )
  await invite(tenant, org).work()
})

test('a token hash is unique across the table', async () => {
  const org = await addOrganization(tenant, 'token-key')
  await invite(tenant, org, { tokenHash: 'same-hash' }).work()
  expect(
    await refused(
      invite(tenant, org, {
        tokenHash: 'same-hash',
        emailNormalized: 'bo@example.com',
        email: 'bo@example.com',
      }).work
    )
  ).toContain('organization_invitations_token_hash_key')
})

test.each([
  [
    'a status that is not one',
    { status: 'maybe', resolvedAt: later },
    'organization_invitations_status_known',
  ],
  [
    'a role key that is not a key',
    { roleKey: 'Not A Key' },
    'organization_invitations_role_key_shape',
  ],
  [
    'an address that is too short',
    { email: 'a', emailNormalized: 'a' },
    'organization_invitations_email_length',
  ],
  [
    'an address that is too long',
    { email: 'x'.repeat(321), emailNormalized: 'x'.repeat(321) },
    'organization_invitations_email_length',
  ],
  [
    'a pending invitation with a resolution time',
    { resolvedAt: later },
    'organization_invitations_resolved_consistent',
  ],
  [
    'a resolved invitation with no resolution time',
    { status: 'accepted' },
    'organization_invitations_resolved_consistent',
  ],
] as const)('the database refuses %s', async (_, overrides, constraint) => {
  const org = await addOrganization(tenant, `check-${Bun.randomUUIDv7().slice(-12)}`)
  expect(await refused(invite(tenant, org, overrides).work)).toContain(constraint)
})

test('an invitation cannot name an organization of another environment', async () => {
  const theirs = await addOrganization(other, 'cross-env')
  // Even as the owner, bypassing row-level security, the composite key refuses it.
  expect(await refused(invite(tenant, theirs).work)).not.toBeNull()
})

test('invitations go with their organization', async () => {
  const org = await addOrganization(tenant, 'cascade')
  const { id, work } = invite(tenant, org)
  await work()
  await withTenant(testDb.db, tenant.environmentId, (tx) =>
    tx.delete(organizations).where(eq(organizations.id, org))
  )
  expect(await rowOf(tenant, id)).toBeUndefined()
})

test('the runtime role resolves an invitation in four columns and rewrites nothing else', async () => {
  const org = await addOrganization(tenant, 'grants')
  const { id, work } = invite(tenant, org)
  await work()
  const update = (set: Partial<typeof organizationInvitations.$inferInsert>) => () =>
    withTenant(testDb.db, tenant.environmentId, (tx) =>
      tx.update(organizationInvitations).set(set).where(eq(organizationInvitations.id, id))
    )
  for (const [column, set] of [
    ['email', { email: 'other@example.com' }],
    ['email_normalized', { emailNormalized: 'other@example.com' }],
    ['role_key', { roleKey: 'admin' }],
    ['token_hash', { tokenHash: 'a-token-hash-of-its-own' }],
    // Extending the expiry would revive a lapsed link.
    ['expires_at', { expiresAt: new Date('2031-01-01T00:00:00.000Z') }],
    ['organization_id', { organizationId: Bun.randomUUIDv7() }],
    ['invited_by', { invitedBy: Bun.randomUUIDv7() }],
    ['created_at', { createdAt: later }],
  ] as const) {
    expect([column, await refused(update(set))]).toEqual([
      column,
      expect.stringContaining('permission denied'),
    ])
  }
  await update({
    status: 'accepted',
    resolvedAt: later,
    resolvedBy: Bun.randomUUIDv7(),
    updatedAt: later,
  })()
  expect((await rowOf(tenant, id))?.status).toBe('accepted')
})

test('the runtime role may delete an invitation in its own environment only', async () => {
  const org = await addOrganization(tenant, 'delete')
  const { id, work } = invite(tenant, org)
  await work()
  await withTenant(testDb.db, other.environmentId, (tx) =>
    tx.delete(organizationInvitations).where(eq(organizationInvitations.id, id))
  )
  expect(await rowOf(tenant, id)).toBeDefined()
  await withTenant(testDb.db, tenant.environmentId, (tx) =>
    tx.delete(organizationInvitations).where(eq(organizationInvitations.id, id))
  )
  expect(await rowOf(tenant, id)).toBeUndefined()
})

test('a statement with no environment in scope sees and writes nothing', async () => {
  const org = await addOrganization(tenant, 'fail-closed')
  await invite(tenant, org).work()
  expect(await testDb.db.select().from(organizationInvitations)).toEqual([])
})
