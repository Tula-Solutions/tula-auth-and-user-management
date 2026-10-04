import {
  type FactorEnrolmentResult,
  type FlowStep,
  formatMessage,
  type TotpEnrolment,
  TulaError,
} from '@tula/core'
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
  /** Stops what the flow has running and forgets what it kept in the browser, if anything. */
  discard?(): void
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
  /**
   * Follow something the flow does in the background (waiting for an emailed link to be
   * opened) and take its result as the new step. Unlike {@link FlowController.act} it does not
   * mark the flow pending and does not stop other actions from being sent meanwhile.
   *
   * @param action - Calls the flow object.
   * @returns The step it resolved with, or `null` when it failed or no flow has been started.
   */
  watch(action: (flow: Flow) => Promise<FlowStep>): Promise<FlowStep | null>
  /**
   * Take over a flow that was started elsewhere (an OAuth round trip's, which the landing page
   * receives already positioned on its step; a passkey sign-in's, which is an attempt of its
   * own): the controller's actions continue it, and a flow it held before is discarded.
   */
  adopt(flow: Flow): void
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

  const watch = useCallback(
    async (action: (current: Flow) => Promise<FlowStep>): Promise<FlowStep | null> => {
      const current = flow.current
      if (!current) {
        return null
      }
      const started = generation.current
      try {
        const next = await action(current)
        if (mounted.current && generation.current === started) {
          setStep(next)
        }
        return next
      } catch (caught) {
        if (mounted.current && generation.current === started) {
          setError(toTulaError(caught))
        }
        return null
      }
    },
    []
  )

  const reset = useCallback(() => {
    generation.current += 1
    // The attempt is being left: stop anything it has running and drop what it kept.
    flow.current?.discard?.()
    flow.current = null
    setStep(null)
    setError(null)
  }, [])

  const clearError = useCallback(() => setError(null), [])

  const adopt = useCallback((created: Flow) => {
    if (flow.current !== null && flow.current !== created) {
      // Another attempt takes over (a passkey chosen in place of the method on screen): what
      // the one being left has running stops, and a late answer of its own is dropped.
      generation.current += 1
      flow.current.discard?.()
    }
    flow.current = created
    setStep(created.step)
    setError(null)
  }, [])

  // `client` is read so that a provider whose client changes starts from a clean slate.
  const lastClient = useRef(client)
  useEffect(() => {
    if (lastClient.current !== client) {
      lastClient.current = client
      reset()
    }
  }, [client, reset])

  return { step, isPending, error, start, act, watch, adopt, reset, clearError }
}

/** A flow that can stop at `needs_factor_enrolment`. */
interface EnrollingFlow extends CoreFlow {
  startTotpEnrolment(): Promise<TotpEnrolment>
  confirmTotpEnrolment(input: { code: string }): Promise<FactorEnrolmentResult>
}

/**
 * The two actions of the `needs_factor_enrolment` step, as every flow hook offers them.
 *
 * @example
 * ```ts
 * const { startTotpEnrolment, confirmTotpEnrolment }: FactorEnrolmentHookActions = useSignIn()
 * ```
 */
export interface FactorEnrolmentHookActions {
  /**
   * Start enrolling an authenticator app (step `needs_factor_enrolment`).
   *
   * @returns The secret and its `otpauth://` URI, or `null` when it failed (see `error`).
   *   Show them once and keep them nowhere: the hook does not.
   */
  startTotpEnrolment(): Promise<TotpEnrolment | null>
  /**
   * Confirm the authenticator with the code it shows. Completes the flow.
   *
   * @param input - The 6-digit code.
   * @returns The `complete` step and the backup codes (shown once), or `null` when it failed.
   */
  confirmTotpEnrolment(input: { code: string }): Promise<FactorEnrolmentResult | null>
}

/**
 * Build the enrolment actions of a flow hook from its controller's `act`. What an action
 * returns besides the step (a secret, backup codes) is handed to the caller and kept nowhere.
 *
 * @param act - The controller's `act`.
 * @returns The two actions.
 */
export function enrolmentActions<Flow extends EnrollingFlow>(
  act: FlowController<Flow>['act']
): FactorEnrolmentHookActions {
  return {
    async startTotpEnrolment() {
      let enrolment: TotpEnrolment | null = null
      await act(async (flow) => {
        enrolment = await flow.startTotpEnrolment()
        return flow.step
      })
      return enrolment
    },
    async confirmTotpEnrolment(input) {
      let result: FactorEnrolmentResult | null = null
      await act(async (flow) => {
        result = await flow.confirmTotpEnrolment(input)
        return result.step
      })
      return result
    },
  }
}
