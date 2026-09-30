import { durationToMs } from '@tula/contract'
import type { Clock } from '~/ports/clock'

/** Default start time for test clocks. */
export const TEST_EPOCH = new Date('2026-01-01T00:00:00.000Z')

/** A clock that only moves when told to, so expiry tests never sleep. */
export class FixedClock implements Clock {
  #now: number

  /** @param start - The initial time (default {@link TEST_EPOCH}). */
  constructor(start: Date = TEST_EPOCH) {
    this.#now = start.getTime()
  }

  /** @returns A copy of the current time. */
  now(): Date {
    return new Date(this.#now)
  }

  /**
   * Move time forward.
   *
   * @param by - A duration such as `'10m'`, or milliseconds.
   */
  advance(by: string | number): void {
    this.#now += typeof by === 'number' ? by : durationToMs(by)
  }

  /** @param to - The new current time. */
  set(to: Date): void {
    this.#now = to.getTime()
  }
}
