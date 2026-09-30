import type { Deps } from '~/dependencies'
import * as logger from '~/lib/logger'
import type { ReadinessResponse, StatusResponse } from '~/modules/status/schema'
import { version } from '../../../package.json'

/** How long one readiness probe may take before it counts as failed. */
export const PROBE_TIMEOUT_MS = 2_000

/**
 * Liveness: the process is running and can serve requests. Touches no dependency, so a database
 * outage never makes an orchestrator restart healthy instances.
 *
 * @returns The status and API version.
 */
export function status(): StatusResponse {
  return { status: 'ok', version }
}

function withTimeout(check: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
  })
  return Promise.race([check, timeout]).finally(() => clearTimeout(timer))
}

/**
 * Readiness: run every probe in parallel, each bounded by a timeout.
 *
 * Failure reasons are logged but not returned, since driver errors can name hosts and users.
 *
 * @param deps - The probes to run.
 * @param timeoutMs - Per-probe timeout (default {@link PROBE_TIMEOUT_MS}).
 * @returns `ready` only when every probe passed, with a per-probe result.
 */
export async function ready(
  deps: Pick<Deps, 'probes'>,
  timeoutMs: number = PROBE_TIMEOUT_MS
): Promise<ReadinessResponse> {
  const results = await Promise.all(
    deps.probes.map(async (probe) => {
      try {
        await withTimeout(probe.check(), timeoutMs)
        return [probe.name, 'ok'] as const
      } catch (error) {
        logger.warn('readiness probe failed', {
          probe: probe.name,
          reason: error instanceof Error ? error.message : String(error),
        })
        return [probe.name, 'fail'] as const
      }
    })
  )
  const checks = Object.fromEntries(results)
  return {
    status: results.every(([, result]) => result === 'ok') ? 'ready' : 'not_ready',
    checks,
  }
}
