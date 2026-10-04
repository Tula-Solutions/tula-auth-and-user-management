import { afterAll } from 'bun:test'
import { createDatabase } from '@tula/db'
import { describeEnvironmentLock } from '~/adapters/environment-lock.suite'
import { PostgresEnvironmentLock } from '~/adapters/postgres/environment-lock'

/**
 * The environment lock against a real Postgres, with two pools standing in for two API
 * instances: the run that proves a settings write and a provider write of one environment take
 * turns across instances. PGlite cannot show it (one session).
 *
 * Uses the database of `docker compose up -d` as the runtime login. The suite's environment ids
 * are not real environments, so an API running against the same database is not held up.
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

describeEnvironmentLock('PostgresEnvironmentLock on two real sessions', async () => ({
  first: new PostgresEnvironmentLock(first.withAdvisoryLock),
  second: new PostgresEnvironmentLock(second.withAdvisoryLock),
}))
