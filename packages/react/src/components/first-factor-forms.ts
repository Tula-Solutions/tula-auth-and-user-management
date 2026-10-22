import type { FirstFactorStrategy, FlowStep } from '@tula-tech/core'
import type { ComponentType, ReactNode } from 'react'
import type { UseSignInResult } from '../hooks/use-sign-in'

/** The step a first-factor form answers. */
type FirstFactorStep = Extract<FlowStep, { status: 'needs_first_factor' }>

/**
 * What a first-factor form is given: the sign-in flow, the address typed on the first screen
 * and the ways to leave the form. A form draws one strategy (the password, an emailed code, ...)
 * and calls the flow; it decides nothing about which strategy is shown.
 *
 * @example
 * ```tsx
 * function MyPasswordForm(props: FirstFactorFormProps) {
 *   return <button onClick={props.onForgotPassword}>Forgot password?</button>
 * }
 * ```
 */
export interface FirstFactorFormProps {
  /** The address (or phone number) the sign-in was started with. */
  email: string
  /** The sign-in flow to submit to. */
  signIn: UseSignInResult
  /** Whether the title takes the focus (true once the user has moved on from the first screen). */
  focusTitle: boolean
  /** Leave for the password reset. */
  onForgotPassword(): void
  /** Go back to the first screen to change the address. */
  onChangeEmail(): void
  /** What the server last emailed for this attempt, when it has. */
  prepared?: FirstFactorStep['prepared']
  /** Ask the server for the email of an email strategy (again, for a fresh one). */
  sendEmail?(strategy: 'email_code' | 'email_link'): Promise<FlowStep | null>
  /** Ask the server to text the code of `sms_code` (again, for a fresh one). */
  sendText?(): Promise<FlowStep | null>
  /** The other ways to sign in the attempt offers, drawn under the form. */
  alternatives?: ReactNode
}

/**
 * The first factors a set of screens can draw, as data: which strategy is drawn by which form.
 * A copied component supplies its own table; a strategy with no entry is skipped (the OAuth
 * providers are buttons on the first screen, not forms).
 *
 * @example
 * ```tsx
 * const forms: FirstFactorForms = { password: MyPasswordForm, email_code: MyCodeForm }
 * ```
 */
export type FirstFactorForms = Partial<
  Record<FirstFactorStrategy, ComponentType<FirstFactorFormProps>>
>

/** What the browser and the identifier rule out; see {@link firstFactorStrategies}. */
export interface FirstFactorCapabilities {
  /** Whether an emailed link can be honoured here (storage is usable and a link URL is set). */
  link: boolean
  /**
   * What the browser said about WebAuthn: `usePasskeySupport()` as it is, `undefined` while it
   * has not been asked yet. Hidden until known: how `undefined` counts depends on the list
   * (see {@link firstFactorStrategies}).
   */
  passkey: boolean | undefined
  /** Whether what was typed is a phone number rather than an address. */
  phone: boolean
}

/**
 * Choose the strategies of an attempt that a table of forms can draw, in the server's order.
 *
 * A strategy the table has no form for, or one the browser or the identifier rules out, is
 * skipped, never guessed at (a newer server may offer more). For a phone number a texted code is
 * the only form: a password or an emailed code for a number signs nobody in.
 *
 * A passkey is where "hidden until known" is decided, for both lists, so that a copy cannot
 * drift from the prebuilt screens. For the **active** list (the form the screen itself opens
 * on) a passkey whose support is not known yet (`undefined`) is not ruled out: a screen whose
 * only way is a passkey must not open on "not supported" and then change its mind. For the
 * **alternatives** list (the other ways, drawn as links under the form) it is hidden until the
 * browser has said `true`: a link that is then taken away is a broken control for as long as
 * it shows. `false` rules a passkey out of both.
 *
 * @param offered - The strategies the server offers (`step.strategies`).
 * @param forms - The table of forms.
 * @param can - What the browser and the identifier allow.
 * @param list - Which list is wanted: `'active'` (default) or `'alternatives'`.
 * @returns The strategies to draw; empty when there is none (draw the "not supported" screen).
 *
 * @example
 * ```ts
 * const known = firstFactorStrategies(step.strategies, forms, {
 *   link: false,
 *   passkey: true,
 *   phone: false,
 * })
 * // the links under the form, once the browser has been asked:
 * const others = firstFactorStrategies(step.strategies, forms, can, 'alternatives')
 * ```
 */
export function firstFactorStrategies(
  offered: readonly string[],
  forms: FirstFactorForms,
  can: FirstFactorCapabilities,
  list: 'active' | 'alternatives' = 'active'
): FirstFactorStrategy[] {
  const known = offered.filter(
    (strategy): strategy is FirstFactorStrategy =>
      Object.hasOwn(forms, strategy) &&
      // `Partial` allows an explicit `undefined`: an entry with no form is no entry.
      (forms as Record<string, unknown>)[strategy] !== undefined &&
      (strategy !== 'email_link' || can.link) &&
      // Hidden, not broken, in a browser without WebAuthn; and among the alternatives only
      // once the browser is known to have it.
      (strategy !== 'passkey' ||
        (list === 'alternatives' ? can.passkey === true : can.passkey !== false)) &&
      // A code is texted to a number: for an address the form could only ever fail.
      (strategy !== 'sms_code' || can.phone)
  )
  // And the other way round: a password or an emailed code for a phone number signs nobody
  // in, so where a texted code is offered for a number it is the form that is drawn.
  return can.phone && known.includes('sms_code') ? ['sms_code'] : known
}
