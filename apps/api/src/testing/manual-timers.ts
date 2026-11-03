/** A timer that has been started through {@link ManualTimers.after}. */
export interface ManualTimer {
  /** The delay it was started with, in milliseconds. */
  ms: number
  /** Whether it has been cancelled by the code that started it. */
  cancelled: boolean
  /** Whether {@link ManualTimers.fire} has fired it. */
  fired: boolean
}

/** Timers that go off when a test says so, and never because time passed. */
export interface ManualTimers {
  /** The timer to hand to the code under test (it matches `After` of the sign-in test). */
  after: (ms: number, fire: () => void) => () => void
  /** Every timer started so far, in order, whether it is still pending or not. */
  started: readonly ManualTimer[]
  /**
   * Resolve once `count` timers with this delay have been started (cancelled ones count), so
   * that a test waits on the code under test reaching a point and not on a clock.
   *
   * @param ms - The delay the timers were started with.
   * @param count - How many must have been started. Defaults to 1.
   */
  registered(ms: number, count?: number): Promise<void>
  /**
   * Fire every timer with this delay that is still pending.
   *
   * @param ms - The delay.
   * @returns How many were fired.
   */
  fire(ms: number): number
}

/**
 * Timers for a test of code that keeps a time limit: the limit is reached when the test
 * calls {@link ManualTimers.fire}, not when a loaded machine gets there (TULA-133). Give
 * each kind of limit a delay of its own so that a test can name the one it means.
 *
 * @returns The timers.
 */
export function manualTimers(): ManualTimers {
  const started: ManualTimer[] = []
  const fires = new Map<ManualTimer, () => void>()
  const waiting: { ms: number; count: number; resolve: () => void }[] = []

  function notify() {
    for (const waiter of [...waiting]) {
      if (started.filter((timer) => timer.ms === waiter.ms).length >= waiter.count) {
        waiting.splice(waiting.indexOf(waiter), 1)
        waiter.resolve()
      }
    }
  }

  return {
    started,
    after(ms, fire) {
      const timer: ManualTimer = { ms, cancelled: false, fired: false }
      started.push(timer)
      fires.set(timer, fire)
      notify()
      return () => {
        timer.cancelled = true
      }
    },
    registered(ms, count = 1) {
      return new Promise<void>((resolve) => {
        waiting.push({ ms, count, resolve })
        notify()
      })
    },
    fire(ms) {
      let fired = 0
      for (const timer of started) {
        const fire = fires.get(timer)
        if (timer.ms === ms && !timer.cancelled && !timer.fired && fire) {
          timer.fired = true
          fired += 1
          fire()
        }
      }
      return fired
    },
  }
}
