import { type Container, createContainer } from '~/container'
import { loadEnv } from '~/env'
import { startJobs } from '~/jobs'
import * as logger from '~/lib/logger'
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

// Liveness and readiness for the orchestrator and the image's HEALTHCHECK. Nothing of the API
// is on this port, and it needs no route to the outside: do not publish it.
const server = Bun.serve({
  port: env.PORT,
  fetch: createWorkerApp(container.deps).fetch,
})

logger.info('tula webhook worker started', {
  health: server.url.href,
  environment: env.ENVIRONMENT,
})

// A database that is away is not fatal here: the round is logged as failed, `/v1/ready`
// answers 503, and the next round tries again. Several workers may run; the job lock lets one
// through each round.
const jobs = startJobs(container.deps, container.plan.jobs)

shutdownOnSignal(async () => {
  // The round under way finishes the requests it is making (each at most its deadline, well
  // inside the shutdown timeout), records them and stops; what it had not started waits for
  // another worker's round, or this one's next start. Health keeps answering until then.
  await jobs.finish()
  await server.stop()
  await container.close()
})
