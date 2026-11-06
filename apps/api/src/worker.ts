import { RuntimeRoleRefusedError } from '~/adapters/postgres/runtime-role'
import { type Container, createContainer } from '~/container'
import { loadEnv } from '~/env'
import { bootJobs } from '~/jobs'
import * as logger from '~/lib/logger'
import { errorReason } from '~/lib/safe-error'
import { shutdownOnSignal } from '~/lib/shutdown'
import { WorkerNotSeparateError } from '~/process'
import { createWorkerApp } from '~/worker-app'

// The webhook worker as its own process (ADR 0034, "The worker as its own service"): the same
// image as the API, started with `bun run src/worker.ts` where `WEBHOOK_WORKER=separate`. It
// runs delivery rounds, `Webhooks.run`, on the timer and under the job lock the API uses, and
// nothing else: no API route, no retention, no migration, no signing keys.

const env = loadEnv()

function build(): Container {
  try {
    return createContainer(env, 'worker')
  } catch (error) {
    if (error instanceof WorkerNotSeparateError) {
      // Before the logger has anything to say: one plain line, as `loadEnv` does.
      process.stderr.write(`${error.message}\n`)
      process.exit(1)
    }
    throw error
  }
}
const container = build()

/** How long the worker waits before asking about its database role again. */
const ROLE_CHECK_RETRY_MS = 5000

/**
 * Judge the database login once the database answers (H-227). A login that bypasses
 * row-level security stops the worker; a database that is away is asked again, as a round
 * would be, and no round starts before the login has passed.
 */
async function roleChecked(): Promise<void> {
  for (;;) {
    try {
      await container.verifyDatabaseRole()
      return
    } catch (error) {
      if (error instanceof RuntimeRoleRefusedError) {
        logger.error('refusing to start', { err: errorReason(error) })
        process.exit(1)
      }
      logger.warn('database login not checked yet: the database did not answer', {
        err: errorReason(error),
      })
      await Bun.sleep(ROLE_CHECK_RETRY_MS)
    }
  }
}

// Liveness and readiness for the orchestrator and the image's HEALTHCHECK. Nothing of the API
// is on this port, and it needs no route to the outside: do not publish it.
const server = Bun.serve({
  // All IPv4 interfaces on purpose: an orchestrator probes a container by its own address, not
  // by loopback. Named so the exposure is a decision (H-207): the port stays unpublished and
  // answers only status and readiness, nothing else.
  hostname: '0.0.0.0',
  port: env.PORT,
  fetch: createWorkerApp(container.deps).fetch,
})

logger.info('tula webhook worker started', {
  health: server.url.href,
  environment: env.ENVIRONMENT,
})

// A database that is away is not fatal here: the login check is asked again, `/v1/ready`
// answers 503, and the rounds start once the login has passed (a round that then finds the
// database away is logged as failed and the next one tries again). Several workers may run;
// the job lock lets one through each round.
let jobs: ReturnType<typeof bootJobs> | undefined
void roleChecked().then(() => {
  jobs = bootJobs(container)
})

shutdownOnSignal(async () => {
  // The round under way finishes the requests it is making (each at most its deadline, well
  // inside the shutdown timeout), records them and stops; what it had not started waits for
  // another worker's round, or this one's next start. Health keeps answering until then.
  await jobs?.finish()
  await server.stop()
  await container.close()
})
