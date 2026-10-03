import { createContainer } from '~/container'
import { loadEnv } from '~/env'
import { createApp, MAX_BODY_BYTES } from '~/index'
import * as logger from '~/lib/logger'
import { errorReason } from '~/lib/safe-error'
import * as Flows from '~/modules/flow/service'
import * as Jwks from '~/modules/jwks/service'

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

/** How often expired sign-in and sign-up attempts are deleted. */
const PURGE_INTERVAL_MS = 10 * 60_000

// Abandoned sign-ups hold the hash of a password that was never used; remove them once expired.
async function purgeFlowAttempts() {
  try {
    const removed = await Flows.purgeExpired(container.deps)
    if (removed > 0) {
      logger.info('purged expired flow attempts', { removed })
    }
  } catch (error) {
    logger.warn('could not purge expired flow attempts', {
      err: errorReason(error),
    })
  }
}
void purgeFlowAttempts()
const purgeTimer = setInterval(() => void purgeFlowAttempts(), PURGE_INTERVAL_MS)

/** How long in-flight requests get to finish before the process exits anyway. */
const SHUTDOWN_TIMEOUT_MS = 10_000

async function shutdown(signal: string) {
  logger.info('shutting down', { signal })
  clearInterval(purgeTimer)
  // A hung request must not hold the process until the orchestrator kills it uncleanly.
  setTimeout(() => {
    logger.error('shutdown timed out; exiting', { timeoutMs: SHUTDOWN_TIMEOUT_MS })
    process.exit(1)
  }, SHUTDOWN_TIMEOUT_MS).unref()
  try {
    // Stop accepting connections and let in-flight requests finish before closing the pool.
    await server.stop()
    await container.close()
    process.exit(0)
  } catch (error) {
    logger.error('shutdown failed', { err: errorReason(error) })
    process.exit(1)
  }
}

process.once('SIGTERM', () => void shutdown('SIGTERM'))
process.once('SIGINT', () => void shutdown('SIGINT'))
