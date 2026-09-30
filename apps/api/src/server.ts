import { createContainer } from '~/container'
import { loadEnv } from '~/env'
import { createApp } from '~/index'
import * as logger from '~/lib/logger'
import * as Jwks from '~/modules/jwks/service'

const env = loadEnv()
const container = createContainer(env)

// Create signing keys before taking traffic so every instance's key cache starts with them.
const bootstrap = await Jwks.ensureAllEnvironments(container.deps)
logger.info('signing keys ready', bootstrap)

const server = Bun.serve({ port: env.PORT, fetch: createApp(container.deps).fetch })

logger.info('tula api listening', { url: server.url.href, environment: env.ENVIRONMENT })

async function shutdown(signal: string) {
  logger.info('shutting down', { signal })
  // Stop accepting connections and let in-flight requests finish before closing the pool.
  await server.stop()
  await container.close()
  process.exit(0)
}

process.once('SIGTERM', () => void shutdown('SIGTERM'))
process.once('SIGINT', () => void shutdown('SIGINT'))
