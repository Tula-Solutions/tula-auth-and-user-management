import { type FlowStep, formatMessage, TulaError } from '@tula/core'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTulaContext } from '../context'
import { toTulaError } from '../errors'

/**
 * The state every flow hook shares.
 *
 * @example
 * ```ts
 * const { step, isPending, error }: FlowState = useSignIn()
 * ```
 */
export interface FlowState {
  /**
   * What the server is waiting for, discriminated by `status`; `null` before `start` (and
   * after `reset`). Draw one screen per status and treat any status you do not know as
   * "unsupported": a newer server may add steps.
   */
  step: FlowStep | null
  /** Whether an action is being sent. Disable the form meanwhile. */
  isPending: boolean
  /**
   * Why the last action failed, or `null`. `error.message` is ready to show; `error.errors`
   * lists field problems (every unmet password rule, for one); `error.retryAfterMs` says how
   * long a `rate_limited` lasts.
   */
  error: TulaError | null
  /** Forget the attempt and its error: back to before `start`. */
  reset(): void
  /** Forget the error (when the user edits the field it was about, say). */
  clearError(): void
}

/** A flow object from `@tula/core`, as far as the hooks care. */
interface CoreFlow {
  readonly step: FlowStep
}

/** What a flow hook is built from. */
export interface FlowController<Flow extends CoreFlow> extends FlowState {
  /**
   * Run the call that starts the flow and keep the flow object it resolves with.
   *
   * @param begin - Starts the flow.
   * @returns The first step, or `null` when it failed (see `error`).
   */
  start(begin: () => Promise<Flow>): Promise<FlowStep | null>
  /**
   * Run one action on the current flow.
   *
   * @param action - Calls the flow object.
   * @returns The next step, or `null` when it failed or no flow has been started.
   */
  act(action: (flow: Flow) => Promise<FlowStep>): Promise<FlowStep | null>
}

/**
 * The machinery behind `useSignIn`, `useSignUp` and `useResetPassword`: holds the flow object
 * (which keeps the attempt's secret to itself, in memory), mirrors its step into React state,
 * and turns every failure into `error` instead of a rejected promise.
 *
 * It contains no flow logic. Which action is valid at which step is the server's decision; an
 * action that is not valid comes back as `flow.invalid_step`.
 *
 * @returns The controller.
 */
export function useFlowController<Flow extends CoreFlow>(): FlowController<Flow> {
  const { client, localization } = useTulaContext()
  const messages = localization.errors
  const flow = useRef<Flow | null>(null)
  const busy = useRef(false)
  const mounted = useRef(true)
  // Bumped by `reset`: an answer that arrives for an attempt the user has left is dropped.
  const generation = useRef(0)
  const [step, setStep] = useState<FlowStep | null>(null)
  const [isPending, setPending] = useState(false)
  const [error, setError] = useState<TulaError | null>(null)

  useEffect(() => {
    mounted.current = true
    return () => {
      // Only the flag: the flow object stays in its ref. An effect's cleanup is not proof of
      // an unmount (React's `<Activity mode="hidden">` tears effects down, keeps state and
      // runs them again), and dropping the flow here left the screen on a step whose next
      // action could only answer `flow.invalid_step`. The step in state and the flow object
      // now live and die together: both are released with the component, and with them the
      // attempt's secret, which only the flow object's closure holds.
      mounted.current = false
    }
  }, [])

  const run = useCallback(async (work: () => Promise<FlowStep>): Promise<FlowStep | null> => {
    if (busy.current) {
      // A double click or a second Enter: one request at a time, and the first one's answer
      // is the one that counts.
      return null
    }
    const started = generation.current
    busy.current = true
    setPending(true)
    setError(null)
    try {
      const next = await work()
      if (mounted.current && generation.current === started) {
        setStep(next)
      }
      return next
    } catch (caught) {
      if (mounted.current && generation.current === started) {
        setError(toTulaError(caught))
      }
      return null
    } finally {
      busy.current = false
      if (mounted.current) {
        setPending(false)
      }
    }
  }, [])

  const start = useCallback(
    (begin: () => Promise<Flow>) =>
      run(async () => {
        const started = generation.current
        const created = await begin()
        if (generation.current === started) {
          flow.current = created
        }
        return created.step
      }),
    [run]
  )

  const act = useCallback(
    (action: (current: Flow) => Promise<FlowStep>) =>
      run(() => {
        const current = flow.current
        if (!current) {
          // Nothing to act on: the same answer the server gives for an out-of-order action.
          const code = 'flow.invalid_step'
          throw new TulaError({ code, message: formatMessage(code, { messages }) })
        }
        return action(current)
      }),
    [run, messages]
  )

  const reset = useCallback(() => {
    generation.current += 1
    flow.current = null
    setStep(null)
    setError(null)
  }, [])

  const clearError = useCallback(() => setError(null), [])

  // `client` is read so that a provider whose client changes starts from a clean slate.
  const lastClient = useRef(client)
  useEffect(() => {
    if (lastClient.current !== client) {
      lastClient.current = client
      reset()
    }
  }, [client, reset])

  return { step, isPending, error, start, act, reset, clearError }
}
