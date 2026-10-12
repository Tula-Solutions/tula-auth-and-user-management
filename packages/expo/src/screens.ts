import type { FlowStep } from '@tula/core'

/**
 * Which screen a flow's step asks an app to draw: the step's `status` where this version of
 * the package has the actions for it, and `not_supported` for anything else.
 *
 * `not_supported` is a screen like the others, not an error: a newer server may send a step,
 * or offer only ways of proving it (an emailed link; a passkey or a provider in an app whose
 * client was given no passkey sheet or no browser), that this client cannot act on. Say so in
 * words and offer to start again; never guess an action.
 *
 * @example
 * ```ts
 * const screen: FlowScreen = flowScreen(flow.step)
 * ```
 */
export type FlowScreen =
  | 'needs_password'
  | 'needs_first_factor'
  | 'needs_email_verification'
  | 'needs_new_password'
  | 'needs_second_factor'
  | 'needs_factor_enrolment'
  | 'complete'
  | 'not_supported'

/**
 * What a client can do beyond codes and passwords, which decides whether a step that offers
 * only such ways has a screen.
 *
 * @example
 * ```ts
 * const ways: FlowWays = { passkey: true, providers: false }
 * ```
 */
export interface FlowWays {
  /** A passkey can be asked for: the client has a sheet and the device has passkeys. */
  passkey?: boolean
  /** A provider sign-in can be started: the client has a browser session. */
  providers?: boolean
}

/** The providers `useSignIn().withProvider` can be asked for. */
const PROVIDERS: readonly string[] = [
  'google',
  'github',
  'apple',
  'microsoft',
  'discord',
  'linkedin',
  'x',
  'facebook',
]

/** The ways of a first factor the hooks have an action for. */
const FIRST_FACTORS: readonly string[] = ['password', 'email_code', 'sms_code']
/** The second factors the hooks have an action for. */
const SECOND_FACTORS: readonly string[] = ['totp', 'backup_code', 'sms_code']
/** The factors the hooks can enrol inside a flow. */
const ENROLMENTS: readonly string[] = ['totp']
/** The reasons a sign-in asks for a new password that the hooks can answer. */
const NEW_PASSWORD_REASONS: readonly string[] = ['expired']

/** Whether `value` is a list that offers at least one of `known`. */
function offers(value: unknown, known: readonly string[]): boolean {
  return Array.isArray(value) && value.some((entry) => known.includes(entry as string))
}

/**
 * Decide which screen a step asks for.
 *
 * It reads the step as data from a server that may be newer than this package: a status it
 * does not know, and a known status that offers nothing the hooks can do, are both
 * `not_supported`. It never throws and never changes the step.
 *
 * @param step - The flow's current step, as the server sent it.
 * @param ways - What the client can do beside codes and passwords. Left out: neither a
 *   passkey nor a provider, as a client created with no sheet and no browser.
 * @returns The step's status, or `not_supported`.
 *
 * @example
 * ```tsx
 * switch (flowScreen(signIn.step)) {
 *   case 'needs_password':
 *     return <PasswordForm />
 *   case 'not_supported':
 *     return <Text>This way of signing in is not supported by this version of the app.</Text>
 * }
 * ```
 */
export function flowScreen(step: FlowStep, ways: FlowWays = {}): FlowScreen {
  const passkey = ways.passkey === true ? ['passkey'] : []
  const providers = ways.providers === true ? PROVIDERS : []
  // The type says what today's contract holds; the value is whatever was sent.
  const sent = step as { status?: unknown } & Record<string, unknown>
  switch (sent.status) {
    case 'needs_password':
    case 'needs_email_verification':
    case 'complete':
      return sent.status
    case 'needs_first_factor':
      return offers(sent.strategies, [...FIRST_FACTORS, ...passkey, ...providers])
        ? 'needs_first_factor'
        : 'not_supported'
    case 'needs_second_factor':
      return offers(sent.options, [...SECOND_FACTORS, ...passkey])
        ? 'needs_second_factor'
        : 'not_supported'
    case 'needs_factor_enrolment':
      return offers(sent.methods, ENROLMENTS) ? 'needs_factor_enrolment' : 'not_supported'
    case 'needs_new_password':
      // A password reset's step has no reason; a sign-in's has one, and only a known one
      // says which action answers it.
      return sent.reason === undefined || NEW_PASSWORD_REASONS.includes(sent.reason as string)
        ? 'needs_new_password'
        : 'not_supported'
    default:
      return 'not_supported'
  }
}
