import { useEffect, useState } from 'react'

/**
 * Count down to a moment, one tick a second.
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
