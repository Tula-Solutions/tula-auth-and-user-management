import {
  type FactorEnrolmentResult,
  type FlowStep,
  formatMessage,
  type TotpEnrolment,
  TulaError,
} from '@tula/core'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTula } from '../context'
import { toTulaError } from '../errors'
import { type FlowScreen, flowScreen } from '../screens'

/**
 * The state every flow hook shares.
 *
 * @example
 * ```ts
 * const { screen, isPending, error }: FlowState = useSignIn()
 * ```
 */
export interface FlowState {
  /**
   * What the server is waiting for, as it sent it; `null` before `start` (and after `reset`).
   * Read the step's own fields (`destination`, `strategies`, `options`) from here.
   */
  step: FlowStep | null
  /**
   * Which screen to draw: `null` before `start`, the step's `status` where the hook has the
   * actions for it, and `not_supported` for a step, or a step whose every offered way, this
   * version does not know. Switch on this and make `not_supported` (and the `default` branch)
   * a screen that says so and offers to start again.
   */
  screen: FlowScreen | null
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
  /** Ends the attempt: its secret is forgotten and a late answer is dropped. */
  discard(): void
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
  const client = useTula()
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
      // an unmount (`<Activity mode="hidden">` tears effects down, keeps state and runs them
      // again), and dropping the flow here would leave the screen on a step whose next action
      // could only answer `flow.invalid_step`.
      mounted.current = false
    }
  }, [])

  const run = useCallback(async (work: () => Promise<FlowStep>): Promise<FlowStep | null> => {
    if (busy.current) {
      // A double tap: one request at a time, and the first one's answer is the one that counts.
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
          // The attempt this one replaces is left: its secret is forgotten.
          flow.current?.discard()
          flow.current = created
        } else {
          // Started for a screen the user has left meanwhile: nobody will act on it.
          created.discard()
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
          throw new TulaError({ code, message: formatMessage(code) })
        }
        return action(current)
      }),
    [run]
  )

  const reset = useCallback(() => {
    generation.current += 1
    // The attempt is being left: drop what it kept and any answer still on its way.
    flow.current?.discard()
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

  return {
    step,
    screen: step ? flowScreen(step) : null,
    isPending,
    error,
    start,
    act,
    reset,
    clearError,
  }
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
