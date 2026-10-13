// The address of a throwaway user a sign-in test makes, the words of a test's report and
// the rule for whether an environment allows one (ADR 0058). Plain data and string work: no
// Zod here, so a webhook receiver or a hook can tell a test's user without a schema library.
// The report's schema is in `./sign-in-test`.

/**
 * The domain of every address a sign-in test makes. `.invalid` is reserved (RFC 2606, RFC
 * 6761): no name under it can be registered and no mail can be delivered to one, so no
 * person has, or can come to have, such an address.
 *
 * @example
 * ```ts
 * `tula-test-${hex}@${TEST_ADDRESS_DOMAIN}`
 * ```
 */
export const TEST_ADDRESS_DOMAIN = 'test.tula.invalid'

/**
 * What the local part of a test's address starts with; 32 hexadecimal characters follow.
 *
 * @example
 * ```ts
 * TEST_ADDRESS_LOCAL_PREFIX // 'tula-test-'
 * ```
 */
export const TEST_ADDRESS_LOCAL_PREFIX = 'tula-test-'

/**
 * Whether an address is one only a sign-in test may hold: any address whose domain is
 * {@link TEST_ADDRESS_DOMAIN} or a name under it, whatever its local part and its case.
 *
 * It is deliberately wider than the addresses a test makes: the whole domain is kept away
 * from people, so that no spelling of one is left for somebody to sign up with. The server
 * refuses such an address wherever an address is taken for an account, and sends no mail to
 * one. A receiver of `before_sign_up` can ask this of the question's `email`.
 *
 * @param address - An email address, as typed or as stored.
 * @returns `true` for an address in the reserved test domain.
 *
 * @example
 * ```ts
 * isTestAddress('tula-test-0123456789abcdef0123456789abcdef@test.tula.invalid') // true
 * isTestAddress('Someone@Sub.Test.Tula.Invalid') // true
 * isTestAddress('maya@northline.app') // false
 * ```
 */
export function isTestAddress(address: string): boolean {
  const at = address.lastIndexOf('@')
  if (at < 0) {
    return false
  }
  // A trailing dot names the same domain; spaces around an address are trimmed by whoever
  // parses it, so they are trimmed here too.
  const domain = address
    .slice(at + 1)
    .trim()
    .toLowerCase()
    .replace(/\.$/, '')
  return domain === TEST_ADDRESS_DOMAIN || domain.endsWith(`.${TEST_ADDRESS_DOMAIN}`)
}

/**
 * Build the address of a test's throwaway user.
 *
 * @param hex - 32 hexadecimal characters from a CSPRNG.
 * @returns The address, lower case.
 * @throws Error when `hex` is not 32 hexadecimal characters.
 *
 * @example
 * ```ts
 * testAddress('0123456789abcdef0123456789abcdef')
 * // 'tula-test-0123456789abcdef0123456789abcdef@test.tula.invalid'
 * ```
 */
export function testAddress(hex: string): string {
  if (!/^[0-9a-f]{32}$/.test(hex)) {
    throw new Error('a test address is made from 32 hexadecimal characters')
  }
  return `${TEST_ADDRESS_LOCAL_PREFIX}${hex}@${TEST_ADDRESS_DOMAIN}`
}

/**
 * The steps of a sign-in test, in the order they run and are reported.
 *
 * @example
 * ```ts
 * const step: SignInTestStep = 'verify_email'
 * ```
 */
export const SIGN_IN_TEST_STEPS = [
  'sign_up',
  'verify_email',
  'sign_out',
  'sign_in',
  'first_factor',
  'revoke_session',
  'delete_user',
] as const

/** One step of a sign-in test: one of {@link SIGN_IN_TEST_STEPS}. */
export type SignInTestStep = (typeof SIGN_IN_TEST_STEPS)[number]

/**
 * What became of a step: it was carried out and worked, it was carried out and did not, or it
 * was not carried out. A step that was not carried out is never `passed`.
 *
 * @example
 * ```ts
 * const outcome: SignInTestStepOutcome = 'not_run'
 * ```
 */
