import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'

// Migration 0019 rewrites the rows 0018 wrote into the new shape, with SQL written by hand.
// This applies the migrations up to 0018, writes rows of the old shape, applies 0019 and reads
// what became of them.
//
// PGlite's own role is a superuser, which row-level security never binds, so this does NOT
// show that the backfill reaches the rows when the migrating role is an ordinary owner (the
// reason 0019 lifts FORCE for the length of the backfill); it shows the backfill's logic, and
// that FORCE is back afterwards.

const MIGRATIONS = join(import.meta.dir, '..', 'migrations')
const files = readdirSync(MIGRATIONS)
  .filter((name) => name.endsWith('.sql'))
  .sort()

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
const ENDPOINT = '0199c2f4-0000-7000-8000-000000000004'

/** A delivery row of the 0018 shape, and the event it is of. */
interface Old {
  key: string
  outcome: 'delivered' | 'failed'
  statusCode: number | null
  durationMs: number
  failureReason: string | null
  /** How long ago the row was written, as a Postgres interval. */
  age: string
}

const OLD: Old[] = [
  {
    key: 'a1',
    outcome: 'delivered',
    statusCode: 204,
    durationMs: 12,
    failureReason: null,
    age: '1 hour',
  },
  {
    key: 'a2',
    outcome: 'failed',
    statusCode: 500,
    durationMs: 34,
    failureReason: null,
    age: '1 hour',
  },
  {
    key: 'a3',
    outcome: 'failed',
    statusCode: null,
    durationMs: 5000,
    failureReason: 'timeout',
    age: '1 hour',
  },
  // Settled without being tried, recently: handed back to the worker.
  {
    key: 'a4',
    outcome: 'failed',
    statusCode: null,
    durationMs: 0,
    failureReason: 'endpoint_unresponsive',
    age: '1 hour',
  },
  {
    key: 'a5',
    outcome: 'failed',
    statusCode: null,
    durationMs: 0,
    failureReason: 'signing_failed',
    age: '2 days',
  },
  // The same, but older than the age at which a delivery is given up: stays given up.
  {
    key: 'a6',
    outcome: 'failed',
    statusCode: null,
    durationMs: 0,
    failureReason: 'endpoint_unresponsive',
    age: '4 days',
  },
]

const idOf = (prefix: string, key: string) => `0199c2f4-${prefix}-7000-8000-0000000000${key}`

describe('migration 0019 carries the delivery rows of 0018 over', () => {
  let client: PGlite
  let rows: Record<string, Record<string, unknown>>
  let attempts: Record<string, unknown>[]

  beforeAll(async () => {
    client = new PGlite()
    // What the migrator makes before the first migration; 0014 reads it.
    await client.exec(
      'create schema drizzle; create table drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)'
    )
    for (const name of files.filter((file) => file < '0019')) {
      await apply(client, name)
    }
    await client.exec(`
      insert into tula.workspaces (id, name) values ('${WORKSPACE}', 'w');
      insert into tula.projects (id, workspace_id, name) values ('${PROJECT}', '${WORKSPACE}', 'p');
      insert into tula.environments (id, project_id, kind) values ('${ENVIRONMENT}', '${PROJECT}', 'development');
      insert into tula.webhook_endpoints (id, project_id, environment_id, url, event_types, secret)
        values ('${ENDPOINT}', '${PROJECT}', '${ENVIRONMENT}', 'https://hooks.example.com', '{user.created}', 'sealed');
    `)
    for (const old of OLD) {
      const reason = old.failureReason === null ? 'null' : `'${old.failureReason}'`
      await client.exec(`
        insert into tula.events (id, project_id, environment_id, type, payload, delivered_at)
          values ('${idOf('1111', old.key)}', '${PROJECT}', '${ENVIRONMENT}', 'user.banned', '{}', now());
        insert into tula.webhook_deliveries
          (id, project_id, environment_id, endpoint_id, event_id, attempted_at, outcome, status_code, duration_ms, failure_reason, created_at)
          values ('${idOf('2222', old.key)}', '${PROJECT}', '${ENVIRONMENT}', '${ENDPOINT}', '${idOf('1111', old.key)}',
                  now() - interval '${old.age}', '${old.outcome}', ${old.statusCode ?? 'null'}, ${old.durationMs}, ${reason},
                  now() - interval '${old.age}');
      `)
    }
    for (const name of files.filter((file) => file >= '0019')) {
      await apply(client, name)
    }
    const read = await client.query<Record<string, unknown>>(
      `select id, event_type, test, state, attempts, status_code, failure_reason,
              next_attempt_at is not null as due, last_attempt_at is not null as tried,
              completed_at is not null as completed
       from tula.webhook_deliveries`
    )
    rows = Object.fromEntries(read.rows.map((row) => [String(row.id).slice(-2), row]))
    attempts = (
      await client.query<Record<string, unknown>>(
        `select delivery_id, attempt, status_code, duration_ms, failure_reason
         from tula.webhook_delivery_attempts order by delivery_id`
      )
    ).rows
  })
  afterAll(() => client.close())

  test('every row has its event’s type and is no test', () => {
    expect(Object.keys(rows).sort()).toEqual(OLD.map((old) => old.key))
    for (const row of Object.values(rows)) {
      expect(row).toMatchObject({ event_type: 'user.banned', test: false })
    }
  })

  test('a delivered row is delivered, with its one request as attempt 1', () => {
    expect(rows.a1).toMatchObject({
      state: 'delivered',
      attempts: 1,
      status_code: 204,
      due: false,
      tried: true,
      completed: true,
    })
  })

  test('a request that failed before retries existed stays given up and is not sent again', () => {
    expect(rows.a2).toMatchObject({ state: 'failed', attempts: 1, status_code: 500, due: false })
    expect(rows.a3).toMatchObject({
      state: 'failed',
      attempts: 1,
      failure_reason: 'timeout',
      due: false,
      completed: true,
    })
  })

  test('a row that was settled without being tried, in the last three days, is handed back to the worker with no attempt counted', () => {
    for (const key of ['a4', 'a5']) {
      expect(rows[key]).toMatchObject({
        state: 'pending',
        attempts: 0,
        due: true,
        tried: false,
        completed: false,
      })
    }
  })

  test('one older than that stays given up, still with no attempt counted', () => {
    expect(rows.a6).toMatchObject({ state: 'failed', attempts: 0, due: false, tried: false })
  })

  test('only rows that were a request have an attempt, and it holds what the row held', () => {
    expect<unknown>(
      attempts.map((attempt) => ({
        ...attempt,
        delivery_id: String(attempt.delivery_id).slice(-2),
      }))
    ).toEqual([
      { delivery_id: 'a1', attempt: 1, status_code: 204, duration_ms: 12, failure_reason: null },
      { delivery_id: 'a2', attempt: 1, status_code: 500, duration_ms: 34, failure_reason: null },
      {
        delivery_id: 'a3',
        attempt: 1,
        status_code: null,
        duration_ms: 5000,
        failure_reason: 'timeout',
      },
    ])
  })

  test('row-level security is forced again on both tables the backfill lifted it from', async () => {
    const forced = await client.query<{ relname: string; relforcerowsecurity: boolean }>(
      `select relname, relforcerowsecurity from pg_class
       where relname in ('events', 'webhook_deliveries', 'webhook_delivery_attempts') order by relname`
    )
    expect(forced.rows).toEqual([
      { relname: 'events', relforcerowsecurity: true },
      { relname: 'webhook_deliveries', relforcerowsecurity: true },
      { relname: 'webhook_delivery_attempts', relforcerowsecurity: true },
    ])
  })
})
