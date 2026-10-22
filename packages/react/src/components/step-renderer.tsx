import type { FlowStep } from '@tula-tech/core'
import { Fragment, type ReactNode } from 'react'
import { UnsupportedScreen } from './flow-screens'
import { Root, useIsInRoot } from './ui'

/**
 * Every status a flow step can have, as the contract defines them (`needs_password`,
 * `needs_first_factor`, `complete`, ...).
 *
 * @example
 * ```ts
 * const status: StepStatus = 'needs_password'
 * ```
 */
export type StepStatus = FlowStep['status']

/**
 * A step with the given status, narrowed to the fields that status has.
 *
 * @example
 * ```ts
 * type Verification = StepOf<'needs_email_verification'> // has `destination`
 * ```
 */
export type StepOf<S extends StepStatus> = Extract<FlowStep, { status: S }>

/**
 * A screen per step status. A key that is not a step status is a type error, and each screen
 * is given its step narrowed to that status. A screen may return `null` to say it cannot draw
 * the step it was given (an option this version does not know): the "not supported" screen is
 * drawn instead.
 *
 * @example
 * ```tsx
 * const screens: StepScreens = {
 *   needs_password: () => <PasswordForm />,
 *   needs_email_verification: (step) => <CodeForm destination={step.destination} />,
 * }
 * ```
 */
export type StepScreens = {
  [S in StepStatus]?: (step: StepOf<S>) => ReactNode
}

/**
 * Props of {@link StepRenderer}.
 *
 * @example
 * ```tsx
 * const props: StepRendererProps = { step: null, screens: {}, start: <p>Start</p>, onRestart }
 * ```
 */
export interface StepRendererProps {
  /** What the server is waiting for (a flow hook's `step`), or `null` before the flow starts. */
  step: FlowStep | null
  /** A screen per status. See {@link StepScreens}. */
  screens: StepScreens
  /**
   * The screen before the flow has a step. Without one, `null` draws the "not supported"
   * screen like any other step with no screen.
   */
  start?: ReactNode
  /**
   * A name for the current screen, for a flow that has more than one view with the same
   * statuses (a sign-in and a reset). A new name draws the screen afresh. Defaults to the
   * status.
   */
  screen?: string
  /** Whether the "not supported" screen's title takes the focus (see `useScreenChanged`). */
  focusTitle?: boolean
  /** Start again: what the "not supported" screen's button does. */
  onRestart(): void
}

/**
 * Draw the screen of a flow step: the one place a step becomes a screen.
 *
 * Anything with no screen in the map (a status a newer server added, a status the map leaves
 * out, a screen that returns `null`) draws the package's "not supported" screen with a way to
 * start again. There is no prop to change or remove that fallback: a step is never drawn as a
 * blank card, and no action is ever guessed. Each screen is remounted when the screen's name
 * changes, so one step's half-typed state never carries over to the next.
 *
 * Draw it where the other `@tula-tech/react` screens are drawn, inside a `<TulaProvider>`.
 *
 * @param props - The step, the screens and how to start again.
 * @returns The step's screen, or the "not supported" screen.
 * @throws Error outside a `<TulaProvider>`.
 *
 * @example
 * ```tsx
 * const flow = useSignUp()
 * return (
 *   <StepRenderer
 *     step={flow.step}
 *     start={<AccountForm flow={flow} />}
 *     screens={{
 *       needs_email_verification: (step) => <CodeForm destination={step.destination} />,
 *     }}
 *     onRestart={flow.reset}
 *   />
 * )
 * ```
 */
export function StepRenderer(props: StepRendererProps) {
  const { step, screens, start, onRestart } = props
  const key = props.screen ?? step?.status ?? 'start'
  const inRoot = useIsInRoot()
  const drawn = step === null ? start : draw(screens, step)
  if (drawn === null || drawn === undefined || drawn === false) {
    const unsupported = (
      <UnsupportedScreen key={key} focusTitle={props.focusTitle ?? false} onRestart={onRestart} />
    )
    // The fallback needs the package's strings and element names; a copied component may be
    // drawn outside a prebuilt component's root.
    return inRoot ? unsupported : <Root appearance={undefined}>{unsupported}</Root>
  }
  return <Fragment key={key}>{drawn}</Fragment>
}

/** Call the screen a status has; a status the map does not hold (own keys only) has none. */
function draw(screens: StepScreens, step: FlowStep): ReactNode {
  if (!Object.hasOwn(screens, step.status)) {
    return null
  }
  const screen = screens[step.status] as ((step: FlowStep) => ReactNode) | undefined
  return screen ? screen(step) : null
}
