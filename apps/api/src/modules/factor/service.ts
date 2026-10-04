import type {
  EmailVerificationStrategy,
  EnvironmentSettings,
  FactorEnrolmentMethod,
  FirstFactorStrategy,
  OAuthProvider,
  SecondFactorMethod,
  SignInMethod,
} from '@tula/contract'
import type { Deps, Tenant } from '~/dependencies'
import type { Actor } from '~/lib/actor'
import * as Mfa from '~/modules/mfa/service'
import * as Settings from '~/modules/settings/service'

/** One way to prove who you are first, and the setting that switches it on. */
interface FirstFactor {
  strategy: FirstFactorStrategy
  /**
   * Whether the environment offers it. Reads the environment's settings and its enabled OAuth
   * providers only: never anything about a user.
   */
  enabled: (settings: EnvironmentSettings, providers: readonly OAuthProvider[]) => boolean
}

/**
 * Every first factor the server can offer, in the order a sign-in lists them.
 *
 * **The one place a sign-in method is registered.** Adding a method (OAuth, passkeys: steps 1.9
 * and 1.10) means adding an entry here and the route that proves it; the transition function
 * does not change. The email strategies (ADR 0024) are proven through
 * `sign-ins/:attemptId/first-factor/*`; an OAuth provider (ADR 0026) through an attempt of its
 * own (`sign-ins/oauth`, the provider's callback, `sign-ins/oauth/exchange`).
 */
const FIRST_FACTORS: readonly FirstFactor[] = [
  { strategy: 'password', enabled: (settings) => settings.signIn.methods.password.enabled },
  { strategy: 'email_code', enabled: (settings) => settings.signIn.methods.emailCode.enabled },
  { strategy: 'email_link', enabled: (settings) => settings.signIn.methods.emailLink.enabled },
  { strategy: 'oauth_google', enabled: (_settings, providers) => providers.includes('google') },
  { strategy: 'oauth_github', enabled: (_settings, providers) => providers.includes('github') },
  { strategy: 'oauth_apple', enabled: (_settings, providers) => providers.includes('apple') },
]

/**
 * The setting that switches each first factor on, for the strategies proven through the email
 * routes. A step that uses one checks it with `Settings.requireMethod` every time.
 */
export const EMAIL_FACTOR_METHODS = {
  email_code: 'emailCode',
  email_link: 'emailLink',
} as const satisfies Record<EmailVerificationStrategy, SignInMethod>

/**
 * The first factors an environment offers at sign-in.
 *
 * Decided by the environment's settings **alone**. It must never take an identifier or a user:
 * the list is sent in the answer to a sign-in start, before anything is proven, so a list that
 * depended on the account would tell a stranger whether an address has a password or a passkey.
 *
 * @param settings - The environment's settings.
 * @param providers - The OAuth providers the environment has enabled (`OAuth.enabledProviders`).
 * @returns The enabled strategies, in registry order. Empty when every method is switched off.
 *
 * @example
 * ```ts
 * Factors.firstFactors(await Settings.current(deps, tenant)) // ['password']
 * ```
 */
export function firstFactors(
  settings: EnvironmentSettings,
  providers: readonly OAuthProvider[] = []
): FirstFactorStrategy[] {
  return FIRST_FACTORS.filter((factor) => factor.enabled(settings, providers)).map(
    (factor) => factor.strategy
  )
}

/**
 * The second factors a user must prove one of before a session is started for them.
 *
 * The flow engine asks this after every accepted first factor and after a password reset's code
 * and new password are accepted. A non-empty answer moves the attempt to `needs_second_factor`
 * instead of `complete`: no session and no tokens until one of them is proven.
 *
 * A user with a **confirmed** authenticator is asked for `totp`, or `backup_code` while an
 * unused one is left. A pending enrolment counts for nothing. The environment's MFA policy is
 * not consulted: a factor a user has is asked for even where the policy is `off` (ADR 0025).
 *
 * @param deps - Factor store.
 * @param tenant - The environment.
 * @param userId - The user whose first factor was just accepted.
 * @returns The methods the user may choose from; empty when no second factor is required.
 */
export async function requiredFor(
  deps: Pick<Deps, 'factors'>,
  tenant: Pick<Tenant, 'environmentId'>,
  userId: string
): Promise<SecondFactorMethod[]> {
  return Mfa.secondFactors(deps, tenant, userId)
}

/** The second factors a user can enrol inside an attempt, where the environment requires one. */
export const ENROLMENT_METHODS: readonly FactorEnrolmentMethod[] = ['totp']

/**
 * Whether a user who has passed everything else must enrol a second factor before their
 * attempt completes: the environment's policy is `required` and they have none.
 *
 * @param deps - Settings store and config.
 * @param tenant - The environment.
 * @param secondFactors - What {@link requiredFor} answered for the user.
 * @returns `true` when the attempt must stop at `needs_factor_enrolment`.
 */
export async function enrolmentRequired(
  deps: Pick<Deps, 'environmentSettings' | 'config'>,
  tenant: Pick<Tenant, 'environmentId'>,
  secondFactors: readonly SecondFactorMethod[]
): Promise<boolean> {
  return (
    secondFactors.length === 0 && (await Settings.current(deps, tenant)).mfa.policy === 'required'
  )
}

/** What a client submits to prove a second factor. */
export interface SecondFactorProof {
  method: SecondFactorMethod
  /** What the method needs: a code for TOTP, a backup code, a WebAuthn assertion for a passkey. */
  response: unknown
}

/** A second factor that was proven. */
export interface SecondFactorProven {
  /** What it adds to the session's `amr`, e.g. `['otp']`. */
  methods: string[]
  /** For a backup code: how many unused ones the user has left. */
  backupCodesRemaining?: number
}

/**
 * Checks one kind of second factor for a user.
 *
 * @param deps - All dependencies.
 * @param tenant - The environment.
 * @param userId - The user the attempt belongs to.
 * @param response - What the client submitted.
 * @param actor - The user with the request's origin, for a verifier that records something.
 * @returns What was proven, `true` for a proof with nothing to add, or `false` when the
 *   response does not prove the factor. Never throws for a wrong response.
 */
export type SecondFactorVerifier = (
  deps: Deps,
  tenant: Tenant,
  userId: string,
  response: unknown,
  actor: Actor
) => Promise<boolean | SecondFactorProven>

/**
 * The verifier of each second-factor method: `totp` and `backup_code` (ADR 0025). Step 1.10
 * registers `passkey` here. A method with no verifier can never be proven.
 */
export const SECOND_FACTOR_VERIFIERS: Partial<Record<SecondFactorMethod, SecondFactorVerifier>> = {
  totp: async (deps, tenant, userId, response) =>
    (await Mfa.verifyTotp(deps, tenant, userId, response)) && { methods: ['otp'] },
  backup_code: async (deps, tenant, userId, response, actor) => {
    const remaining = await Mfa.verifyBackupCode(deps, tenant, userId, response, actor)
    return remaining !== null && { methods: ['backup_code'], backupCodesRemaining: remaining }
  },
}

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
 * @param actor - The user with the request's origin.
 * @returns What was proven, or `null` for a wrong proof or a method with no verifier.
 */
export async function verify(
  deps: Deps,
  tenant: Tenant,
  userId: string,
  proof: SecondFactorProof,
  actor: Actor
): Promise<SecondFactorProven | null> {
  const outcome = await SECOND_FACTOR_VERIFIERS[proof.method]?.(
    deps,
    tenant,
    userId,
    proof.response,
    actor
  )
  if (!outcome) {
    return null
  }
  return outcome === true ? { methods: [] } : outcome
}
