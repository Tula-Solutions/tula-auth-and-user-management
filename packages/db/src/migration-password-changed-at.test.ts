import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'

// The migration that adds `credentials.secret_changed_at` fills it for the passwords that
// exist, with SQL written by hand (ADR 0041). This applies the migrations before it, writes
// credentials of the old shape, applies it and reads what became of them.
//
// PGlite's own role is a superuser, which row-level security never binds, so this does NOT
// show that the backfill reaches the rows when the migrating role is an ordinary owner (the
// reason the migration lifts FORCE for the length of the UPDATE); it shows what the backfill
// writes, and that FORCE is back afterwards.
//
// The migration is found by its name, not its number: the number changes when another
// migration is merged first.

const MIGRATIONS = join(import.meta.dir, '..', 'migrations')
const files = readdirSync(MIGRATIONS)
  .filter((name) => name.endsWith('.sql'))
  .sort()
const at = files.findIndex((name) => name.endsWith('_password_changed_at.sql'))

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
const ENVIRONMENT = '0199c2f4-0000-7000-8000-000000000003'
const OLD_USER = '0199c2f4-0000-7000-8000-000000000004'
const REWRITTEN_USER = '0199c2f4-0000-7000-8000-000000000005'

describe('the migration that adds credentials.secret_changed_at', () => {
  let client: PGlite
  let rows: Record<string, { changed: string; updated: string; created: string }>

  beforeAll(async () => {
    client = new PGlite()
    // What the migrator makes before the first migration; 0014 reads it.
    await client.exec(
      'create schema drizzle; create table drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)'
    )
    for (const name of files.slice(0, at)) {
      await apply(client, name)
    }
    await client.exec(`
      insert into tula.workspaces (id, name) values ('${WORKSPACE}', 'w');
      insert into tula.projects (id, workspace_id, name) values ('${PROJECT}', '${WORKSPACE}', 'p');
      insert into tula.environments (id, project_id, kind) values ('${ENVIRONMENT}', '${PROJECT}', 'development');
      insert into tula.users (id, project_id, environment_id, email, email_normalized)
        values ('${OLD_USER}', '${PROJECT}', '${ENVIRONMENT}', 'old@example.com', 'old@example.com'),
               ('${REWRITTEN_USER}', '${PROJECT}', '${ENVIRONMENT}', 're@example.com', 're@example.com');
      -- A password set 200 days ago and never written since.
      insert into tula.credentials (id, project_id, environment_id, user_id, type, secret, created_at, updated_at)
        values ('0199c2f4-0000-7000-8000-00000000000a', '${PROJECT}', '${ENVIRONMENT}', '${OLD_USER}', 'password', 'hash-a',
                now() - interval '200 days', now() - interval '200 days');
      -- A password made 300 days ago whose row was last written 10 days ago (a change, or a
      -- rehash: the table cannot tell which).
      insert into tula.credentials (id, project_id, environment_id, user_id, type, secret, created_at, updated_at)
        values ('0199c2f4-0000-7000-8000-00000000000b', '${PROJECT}', '${ENVIRONMENT}', '${REWRITTEN_USER}', 'password', 'hash-b',
                now() - interval '300 days', now() - interval '10 days');
    `)
    for (const name of files.slice(at)) {
      await apply(client, name)
    }
    const read = await client.query<{
      user_id: string
      changed: string
      updated: string
      created: string
    }>(
      `select user_id, secret_changed_at::text as changed, updated_at::text as updated,
              created_at::text as created
       from tula.credentials`
    )
    rows = Object.fromEntries(read.rows.map((row) => [row.user_id, row]))
  })
  afterAll(() => client.close())

  test('is found among the migrations', () => {
    expect(at).toBeGreaterThan(0)
  })

  test('a password that exists is as old as its row was last written', () => {
    expect(rows[OLD_USER]?.changed).toBeString()
    expect(rows[OLD_USER]?.changed).toBe(rows[OLD_USER]?.updated)
    expect(rows[REWRITTEN_USER]?.changed).toBe(rows[REWRITTEN_USER]?.updated)
    // Never the row's creation time, and never the time of the migration.
    expect(rows[REWRITTEN_USER]?.changed).not.toBe(rows[REWRITTEN_USER]?.created)
  })

  test('the backfill moves nothing else', async () => {
    const stored = await client.query<{ secret: string }>(
      'select secret from tula.credentials order by secret'
    )
    expect(stored.rows).toEqual([{ secret: 'hash-a' }, { secret: 'hash-b' }])
  })

  test('a credential written afterwards without the column gets the time of the write', async () => {
    const user = '0199c2f4-0000-7000-8000-000000000006'
    await client.exec(`
      insert into tula.users (id, project_id, environment_id, email, email_normalized)
        values ('${user}', '${PROJECT}', '${ENVIRONMENT}', 'new@example.com', 'new@example.com');
      insert into tula.credentials (id, project_id, environment_id, user_id, type, secret)
        values ('0199c2f4-0000-7000-8000-00000000000c', '${PROJECT}', '${ENVIRONMENT}', '${user}', 'password', 'hash-c');
    `)
    const fresh = await client.query<{ recent: boolean }>(
      `select secret_changed_at > now() - interval '1 minute' as recent
       from tula.credentials where user_id = '${user}'`
    )
    expect(fresh.rows).toEqual([{ recent: true }])
  })

  test('row-level security is forced again afterwards', async () => {
    const forced = await client.query<{ relforcerowsecurity: boolean }>(
      `select relforcerowsecurity from pg_class
       where relname = 'credentials' and relnamespace = 'tula'::regnamespace`
    )
    expect(forced.rows).toEqual([{ relforcerowsecurity: true }])
  })
})
