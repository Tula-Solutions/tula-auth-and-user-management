import * as logger from '~/lib/logger'
import { errorReason } from '~/lib/safe-error'

/**
 * Wait for `work` at most `ms`. The signal it is given is aborted at the deadline: giving up
 * on the answer does not stop the work, so work that makes many calls must look at it.
 */
function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`timed out after ${ms}ms`)
      controller.abort(error)
      reject(error)
    }, ms)
  })
  return Promise.race([work(controller.signal), timeout]).finally(() => clearTimeout(timer))
}

/**
 * Run a probe; its failure goes to the log and comes back as `null`, never as text.
 *
 * @param id - The check the probe belongs to, for the log line.
 * @param work - The probe. Its signal is aborted at the deadline.
 * @param timeoutMs - How long to wait for it.
 * @returns The probe's value in a box, or `null` when it failed or did not answer in time.
 */
export async function attempt<T>(
  id: string,
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number
): Promise<{ value: T } | null> {
  try {
    return { value: await withTimeout(work, timeoutMs) }
  } catch (error) {
    logger.warn('diagnostic check failed', { check: id, reason: errorReason(error) })
    return null
  }
}

/**
 * A count with its noun, in the singular for one.
 *
 * @param count - How many.
 * @param noun - The noun, singular.
 * @returns `1 environment`, `2 environments`.
 */
export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}