export const SIGN_IN_TEST_STEP_OUTCOMES = ['passed', 'failed', 'not_run'] as const

/** The outcome of one step. */
export type SignInTestStepOutcome = (typeof SIGN_IN_TEST_STEP_OUTCOMES)[number]

/**
 * Why a step was not run, or why it failed where no error code says it.
 *
 * - `earlier_step`: a step it depends on did not pass.
 * - `second_factor_required`: the attempt stopped at a second factor or at its enrolment; the
 *   test proves no second factor and enrols none.
 * - `email_cooldown`: the sign-in's only first factor the server could prove by itself is an
 *   emailed code, and a second code for one address within a minute of the first (the
 *   sign-up's) is refused for everyone. The test does not wait and does not go round it.
 * - `no_provable_method`: the sign-in offers no first factor the server can prove by itself
 *   (only a passkey, an emailed link, a texted code or a provider).
 * - `no_session`: there is no session to end.
 * - `timeout`: the step, or the whole test, ran out of time.
 * - `cancelled`: the caller went away.
 *
 * @example
 * ```ts
 * const reason: SignInTestReason = 'second_factor_required'
 * ```
 */
export const SIGN_IN_TEST_REASONS = [
  'earlier_step',
  'second_factor_required',
  'email_cooldown',
  'no_provable_method',
  'no_session',
  'timeout',
  'cancelled',
] as const

/** A fixed reason of a step: one of {@link SIGN_IN_TEST_REASONS}. */
export type SignInTestReason = (typeof SIGN_IN_TEST_REASONS)[number]

/**
 * What a whole test came to: `passed` when every step did; `failed` when a step failed;
 * `incomplete` when none failed and at least one was not run.
 *
 * @example
 * ```ts
 * const outcome: SignInTestOutcome = 'incomplete'
 * ```
 */
export const SIGN_IN_TEST_OUTCOMES = ['passed', 'failed', 'incomplete'] as const

/** The outcome of a whole test. */
export type SignInTestOutcome = (typeof SIGN_IN_TEST_OUTCOMES)[number]

/**
 * What became of the throwaway user: `deleted`; `failed` (it exists and could not be deleted:
 * the server's retention job removes it within minutes); `none` (no account was made).
 *
 * @example
 * ```ts
 * const cleanup: SignInTestCleanup = 'deleted'
 * ```
 */
export const SIGN_IN_TEST_CLEANUPS = ['deleted', 'failed', 'none'] as const

/** What became of a test's user. */
export type SignInTestCleanup = (typeof SIGN_IN_TEST_CLEANUPS)[number]

/**
 * Why a sign-in test was refused before it began, as `params.reason` of the `auth.forbidden`
 * answer says it: the environment does not allow one (`agents.testSignIn`).
 *
 * @example
 * ```ts
 * if (error.params?.reason === SIGN_IN_TEST_REFUSALS[0]) {
 *   // Switch agents.testSignIn on for this environment.
 * }
 * ```
 */
export const SIGN_IN_TEST_REFUSALS = ['test_sign_in_disabled'] as const

/** Why a sign-in test was refused. */
export type SignInTestRefusal = (typeof SIGN_IN_TEST_REFUSALS)[number]

/**
 * Whether an environment allows a sign-in test: what its `agents.testSignIn` says, and where
 * that is `null` (the default) what its kind of environment does: **yes in a development
 * environment, no in a production one**. The one place the default is decided.
 *
 * The kind is the environment's own, as the control plane stores it; never the deployment's
 * tier.
 *
 * @param setting - `agents.testSignIn`: `true`, `false` or `null`.
 * @param kind - The environment's kind.
 * @returns Whether a test may run.
 *
 * @example
 * ```ts
 * testSignInAllowed(null, 'development') // true
 * testSignInAllowed(null, 'production') // false
 * testSignInAllowed(true, 'production') // true
 * ```
 */
export function testSignInAllowed(
  setting: boolean | null,
  kind: 'development' | 'production'
): boolean {
  return setting ?? kind !== 'production'
}
