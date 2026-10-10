import type { Schedule } from '../secure-storage'

/** A test's own time for the secure-store adapter: nothing waits on a real timer. */
export interface FakeSchedule {
  /** What to hand the adapter. */
  readonly schedule: Schedule
  /** Every wait that was asked for, in order, in milliseconds. */
  readonly asked: number[]
  /** How many waits have neither run nor been called off. */
  pending(): number
  /**
   * Let time pass: what falls due runs in order, each with the promises it settles.
   *
   * @param ms - How much time passes.
   */
  advance(ms: number): Promise<void>
}

/** Let every promise that is ready settle, and what those settle too. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) {
    await Promise.resolve()
  }
}

/**
 * A schedule a test moves by hand.
 *
 * A wait of at most `atOnce` milliseconds runs by itself on the next turn: the adapter's
 * short waits are inside a call the test awaits, deep inside a client's refresh, and a test
 * has no moment at which it could move time for them. A longer wait runs only when
 * `advance` reaches it.
 *
 * @param atOnce - The longest wait that runs without `advance`. `0` holds every wait.
 * @returns The schedule and what moves it.
 */
export function fakeSchedule(atOnce = 0): FakeSchedule {
  let now = 0
  let waiting: { due: number; run: () => void }[] = []
  const asked: number[] = []
  return {
    asked,
    schedule(run, ms) {
      asked.push(ms)
      if (ms <= atOnce) {
        let off = false
        void Promise.resolve().then(() => {
          if (!off) {
            run()
          }
        })
        return () => {
          off = true
        }
      }
      const entry = { due: now + ms, run }
      waiting.push(entry)
      return () => {
        waiting = waiting.filter((other) => other !== entry)
      }
    },
    pending: () => waiting.length,
    async advance(ms) {
      const until = now + ms
      await settle()
      for (;;) {
        const next = waiting.filter((entry) => entry.due <= until).sort((a, b) => a.due - b.due)[0]
        if (!next) {
          break
        }
        waiting = waiting.filter((entry) => entry !== next)
        now = next.due
        next.run()
        await settle()
      }
      now = until
    },
  }
}
