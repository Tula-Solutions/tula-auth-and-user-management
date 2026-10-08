import * as logger from '~/lib/logger'
import { errorReason } from '~/lib/safe-error'

/** How long a process gets to finish what it is doing before it exits anyway. */
export const SHUTDOWN_TIMEOUT_MS = 10_000

/**
 * Close a process cleanly on `SIGTERM` or `SIGINT`, once, and exit.
 *
 * Shared by the API (`server.ts`) and the webhook worker (`worker.ts`). Exits 0 when `close`
 * resolved, 1 when it threw or took longer than {@link SHUTDOWN_TIMEOUT_MS}: a hung request
 * or a hung round must not hold the process until the orchestrator kills it uncleanly.
 *
 * @param close - Everything to end, in order, before the process exits.
 */
export function shutdownOnSignal(close: () => Promise<void>): void {
  async function shutdown(signal: string) {
    logger.info('shutting down', { signal })
    setTimeout(() => {
      logger.error('shutdown timed out; exiting', { timeoutMs: SHUTDOWN_TIMEOUT_MS })
      process.exit(1)
    }, SHUTDOWN_TIMEOUT_MS).unref()
    try {
      await close()
      process.exit(0)
    } catch (error) {
      logger.error('shutdown failed', { err: errorReason(error) })
      process.exit(1)
    }
  }
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
  process.once('SIGINT', () => void shutdown('SIGINT'))
}
