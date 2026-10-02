import { createContainer } from '~/container'
import { loadEnv } from '~/env'
import { createApp, MAX_BODY_BYTES } from '~/index'
import * as logger from '~/lib/logger'
import * as Flows from '~/modules/flow/service'
import * as Jwks from '~/modules/jwks/service'

const env = loadEnv()
const container = createContainer(env)

// Create signing keys before taking traffic so every instance's key cache starts with them.
const bootstrap = await Jwks.ensureAllEnvironments(container.deps)
logger.info('signing keys ready', bootstrap)

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
      err: error instanceof Error ? error.message : String(error),
    })
  }
}
void purgeFlowAttempts()
const purgeTimer = setInterval(() => void purgeFlowAttempts(), PURGE_INTERVAL_MS)

async function shutdown(signal: string) {
  logger.info('shutting down', { signal })
  clearInterval(purgeTimer)
  // Stop accepting connections and let in-flight requests finish before closing the pool.
  await server.stop()
  await container.close()
  process.exit(0)
}

process.once('SIGTERM', () => void shutdown('SIGTERM'))
process.once('SIGINT', () => void shutdown('SIGINT'))
