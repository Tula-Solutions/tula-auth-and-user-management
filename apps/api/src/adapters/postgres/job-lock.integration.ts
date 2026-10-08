import { afterAll } from 'bun:test'
import { createDatabase } from '@tula/db'
import { describeJobLock } from '~/adapters/job-lock.suite'
import { PostgresJobLock } from '~/adapters/postgres/job-lock'

/**
 * The job lock against a real Postgres, with two pools standing in for two API instances: the
 * run that proves only one instance runs a job (retention, webhook delivery), and that one job
 * does not hold up the other. PGlite cannot show it (one session).
 *
 * Uses the database of `docker compose up -d` as the runtime login. It takes the real locks,
 * so an API running against the same database skips a round while a test holds one.
 */
const url = process.env.DATABASE_URL
if (!url) {
  throw new Error('Integration tests need DATABASE_URL (see .env.example)')
}

const first = createDatabase(url, { max: 2 })
const second = createDatabase(url, { max: 2 })

afterAll(async () => {
  await first.close()
  await second.close()
})

describeJobLock('PostgresJobLock on two real sessions', async () => ({
  first: new PostgresJobLock(first.withAdvisoryLock),
  second: new PostgresJobLock(second.withAdvisoryLock),
}))
