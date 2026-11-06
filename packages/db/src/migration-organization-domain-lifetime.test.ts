import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'

// The migration that gives a verified domain a lifetime (`organization_domains.expires_at`,
// TULA-128, ADR 0065 "Lapse") fills it for the rows that exist, with SQL written by hand:
// the later of the original `verified_at` plus 365 days and 30 days from the migration, so
// that no domain stops matching the day this ships. This applies the migrations before it,
// writes rows of the old shape, applies it and reads what became of them.
//
// PGlite's own role is a superuser, which row-level security never binds, so this shows what
// the backfill writes and that FORCE is back afterwards, not that the backfill reaches the
// rows under an ordinary owner (the reason the migration lifts FORCE for the UPDATE).
//
// The migration is found by its name, not its number: the number changes when another
// migration is merged first.

const MIGRATIONS = join(import.meta.dir, '..', 'migrations')
const files = readdirSync(MIGRATIONS)
  .filter((name) => name.endsWith('.sql'))
  .sort()
const at = files.findIndex((name) => name.endsWith('_organization_domain_lifetime.sql'))

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
const ORGANIZATION = '0199c2f4-0000-7000-8000-000000000004'

const row = (n: number) => `0199c2f4-0000-7000-8000-0000000001${String(n).padStart(2, '0')}`

describe('the migration that gives a verified domain a lifetime', () => {
  let client: PGlite
  let rows: Record<
    string,
    { expires: string | null; sound: boolean | null; remindedDays: number | null }
  >

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
      insert into tula.environments (id, project_id, kind) values ('${ENVIRONMENT}', '${PROJECT}', 'development');
      insert into tula.organizations (id, project_id, environment_id, name, slug)
        values ('${ORGANIZATION}', '${PROJECT}', '${ENVIRONMENT}', 'Acme', 'acme');
      -- Verified 400 days ago: its year is over, so it gets the grace and nothing more.
      insert into tula.organization_domains (id, project_id, environment_id, organization_id, domain, mode, verified_at)
        values ('${row(1)}', '${PROJECT}', '${ENVIRONMENT}', '${ORGANIZATION}', 'old.example', 'auto_join', now() - interval '400 days');
      -- Verified 10 days ago: it keeps its full year from then.
      insert into tula.organization_domains (id, project_id, environment_id, organization_id, domain, mode, verified_at)
        values ('${row(2)}', '${PROJECT}', '${ENVIRONMENT}', '${ORGANIZATION}', 'recent.example', 'suggest', now() - interval '10 days');
      -- Verified 340 days ago: 25 days of its year are left, so the grace is longer.
      insert into tula.organization_domains (id, project_id, environment_id, organization_id, domain, mode, verified_at)
        values ('${row(3)}', '${PROJECT}', '${ENVIRONMENT}', '${ORGANIZATION}', 'nearly.example', 'suggest', now() - interval '340 days');
      -- A claim waiting for its code has no deadline.
      insert into tula.organization_domains (id, project_id, environment_id, organization_id, domain, mode, code_hash, code_expires_at)
        values ('${row(4)}', '${PROJECT}', '${ENVIRONMENT}', '${ORGANIZATION}', 'waiting.example', 'suggest', 'h', now() + interval '10 minutes');
    `)
    for (const name of files.slice(at)) {
      await apply(client, name)
    }
    const read = await client.query<{
      domain: string
      expires: string | null
      sound: boolean | null
      reminded_days: number | null
    }>(
      `select domain, expires_at::text as expires, reminded_days,
              case domain
                when 'old.example' then
                  expires_at between now() + interval '29 days 23 hours' and now() + interval '30 days 1 hour'
                when 'recent.example' then
                  expires_at between verified_at + interval '365 days' - interval '1 minute'
                                 and verified_at + interval '365 days' + interval '1 minute'
                when 'nearly.example' then
                  expires_at between now() + interval '29 days 23 hours' and now() + interval '30 days 1 hour'
              end as sound
       from tula.organization_domains`
    )
    rows = Object.fromEntries(
      read.rows.map((one) => [
        one.domain,
        { expires: one.expires, sound: one.sound, remindedDays: one.reminded_days },
      ])
    )
  })
  afterAll(() => client.close())

  test('is found among the migrations', () => {
    expect(at).toBeGreaterThan(0)
  })

  test('a domain whose year is over keeps matching for 30 days, so nobody is cut off the day it ships', () => {
    expect(rows['old.example']?.sound).toBe(true)
  })

  test('a recently verified domain keeps its full year from the day it was verified', () => {
    expect(rows['recent.example']?.sound).toBe(true)
  })

  test('a domain with less than the grace left is given the grace, never less than it had', () => {
    expect(rows['nearly.example']?.sound).toBe(true)
  })

  test('a pending claim has no deadline, and no row has been reminded', () => {
    expect(rows['waiting.example']?.expires).toBeNull()
    for (const one of Object.values(rows)) {
      expect(one.remindedDays).toBeNull()
    }
  })

  test('a verified row without a deadline is refused afterwards, and so is a deadline on a pending one', async () => {
    await expect(
      client.exec(
        `update tula.organization_domains set expires_at = null where domain = 'recent.example'`
      )
    ).rejects.toThrow()
    await expect(
      client.exec(
        `update tula.organization_domains set expires_at = now() where domain = 'waiting.example'`
      )
    ).rejects.toThrow()
  })

  test('row-level security is forced again afterwards', async () => {
    const forced = await client.query<{ relforcerowsecurity: boolean }>(
      `select relforcerowsecurity from pg_class
       where relname = 'organization_domains' and relnamespace = 'tula'::regnamespace`
    )
    expect(forced.rows).toEqual([{ relforcerowsecurity: true }])
  })
})
