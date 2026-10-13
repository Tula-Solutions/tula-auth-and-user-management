/** Testing Library's `act`, as far as this module uses it. */
type Act = (callback: () => Promise<void>) => Promise<void>

/** Testing Library's `asyncWrapper`: what `findBy…`, `waitFor` and every user-event call run in. */
type AsyncWrapper = (callback: () => Promise<unknown>) => Promise<unknown>

/**
 * Whether a test has replaced the timers (`jest.useFakeTimers()` from `bun:test`). A turn of the
 * event loop cannot be waited for then: `setImmediate` is faked too, and the test moves time by
 * hand.
 *
 * The check is this package's own. Bun's fake timers put a `clock` property on `setTimeout`,
 * which is half of what Testing Library looks for; the other half is a global `jest`, which
 * Bun does not define, so Testing Library itself never takes Bun's fake timers to be on.
 * `harness.test.tsx` holds that this check sees them.
 */
function timersAreFaked(): boolean {
  return Object.hasOwn(globalThis.setTimeout, 'clock')
}

/**
 * Wait until React has finished what the last commit started: its effects, and every render
 * and effect those ask for.
 *
 * Why it is needed. Outside `act`, React works through its scheduler, a turn of the event loop
 * at a time: a commit, then the commit's effects, then the render an effect asked for.
 * `findBy…` returns once the element is in the document, that is after the commit, and Testing
 * Library then waits for one zero-delay timer. Whether React's next turn or that timer comes
 * first depends on whether the timer is due yet, which is to say on whether a millisecond has
 * passed: on a laptop it has not, on a CI runner sharing its cores with the other packages'
 * tests it sometimes has. The test then goes on with a screen whose effects have not run, or
 * have run but not been drawn: a control that an effect was about to take away is still there,
 * and the focus an effect was about to move arrives after the test has started typing (React
 * runs a pending effect before the first key's render) and takes the rest of the keys with it.
 *
 * How it works, with no timing in it. The scheduler queues its turns with `setImmediate`, and
 * immediates run in the order they were queued, so one immediate queued here runs after the
 * turn React already had waiting. That turn runs inside `act`, so whatever it schedules
 * (the render an effect asked for, its effects, and so on) is collected by `act` and run to the
 * end before `act` returns.
 *
 * @param act - Testing Library's `act`.
 * @returns When React has nothing left to do. At once where the timers are faked.
 */
export async function reactSettled(act: Act): Promise<void> {
  if (timersAreFaked()) {
    return
  }
  await act(
    () =>
      new Promise<void>((resolve) => {
        setImmediate(resolve)
      })
  )
}

/**
 * Make Testing Library's async utilities return a settled page: `findBy…`, `waitFor` and each
 * user-event call come back only after {@link reactSettled}.
 *
 * @param wrapper - The `asyncWrapper` Testing Library is configured with.
 * @param act - Testing Library's `act`.
 * @returns The wrapper to configure in its place.
 */
export function settlingWrapper(wrapper: AsyncWrapper, act: Act): AsyncWrapper {
  return (callback) =>
    wrapper(async () => {
      const result = await callback()
      await reactSettled(act)
      return result
    })
}
