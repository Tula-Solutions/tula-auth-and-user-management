import type { EnvironmentSettings, FirstFactorStrategy, SecondFactorMethod } from '@tula/contract'
import type { Deps, Tenant } from '~/dependencies'

/** One way to prove who you are first, and the setting that switches it on. */
interface FirstFactor {
  strategy: FirstFactorStrategy
  /** Whether the environment offers it. Reads settings only: never anything about a user. */
  enabled: (settings: EnvironmentSettings) => boolean
}

/**
 * Every first factor the server can offer, in the order a sign-in lists them.
 *
 * **The one place a sign-in method is registered.** Adding a method (email code, magic link,
 * OAuth, passkeys: steps 1.7 to 1.10) means adding an entry here and the route that proves it;
 * the transition function does not change.
 */
const FIRST_FACTORS: readonly FirstFactor[] = [
  { strategy: 'password', enabled: (settings) => settings.signIn.methods.password.enabled },
]

/**
 * The first factors an environment offers at sign-in.
 *
 * Decided by the environment's settings **alone**. It must never take an identifier or a user:
 * the list is sent in the answer to a sign-in start, before anything is proven, so a list that
 * depended on the account would tell a stranger whether an address has a password or a passkey.
 *
 * @param settings - The environment's settings.
 * @returns The enabled strategies, in registry order. Empty when every method is switched off.
 *
 * @example
 * ```ts
 * Factors.firstFactors(await Settings.current(deps, tenant)) // ['password']
 * ```
 */
export function firstFactors(settings: EnvironmentSettings): FirstFactorStrategy[] {
  return FIRST_FACTORS.filter((factor) => factor.enabled(settings)).map((factor) => factor.strategy)
}

/**
 * The second factors a user must prove one of before a session is started for them.
 *
 * The flow engine asks this after every accepted first factor and after a password reset's code
 * and new password are accepted. A non-empty answer moves the attempt to `needs_second_factor`
 * instead of `complete`: no session and no tokens until one of them is proven.
 *
 * No second factor exists yet, so the answer is always empty. Step 1.8 (TOTP and backup codes)
 * fills this in from the user's enrolled factors and the environment's MFA policy.
 *
 * @param _deps - Stores to read the user's enrolled factors from (unused until 1.8).
 * @param _tenant - The environment (unused until 1.8).
 * @param _userId - The user whose first factor was just accepted (unused until 1.8).
 * @returns The methods the user may choose from; empty when no second factor is required.
 */
export async function requiredFor(
  _deps: Pick<Deps, 'users'>,
  _tenant: Pick<Tenant, 'environmentId'>,
  _userId: string
): Promise<SecondFactorMethod[]> {
  return []
}

/** What a client submits to prove a second factor. */
export interface SecondFactorProof {
  method: SecondFactorMethod
  /** What the method needs: a code for TOTP, a backup code, a WebAuthn assertion for a passkey. */
  response: unknown
}

/**
 * Checks one kind of second factor for a user.
 *
 * @param deps - All dependencies.
 * @param tenant - The environment.
 * @param userId - The user the attempt belongs to.
 * @param response - What the client submitted.
 * @returns `true` only when the response proves the factor. Never throws for a wrong response.
 */
export type SecondFactorVerifier = (
  deps: Deps,
  tenant: Tenant,
  userId: string,
  response: unknown
) => Promise<boolean>

/**
 * The verifier of each second-factor method. Empty today: step 1.8 registers `totp` and
 * `backup_code` here, 1.10 `passkey`. A method with no verifier can never be proven.
 */
export const SECOND_FACTOR_VERIFIERS: Partial<Record<SecondFactorMethod, SecondFactorVerifier>> = {}

/**
 * Check a second-factor proof with the verifier registered for its method.
 *
 * Counting failures, the lockout and the attempt's state are the flow engine's job
 * (`Flows.submitSecondFactor`); a verifier only answers whether the response is right.
 *
 * @param deps - All dependencies.
 * @param tenant - The environment.
 * @param userId - The user the attempt belongs to.
 * @param proof - The method and what the client submitted for it.
 * @returns Whether the proof is good. `false` for a method with no verifier.
 */
export async function verify(
  deps: Deps,
  tenant: Tenant,
  userId: string,
  proof: SecondFactorProof
): Promise<boolean> {
  const verifier = SECOND_FACTOR_VERIFIERS[proof.method]
  return verifier ? verifier(deps, tenant, userId, proof.response) : false
}
