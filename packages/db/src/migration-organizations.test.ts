import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'

// The migration that adds the organization tables gives every environment that exists its two
// built-in roles, with SQL written by hand (ADR 0065, "Built-in roles"). This applies the
// migrations before it, creates two environments, applies it and reads the roles.
//
// PGlite's own role is a superuser, which row-level security never binds, so this shows what
// the backfill writes and that FORCE is back afterwards, not that it reaches the rows for an
// ordinary owner (the reason the migration lifts FORCE for the length of the insert).
//
// The migration is found by its name, not its number.

const MIGRATIONS = join(import.meta.dir, '..', 'migrations')
const files = readdirSync(MIGRATIONS)
  .filter((name) => name.endsWith('.sql'))
  .sort()
const at = files.findIndex((name) => name.endsWith('_organizations.sql'))

async function apply(client: PGlite, name: string): Promise<void> {
  const text = await Bun.file(join(MIGRATIONS, name)).text()
  for (const statement of text.split('--> statement-breakpoint')) {
    if (statement.trim() !== '') {
      await client.exec(statement)
    }
  }
}

const WORKSPACE = '0199c2f4-0000-7000-8000-000000000001'
const PROJECT = '0199c2f4-0000-7000-8000-000000000002'
const DEV = '0199c2f4-0000-7000-8000-000000000003'
const PROD = '0199c2f4-0000-7000-8000-000000000004'

describe('the migration that adds organizations', () => {
  let client: PGlite
  let roles: { environment_id: string; key: string; permissions: string[]; built_in: boolean }[]

  beforeAll(async () => {
    client = new PGlite()
    await client.exec(
      'create schema drizzle; create table drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)'
    )
    for (const name of files.slice(0, at)) {
      await apply(client, name)
    }
    await client.exec(`
      insert into tula.workspaces (id, name) values ('${WORKSPACE}', 'w');
      insert into tula.projects (id, workspace_id, name) values ('${PROJECT}', '${WORKSPACE}', 'p');
      insert into tula.environments (id, project_id, kind) values ('${DEV}', '${PROJECT}', 'development');
      insert into tula.environments (id, project_id, kind) values ('${PROD}', '${PROJECT}', 'production');
    `)
    for (const name of files.slice(at)) {
      await apply(client, name)
    }
    roles = (
      await client.query<(typeof roles)[number]>(
        'select environment_id, key, permissions, built_in from tula.organization_roles order by environment_id, key'
      )
    ).rows
  })

  afterAll(() => client.close())

  test('every existing environment gets admin and member', () => {
    expect(roles.map((role) => [role.environment_id, role.key, role.built_in])).toEqual([
      [DEV, 'admin', true],
      [DEV, 'member', true],
      [PROD, 'admin', true],
      [PROD, 'member', true],
    ])
  })

  test('admin holds every system permission and member may read the member list', () => {
    const admin = roles.find((role) => role.key === 'admin')
    const member = roles.find((role) => role.key === 'member')
    expect(admin?.permissions).toContain('org:sys:memberships:manage')
    expect(admin?.permissions).toHaveLength(6)
    expect(member?.permissions).toEqual(['org:sys:memberships:read'])
  })

  test('row-level security is forced on the three tables afterwards', async () => {
    const { rows } = await client.query<{ relname: string; relforcerowsecurity: boolean }>(
      `select relname, relforcerowsecurity from pg_class
       where relnamespace = 'tula'::regnamespace
         and relname in ('organizations', 'organization_roles', 'organization_memberships')`
    )
    expect(rows).toHaveLength(3)
    expect(rows.every((row) => row.relforcerowsecurity)).toBe(true)
  })
})
