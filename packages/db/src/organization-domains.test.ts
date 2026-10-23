import { afterAll, beforeAll, expect, test } from 'bun:test'
import { and, eq, sql } from 'drizzle-orm'
import { organizationDomains, organizations } from './schema'
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

async function addOrganization(scope: TestTenant): Promise<string> {
  const id = Bun.randomUUIDv7()
  await withTenant(testDb.db, scope.environmentId, (tx) =>
    tx.insert(organizations).values({ id, ...ids(scope), name: 'Acme', slug: `o-${id.slice(-12)}` })
  )
  return id
}

/** A pending claim, as the API writes one. */
function pending(
  scope: TestTenant,
  organizationId: string,
  domain: string,
  overrides: Partial<typeof organizationDomains.$inferInsert> = {}
) {
  return withTenant(testDb.db, scope.environmentId, (tx) =>
    tx.insert(organizationDomains).values({
      id: Bun.randomUUIDv7(),
      ...ids(scope),
      organizationId,
      domain,
      mode: 'suggest',
      codeHash: 'hash',
      codeExpiresAt: new Date(Date.now() + 60_000),
      ...overrides,
    })
  )
}

/** Verify by the statement the API issues: stamp the time and clear the code together. */
function verify(scope: TestTenant, organizationId: string, domain: string) {
  return withTenant(testDb.db, scope.environmentId, (tx) =>
    tx
      .update(organizationDomains)
      .set({ verifiedAt: new Date(), codeHash: null, codeExpiresAt: null, codeAttempts: 0 })
      .where(
        and(
          eq(organizationDomains.organizationId, organizationId),
          eq(organizationDomains.domain, domain)
        )
      )
  )
}

test('another environment’s claims are invisible, even to a direct query', async () => {
  const org = await addOrganization(tenant)
  await pending(tenant, org, 'visible.example')
  const seen = await withTenant(testDb.db, other.environmentId, (tx) =>
    tx.select().from(organizationDomains).where(eq(organizationDomains.organizationId, org))
  )
  expect(seen).toEqual([])
  expect(await testDb.db.select().from(organizationDomains)).toEqual([])
})

test.each([
  'Acme.com',
  'bücher.example',
  '192.168.0.1',
  '[::1]',
  'acme.com.',
  'ac_me.com',
  '-acme.com',
  'acme-.com',
  'localhost',
  'a.b',
  '*.acme.com',
  'acme.com:80',
])('the database refuses the domain %j', async (domain) => {
  const org = await addOrganization(tenant)
  expect(await refused(() => pending(tenant, org, domain))).toContain(
    'organization_domains_domain_shape'
  )
})

test('punycode and a long but legal name are accepted, an over-long one is not', async () => {
  const org = await addOrganization(tenant)
  await pending(tenant, org, 'xn--bcher-kva.example')
  await pending(tenant, org, `${'a'.repeat(63)}.com`)
  const long = `${`${'a'.repeat(60)}.`.repeat(5)}com`
  expect(long.length).toBeGreaterThan(253)
  expect(await refused(() => pending(tenant, org, long))).toContain(
    'organization_domains_domain_shape'
  )
})

test('a mode outside the closed set is refused', async () => {
  const org = await addOrganization(tenant)
  expect(
    await refused(() => pending(tenant, org, 'mode.example', { mode: 'everyone' as never }))
  ).toContain('organization_domains_mode_known')
})

test('an organization has a name once, pending or verified', async () => {
  const org = await addOrganization(tenant)
  await pending(tenant, org, 'once.example')
  expect(await refused(() => pending(tenant, org, 'once.example'))).toContain(
    'organization_domains_organization_domain_key'
  )
})

test('any number of organizations may wait on a name, and exactly one can verify it', async () => {
  const one = await addOrganization(tenant)
  const two = await addOrganization(tenant)
  const elsewhere = await addOrganization(other)
  await pending(tenant, one, 'contested.example')
  await pending(tenant, two, 'contested.example')
  await verify(tenant, one, 'contested.example')
  expect(await refused(() => verify(tenant, two, 'contested.example'))).toContain(
    'organization_domains_verified_domain_key'
  )
  // Another environment is another namespace.
  await pending(other, elsewhere, 'contested.example')
  await verify(other, elsewhere, 'contested.example')
})

test('a row has a code exactly while it is unverified', async () => {
  const org = await addOrganization(tenant)
  expect(await refused(() => pending(tenant, org, 'nocode.example', { codeHash: null }))).toContain(
    'organization_domains_state'
  )
  expect(
    await refused(() => pending(tenant, org, 'noexpiry.example', { codeExpiresAt: null }))
  ).toContain('organization_domains_state')
  await pending(tenant, org, 'both.example')
  const stamp = withTenant(testDb.db, tenant.environmentId, (tx) =>
    tx
      .update(organizationDomains)
      .set({ verifiedAt: new Date() })
      .where(eq(organizationDomains.domain, 'both.example'))
  )
  // Verified with the code left in place.
  expect(await refused(() => stamp)).toContain('organization_domains_state')
  expect(await refused(() => pending(tenant, org, 'neg.example', { codeAttempts: -1 }))).toContain(
    'organization_domains_attempts'
  )
})

test('a claim cannot name an organization of another environment', async () => {
  const theirs = await addOrganization(other)
  expect(await refused(() => pending(tenant, theirs, 'cross.example'))).not.toBeNull()
})

test('the runtime role may change the mode and the code columns, and nothing that moves a row', async () => {
  const org = await addOrganization(tenant)
  const target = await addOrganization(tenant)
  await pending(tenant, org, 'grants.example')
  const set = (values: Partial<typeof organizationDomains.$inferInsert>) =>
    withTenant(testDb.db, tenant.environmentId, (tx) =>
      tx
        .update(organizationDomains)
        .set(values)
        .where(eq(organizationDomains.domain, 'grants.example'))
    )
  await set({ mode: 'auto_join', codeAttempts: 2, updatedAt: new Date() })
  for (const values of [
    { domain: 'moved.example' },
    { organizationId: target },
    { environmentId: other.environmentId },
    { projectId: other.projectId },
    { createdAt: new Date(0) },
    { id: Bun.randomUUIDv7() },
  ]) {
    expect(await refused(() => set(values))).toContain('permission denied')
  }
  const [row] = await withTenant(testDb.db, tenant.environmentId, (tx) =>
    tx.select().from(organizationDomains).where(eq(organizationDomains.domain, 'grants.example'))
  )
  expect(row).toMatchObject({ domain: 'grants.example', mode: 'auto_join', codeAttempts: 2 })
  expect(row?.organizationId).toBe(org)
})

test('rows go with their organization', async () => {
  const org = await addOrganization(tenant)
  await pending(tenant, org, 'cascade.example')
  await withTenant(testDb.db, tenant.environmentId, (tx) =>
    tx.delete(organizations).where(eq(organizations.id, org))
  )
  const [{ n } = { n: -1 }] = await withTenant(testDb.db, tenant.environmentId, (tx) =>
    tx
      .select({ n: sql<number>`count(*)::int` })
      .from(organizationDomains)
      .where(eq(organizationDomains.organizationId, org))
  )
  expect(n).toBe(0)
})
