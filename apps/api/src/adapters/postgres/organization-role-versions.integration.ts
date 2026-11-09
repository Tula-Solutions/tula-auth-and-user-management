import { afterAll, describe, expect, test } from 'bun:test'
import { permissionsHash } from '@tula-tech/contract'
import { organizationRoleVersions, withTenant } from '@tula-tech/db'
import { sql } from 'drizzle-orm'
import { openIntegrationDatabase } from '~/adapters/postgres/integration-support'

/**
 * `organization_role_versions` against a real Postgres: a snapshot is append-only for the
 * runtime role, and the migration's backfill hashes exactly as `permissionsHash()` does.
 */
const database = openIntegrationDatabase(1)
afterAll(() => database.close())

/** The driver's message under Drizzle's "Failed query" wrapper. */
async function causeOf(attempt: Promise<unknown>): Promise<string> {
  try {
    await attempt
  } catch (error) {
    return String((error as { cause?: Error }).cause?.message)
  }
  return 'succeeded'
}

describe('a snapshot is append-only for the runtime role', () => {
  async function insertSnapshot(createdAt?: Date) {
    const tenant = await database.tenant()
    const roleId = Bun.randomUUIDv7()
    await withTenant(database.first.db, tenant.environmentId, (tx) =>
      tx.insert(organizationRoleVersions).values({
        projectId: tenant.projectId,
        environmentId: tenant.environmentId,
        roleId,
        roleKey: 'org:billing',
        version: 1,
        permissions: [],
        permissionsHash: `1.${'A'.repeat(43)}`,
        ...(createdAt ? { createdAt } : {}),
      })
    )
    return { tenant, roleId }
  }

  test('an UPDATE is refused', async () => {
    const { tenant, roleId } = await insertSnapshot()
    const attempt = withTenant(database.first.db, tenant.environmentId, (tx) =>
      tx.execute(
        sql`UPDATE tula.organization_role_versions SET role_key = 'x' WHERE role_id = ${roleId}`
      )
    )
    expect(await causeOf(attempt)).toMatch(/permission denied/)
  })

  /** How many rows of a role the runtime role can still see. */
  async function remaining(environmentId: string, roleId: string): Promise<number> {
    const { rows } = (await withTenant(database.first.db, environmentId, (tx) =>
      tx.execute(sql`SELECT 1 FROM tula.organization_role_versions WHERE role_id = ${roleId}`)
    )) as { rows: unknown[] }
    return rows.length
  }

  const remove = (environmentId: string, roleId: string) =>
    withTenant(database.first.db, environmentId, (tx) =>
      tx.execute(sql`DELETE FROM tula.organization_role_versions WHERE role_id = ${roleId}`)
    )

  test('a DELETE of a fresh row removes nothing: the retention floor', async () => {
    const { tenant, roleId } = await insertSnapshot()
    await remove(tenant.environmentId, roleId)
    expect(await remaining(tenant.environmentId, roleId)).toBe(1)
  })

  test('a DELETE of a row older than a day succeeds', async () => {
    const { tenant, roleId } = await insertSnapshot(new Date(Date.now() - 2 * 86_400_000))
    await remove(tenant.environmentId, roleId)
    expect(await remaining(tenant.environmentId, roleId)).toBe(0)
  })
})

describe("the migration's hash expression equals permissionsHash()", () => {
  // The expression of migration 0062's backfill, with the role's column replaced by a parameter.
  async function sqlHash(keys: string[]): Promise<string> {
    const literal = sql`ARRAY[${sql.join(
      keys.map((k) => sql`${k}`),
      sql`, `
    )}]::text[]`
    // `Database` is driver-neutral, so `execute` is untyped; node-postgres answers rows.
    const { rows } = (await database.first.db.execute(sql`
      SELECT '1.' || rtrim(translate(replace(encode(sha256(convert_to(
        '[' || coalesce((SELECT string_agg('"' || k || '"', ',' ORDER BY k COLLATE "C")
          FROM (SELECT DISTINCT unnest(${literal}) AS k) d), '') || ']',
        'UTF8')), 'base64'), E'\n', ''), '+/', '-_'), '=') AS hash`)) as {
      rows: { hash: string }[]
    }
    return rows[0]?.hash ?? ''
  }

  const cases: [string, string[]][] = [
    ['empty', []],
    ['unsorted', ['org:billing:write', 'org:billing:read', 'org:Admin:read']],
    ['duplicated', ['org:billing:read', 'org:billing:read', 'org:billing:write']],
  ]
  for (const [name, keys] of cases) {
    test(name, async () => {
      expect(await sqlHash(keys)).toBe(await permissionsHash(keys))
    })
  }
})
