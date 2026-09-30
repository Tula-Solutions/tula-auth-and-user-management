import type { Clock } from '~/ports/clock'

/** The real wall clock. */
export const systemClock: Clock = {
  now: () => new Date(),
}
