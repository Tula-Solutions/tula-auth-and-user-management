import { createContainer } from '~/container'
import { loadEnv } from '~/env'
import { createApp, MAX_BODY_BYTES } from '~/index'
import { startJobs } from '~/jobs'
import * as logger from '~/lib/logger'
import { errorReason } from '~/lib/safe-error'
import { shutdownOnSignal } from '~/lib/shutdown'
import * as Jwks from '~/modules/jwks/service'
import * as Notices from '~/modules/notice/service'

const env = loadEnv()
const container = createContainer(env)

// Create signing keys before taking traffic so every instance's key cache starts with them.
const bootstrap = await Jwks.ensureAllEnvironments(container.deps).catch((error: unknown) => {
  // Listing environments is the first query of the process: say plainly what is wrong.
  logger.error('could not reach the database at start-up', { err: errorReason(error) })
  process.exit(1)
})
if (bootstrap.failed > 0) {
  // Most often a TULA_MASTER_KEY that is not the one the stored keys were encrypted with.
  logger.error('signing keys are unusable in some environments; sign-in will fail there', bootstrap)
} else {
  logger.info('signing keys ready', bootstrap)
}

const server = Bun.serve({
  port: env.PORT,
  // Refuse oversized bodies at the socket too; `createApp` enforces the same cap per request.
  maxRequestBodySize: MAX_BODY_BYTES,
  fetch: createApp(container.deps).fetch,
})

logger.info('tula api listening', { url: server.url.href, environment: env.ENVIRONMENT })
if (!container.plan.deliversWebhooks) {
  // On every boot, so that nobody runs this way without having been told: with no worker
  // process running, nothing is delivered (`tula doctor` shows what is waiting).
  logger.info(
    'WEBHOOK_WORKER=separate: this API instance makes no webhook delivery. A worker process (the same image, `bun run src/worker.ts`) must be running.'
  )
}

// The background jobs this process runs (`planProcess`): retention always, and the webhook
// worker (ADR 0034) unless it is its own service. Every instance starts the same timers; the
// job lock inside each job lets one of them through each round, and the others skip it.
const jobs = startJobs(container.deps, container.plan.jobs)

shutdownOnSignal(async () => {
  jobs.stopTimers()
  // Stop accepting connections and let in-flight requests finish before closing the pool.
  await server.stop()
  // Security notices are sent after the response; let the ones under way reach the relay.
  await Notices.settled()
  // A delivery that was sent and not yet recorded would be sent again by the next round:
  // the round under way finishes the one delivery it is making (at most its deadline, well
  // inside the shutdown timeout), records it, and stops, before the pool closes.
  await jobs.finish()
  await container.close()
})
