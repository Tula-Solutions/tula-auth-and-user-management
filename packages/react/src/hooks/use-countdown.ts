import type { TulaError } from '@tula-tech/core'
import { useEffect, useState } from 'react'

/**
 * Count down to a moment, one tick a second.
 *
 * Keep it pure: never compute `until` from `Date.now()` in render (a render must not read the
 * clock, and the value would change on every render and restart the timer). Take it from an
 * effect or an event handler, or use {@link useRetryCountdown}.
 *
 * @param until - The moment (`Date.now()` scale), or `null` for no countdown.
 * @returns Whole seconds left; `0` when there is no countdown or it has ended.
 */
export function useCountdown(until: number | null): number {
  const [secondsLeft, setSecondsLeft] = useState(0)
  useEffect(() => {
    if (until === null) {
      setSecondsLeft(0)
      return
    }
    const tick = () => {
      const left = Math.max(0, Math.ceil((until - Date.now()) / 1000))
      setSecondsLeft(left)
      return left
    }
    if (tick() === 0) {
      return
    }
    const timer = setInterval(() => {
      if (tick() === 0) {
        clearInterval(timer)
      }
    }, 1000)
    return () => clearInterval(timer)
  }, [until])
  return secondsLeft
}

/**
 * Count down a rate limit: the seconds until a failed action may be tried again.
 *
 * The moment is read from the clock in an effect when the error arrives, never during render.
 * It restarts for each new `rate_limited` error and is `0` for any other error, or none.
 *
 * It lags the error by one commit: the render that first sees a new error returns `0`, because
 * the moment is read from the clock in an effect; the next render returns the wait. Draw the
 * wait from this value, not from a render-time subtraction.
 *
 * @param error - The failed action's error (a flow hook's `error`), or `null`.
 * @returns Whole seconds left; `0` when nothing is limited or the wait is over.
 *
 * @example
 * ```tsx
 * const { error } = useSignIn()
 * const wait = useRetryCountdown(error)
 * // <button aria-disabled={wait > 0}>Try again{wait > 0 ? ` in ${wait}s` : ''}</button>
 * ```
 */
export function useRetryCountdown(error: TulaError | null): number {
  const [until, setUntil] = useState<number | null>(null)
  useEffect(() => {
    setUntil(error?.retryAfterMs ? Date.now() + error.retryAfterMs : null)
  }, [error])
  return useCountdown(until)
}
