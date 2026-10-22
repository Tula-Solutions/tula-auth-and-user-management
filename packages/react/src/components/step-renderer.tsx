import type { FlowStep } from '@tula-tech/core'
import type { ReactElement } from 'react'
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
 * is given its step narrowed to that status. A screen returns an element, or `null` to say it
 * cannot draw the step it was given (an option this version does not know): the "not
 * supported" screen is drawn instead. A screen is a component's render, so it may call hooks.
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
  [S in StepStatus]?: (step: StepOf<S>) => ReactElement | null
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
  start?: ReactElement | null
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
 * start again. There is no prop to change or remove that fallback: every status maps to an
 * element or to the fallback, and no action is ever guessed. (A screen that is an element
 * which itself renders nothing is its author's responsibility.) Each screen is its own
 * component, remounted when the screen's name or status changes, so one step's half-typed
 * state never carries over to the next, and a screen may call hooks.
 *
 * Draw it where the other `@tula-tech/react` screens are drawn, inside a `<TulaProvider>`.
 *
 * @param props - The step, the screens and how to start again.
 * @returns The step's screen, or the "not supported" screen.
 * @throws Error when the fallback is drawn outside a `<TulaProvider>`.
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
  // The status is part of the key: a screen is a different component for each status, and
  // React must not carry one screen's hooks into another's.
  const key = `${props.screen ?? ''}:${step?.status ?? 'start'}`
  const screen = step === null ? undefined : ownScreen(screens, step.status)
  return (
    <ScreenHost
      key={key}
      render={step === null ? () => start : screen && (() => screen(step as never))}
      focusTitle={props.focusTitle ?? false}
      onRestart={onRestart}
    />
  )
}

/** The screen a status has; a status the map does not hold (own keys only) has none. */
function ownScreen(
  screens: StepScreens,
  status: StepStatus
): ((step: never) => ReactElement | null) | undefined {
  return Object.hasOwn(screens, status) ? screens[status] : undefined
}

/**
 * Runs a screen as the render of a component of its own, so that a hook in a screen belongs to
 * this host and not to {@link StepRenderer}; a result that is not an element (an untyped
 * caller may return `false` or `undefined`) draws the "not supported" screen.
 */
function ScreenHost(props: {
  render: (() => ReactElement | null | undefined | false) | undefined
  focusTitle: boolean
  onRestart(): void
}) {
  const inRoot = useIsInRoot()
  const drawn = props.render?.()
  if (drawn === null || drawn === undefined || drawn === false) {
    const unsupported = (
      <UnsupportedScreen focusTitle={props.focusTitle} onRestart={props.onRestart} />
    )
    // The fallback needs the package's strings and element names; a copied component may be
    // drawn outside a prebuilt component's root.
    return inRoot ? unsupported : <Root appearance={undefined}>{unsupported}</Root>
  }
  return drawn
}
