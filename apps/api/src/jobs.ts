import type { Deps } from '~/dependencies'
import * as logger from '~/lib/logger'
import { errorReason } from '~/lib/safe-error'
import * as Retention from '~/modules/retention/service'
import * as Webhooks from '~/modules/webhook/service'
import type { ExclusiveJob } from '~/ports/job-lock'

/** The two timer functions {@link startJobs} uses: the platform's, or a test's. */
export interface JobTimers {
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(timer: unknown): void
}

/** The background jobs a process has started, and how it stops them. */
export interface RunningJobs {
  /** Stop the timers: no further round is started. A round under way goes on. */
  stopTimers(): void
  /**
   * End the delivery round under way and wait for it: it finishes the requests it is making
   * (each at most its deadline), records them, and stops. Also stops the timers. Call it
   * before the database pool is closed.
   */
  finish(): Promise<void>
}

const systemTimers: JobTimers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (timer) => clearInterval(timer as ReturnType<typeof setInterval>),
}

/**
 * Put a process's background jobs on their timers: each runs once now and then on its own
 * interval. **The only scheduling path**, for an API instance (`server.ts`) and for the
 * webhook worker (`worker.ts`) alike; which jobs a process runs is `planProcess`'s answer.
 *
 * Every process that runs a job starts the same timer; the job lock inside `Retention.run`
 * and `Webhooks.run` lets one of them through each round, and the others skip it. A delivery
 * round that is still running when the next is due is not started twice here either: the lock
 * would refuse it anyway, and not starting it keeps one round for {@link RunningJobs.finish}
 * to wait for. A round that throws (the database is down) is logged and the next one runs.
 *
 * @param deps - What the jobs need.
 * @param jobs - The jobs this process runs (`planProcess(role, mode).jobs`).
 * @param timers - The timer functions; a test passes its own.
 * @returns How to stop them.
 */
export function startJobs(
  deps: Deps,
  jobs: readonly ExclusiveJob[],
  timers: JobTimers = systemTimers
): RunningJobs {
  const started: unknown[] = []
  let stopped = false
  const deliveryStop = new AbortController()
  let deliveryRound: Promise<void> | null = null

  async function runRetention() {
    try {
      await Retention.run(deps)
    } catch (error) {
      logger.warn('could not run the retention job', { err: errorReason(error) })
    }
  }

  async function runDelivery() {
    try {
      await Webhooks.run(deps, deliveryStop.signal)
    } catch (error) {
      logger.warn('could not run the webhook delivery job', { err: errorReason(error) })
    }
  }

  function startDelivery() {
    deliveryRound ??= runDelivery().finally(() => {
      deliveryRound = null
    })
  }

  /** Run a job now and on its interval, unless the process is stopping. */
  function schedule(run: () => void, intervalMs: number) {
    const guarded = () => {
      if (!stopped) {
        run()
      }
    }
    guarded()
    started.push(timers.setInterval(guarded, intervalMs))
  }

  if (jobs.includes('retention')) {
    schedule(() => void runRetention(), Retention.RETENTION_INTERVAL_MS)
  }
  if (jobs.includes('webhook_delivery')) {
    schedule(startDelivery, Webhooks.WEBHOOK_DELIVERY_INTERVAL_MS)
  }

  function stopTimers() {
    stopped = true
    for (const timer of started) {
      timers.clearInterval(timer)
    }
  }

  return {
    stopTimers,
    async finish() {
      stopTimers()
      // A delivery that was sent and not yet recorded would be sent again by the next round:
      // the round under way finishes the requests it is making, records them and stops.
      deliveryStop.abort()
      await deliveryRound
    },
  }
}
