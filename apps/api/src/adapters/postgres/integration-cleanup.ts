// Apart from `integration-support.ts` so that a unit test can load it: that file needs a
// Postgres server for everything else it does, and coverage is counted per file.

/**
 * Run every step, one after another, whether or not an earlier one failed.
 *
 * For cleanup: a pool that will not close must not leave the other pool open or the run's
 * tenants in the database.
 *
 * @param steps - The steps, in order.
 * @throws The first failure, after every step has run.
 */
export async function runEvery(steps: readonly (() => Promise<unknown>)[]): Promise<void> {
  const failures: unknown[] = []
  for (const step of steps) {
    try {
      await step()
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) {
    throw failures[0]
  }
}
