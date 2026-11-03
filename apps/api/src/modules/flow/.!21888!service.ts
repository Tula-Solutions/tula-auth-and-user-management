import {
  durationToMs,
  EMAIL_LINK_ATTEMPT_PARAM,
  EMAIL_LINK_TOKEN_PARAM,
  type EmailLinkRequest,
  type EmailLinkResult,
  type FirstFactorAttemptRequest,
  type FirstFactorPrepareRequest,
  type FirstFactorStrategy,
  FirstFactorStrategySchema,
  type FlowAttempt,
  type FlowKind,
  type FlowStep,
  ID_TOKEN_CLIENT_KINDS,
  type Identity,
  type IdentityLinkStart,
  type IdTokenProvider,
  IdTokenProviderSchema,
  isTestAddress,
  maskPhoneNumber,
  OAUTH_ERROR_PARAM,
  OAUTH_TICKET_PARAM,
  type OAuthExchangeRequest,
  type OAuthProvider,
  OAuthProviderSchema,
  type OAuthStartRequest,
  PASSKEY_CHALLENGE_TTL_MS,
  type PasskeyAssertionCredential,
  type PasskeyRequestOptions,
  type PasswordResetRequest,
  type PasswordResetStartRequest,
  PreparedFirstFactorStrategySchema,
  PreparedSecondFactorMethodSchema,
  parsePhoneNumber,
  type SecondFactorMethod,
  SecondFactorMethodSchema,
  type SecondFactorPrepareRequest,
  type SessionClient,
  SessionClientSchema,
  type SignInStartRequest,
  type SignUpRequest,
  type SsoStartRequest,
  type TotpEnrolment,
} from '@tula-tech/contract'
import { z } from 'zod'
import type { Deps, Tenant } from '~/dependencies'
import {
  AuthError,
  InvalidEmailError,
  RateLimitError,
  ServiceUnavailableError,
  ValidationError,
} from '~/exceptions'
import { type Actor, cleanOrigin, systemActor } from '~/lib/actor'
import { ipBucket } from '~/lib/client-ip'
import { randomToken, sha256Hex, timingSafeEqual } from '~/lib/crypto'
import { maskEmail, normalizeEmail, parseEmail, type TestAddressPermit } from '~/lib/email'
import { errorName } from '~/lib/safe-error'
import * as logger from '~/lib/logger'
import { UUID_PATTERN } from '~/lib/uuid'
import * as WebAuthn from '~/lib/webauthn'
import * as Audit from '~/modules/audit/service'
import * as Factors from '~/modules/factor/service'
import * as Hooks from '~/modules/hook/service'
import * as Mfa from '~/modules/mfa/service'
import * as Notices from '~/modules/notice/service'
import * as OAuth from '~/modules/oauth/service'
import * as OrganizationDomains from '~/modules/organization-domain/service'
import * as Passkeys from '~/modules/passkey/service'
import * as Foreign from '~/modules/password/foreign-hash'
import * as Passwords from '~/modules/password/service'
import * as Phone from '~/modules/phone/service'
import * as Sessions from '~/modules/session/service'
import * as Settings from '~/modules/settings/service'
import * as Sms from '~/modules/sms/service'
import * as Sso from '~/modules/sso/service'
import * as Users from '~/modules/user/service'
import * as Verification from '~/modules/verification/service'
import type { FlowAttemptRecord } from '~/ports/flow-attempt-store'
import { CREDENTIAL_LOCKOUT, signInLockKey } from '~/ports/lockout'
import { type OAuthProfile, OAuthProviderError } from '~/ports/oauth-provider'
import { mergeAuthMethods } from '~/ports/session-store'
import type { SsoConnectionRecord } from '~/ports/sso-connection-store'
import type { UserRecord } from '~/ports/user-repository'
import { sendAccountExistsNotice, sendNoAccountNotice, sendNoAccountSignInNotice } from './mailer'
import { assertAccepts, nextStatus } from './transitions'

/** How long a sign-in or sign-up attempt can be continued. */
export const ATTEMPT_TTL = '10m'
/** Prefix of an attempt secret, so one is recognisable in a leak scan (like `tula_rt_`). */
export const ATTEMPT_SECRET_PREFIX = 'tula_at_'
/**
 * Prefix of a link binding: the value that ties an emailed sign-in link to the browser that
 * asked for it. Recognisable, and unmistakably not a token: on its own it authorizes nothing.
 */
export const LINK_BINDING_PREFIX = 'tula_lb_'
/**
 * Prefix of an OAuth binding: the value that ties a provider's answer to the browser that
 * started the sign-in. Like a link binding it is not a token: alone it authorizes nothing.
 */
export const OAUTH_BINDING_PREFIX = 'tula_ob_'
/** Prefix of the single-use ticket an OAuth callback hands to the app's page. */
export const OAUTH_TICKET_PREFIX = 'tula_ot_'
/** How long an OAuth ticket can be exchanged. Long enough for one redirect, no longer. */
export const OAUTH_TICKET_TTL = '60s'
// Stands in for the stored hash of an attempt that does not exist or has none. Not hex, so no
// SHA-256 digest can ever equal it.
const NO_SECRET_HASH = 'x'.repeat(64)
/**
 * Requests per minute for a whole environment, across all callers, on the steps that cost an
 * argon2id hash or an email. Generous for real traffic (ten sign-ups a second), tight enough
 * that a botnet aimed at one tenant can't monopolise the server. Refresh has no ceiling: every
 * active user refreshes about once a minute, so one would throttle a large app in normal use.
 *
 * `passkeyStart` is apart from `verify` on purpose. A passkey start is asked for by every open
 * sign-in page, signed in to nothing: once when the page loads (the autofill request) and again
 * every four minutes while it sits idle. Counted under `verify`, idle pages (or anyone
 * requesting starts) would use up the ceiling that real users' code and second-factor steps
 * need. 6,000 a minute is 100 sign-in page loads a second, or 24,000 pages left open; a start
 * costs one attempt row and no hash or email, so it can be twice as generous as `verify`.
 */
export const ENVIRONMENT_RATE_LIMITS = {
  signUp: 600,
  passwordReset: 600,
  emailSignIn: 600,
  password: 3_000,
  verify: 3_000,
  oauth: 3_000,
  passkeyStart: 6_000,
} as const

type CeilingStep = keyof typeof ENVIRONMENT_RATE_LIMITS

/**
 * Rate-limiter key of an environment's ceiling for a step.
 *
 * @param step - The step.
 * @param tenant - The environment.
 * @returns The bucket key.
 */
export function environmentKey(step: CeilingStep, tenant: Pick<Tenant, 'environmentId'>): string {
  return `environment_${step}:${tenant.environmentId}`
}

/**
 * Count a request against its environment's ceiling.
 *
 * Called from inside each step, **after** the request has been validated and its attempt
 * found, and just before the expensive work. A ceiling counted in middleware would also count
 * malformed requests and made-up attempt ids, letting junk that costs the server nothing
 * throttle every real user of the environment.
 */
async function chargeEnvironment(
  deps: Pick<Deps, 'rateLimiter'>,
  tenant: Pick<Tenant, 'environmentId'>,
  step: CeilingStep
): Promise<void> {
  const decision = await deps.rateLimiter.hit(
    environmentKey(step, tenant),
    ENVIRONMENT_RATE_LIMITS[step],
    60_000
  )
  if (!decision.allowed) {
    throw new RateLimitError(decision.retryAfterMs)
  }
}

/**
 * Refuse a step of a password flow in an environment that has switched passwords off.
 *
 * Checked on **every** step, not only when an attempt starts: an attempt lives for ten minutes,
 * and one started before the switch-off must not finish with a password afterwards, whether
 * that means signing in with one, setting one, or creating an account that has one (a sign-up
 * holds the hash of its password until the email is verified). Each step calls this after the
 * attempt is found and before anything is counted, spent or sent, so a refused step uses up
 * no guess, no code and no rate limit. The email first factors check their own switches
 * (`Factors.EMAIL_FACTOR_METHODS`), and a sign-up made without a password checks the email
 * code's ({@link requireSignUpMethod}).
 */
function requirePasswordMethod(
  deps: Pick<Deps, 'environmentSettings' | 'config'>,
  tenant: Pick<Tenant, 'environmentId'>
): Promise<void> {
  return Settings.requireMethod(deps, tenant, 'password')
}

/**
 * Refuse a step of a sign-up the environment no longer allows: passwords switched off for a
 * sign-up that chose one; for one that did not, the email code switched off (its account could
 * only ever get in by email) **or the sign-up mode back at `required`**. An operator who
 * requires a password again must not get a passwordless account from an attempt that was
 * already under way. Checked on every step, before anything is counted, spent or sent, and the
 * same for a decoy.
 *
 * @throws AuthError `auth.method_disabled`.
 */
async function requireSignUpMethod(
  deps: Pick<Deps, 'environmentSettings' | 'config'>,
  tenant: Pick<Tenant, 'environmentId'>,
  state: Pick<State, 'passwordless'>
): Promise<void> {
  if (!state.passwordless) {
    return Settings.requireMethod(deps, tenant, 'password')
  }
  if ((await Settings.current(deps, tenant)).signUp.password !== 'optional') {
    throw new AuthError('auth.method_disabled')
  }
  return Settings.requireMethod(deps, tenant, 'emailCode')
}

/**
 * Refuse a step of a sign-in with a texted code unless a texted code can still be had: the
 * method is on (`signIn.methods.smsCode`), text messages are on with the identifier's
 * country allowed (`Settings.requireSms`), and the deployment has a sender.
 *
 * On **every** step that asks for, accepts or follows a texted code, before anything is
 * counted, spent or sent: a code asked for before the method or SMS was switched off, or
 * before its country left the list, is not honoured after. Every answer depends on the
 * settings and on what was typed, never on an account.
 *
 * @param identifier - What the sign-in was started with.
 * @returns The identifier as a number in E.164 form, or `null` when it is not a number (an
 *   email address typed for a sign-in that then asked for a texted code).
 * @throws AuthError `auth.method_disabled`, `sms.disabled`, `sms.country_not_allowed` or
 *   `sms.unavailable`.
 */
async function requireSmsMethod(
  deps: Pick<Deps, 'environmentSettings' | 'config' | 'sms'>,
  tenant: Pick<Tenant, 'environmentId'>,
  identifier: string
): Promise<string | null> {
  await Settings.requireMethod(deps, tenant, 'smsCode')
  const number = parsePhoneNumber(identifier)
  await Settings.requireSms(deps, tenant, number ?? undefined)
  Sms.requireSender(deps, tenant)
  return number
}

/**
 * The lockout key of a sign-in's identifier: every guess at one identifier, of a password or
 * of a code, counts under one key (ADR 0011). An email address is hashed as it always was;
 * a phone number goes under a **keyed** hash (`Phone.signInLockKey`), because a plain hash of
 * a number is undone by trying every number.
 */
async function identifierLockKey(
  deps: Pick<Deps, 'keyedHash'>,
  tenant: Pick<Tenant, 'environmentId'>,
  identifier: string
): Promise<string> {
  const number = parsePhoneNumber(identifier)
  return number === null
    ? signInLockKey(tenant.environmentId, identifier)
    : Phone.signInLockKey(deps, tenant.environmentId, number)
}

/**
 * Refuse a step that comes **after** an attempt's first proof once the method that proof used
 * has been switched off.
 *
 * "On every step" includes the steps an attempt is parked on: the emailed code of
 * `needs_email_verification`, a second factor, an enrolment. An attempt lives ten minutes, and
 * one that got past its first factor with a method the operator has since disabled must not
 * end in a session. What is checked is the method the attempt **actually proved**:
 *
 * - a sign-up: its own rule ({@link requireSignUpMethod});
 * - a password reset: the password;
 * - a sign-in: the first factor recorded on the attempt. A password, an emailed code or link
 *   by its settings switch; a texted code by its switch and by everything a text message
 *   needs ({@link requireSmsMethod}); a passkey through `Passkeys.relyingParty` (which is also its
 *   "still on" check, and holds the step to the relying party's origins); a provider through
 *   `OAuth.credentials`. An attempt stored before the factor was recorded proved a password or
 *   nothing this function lets through: it is held to the password's switch.
 *
 * Called after `load` and the step check, and before anything is counted, spent or sent, so a
 * refusal uses up no guess, no code, no challenge and no rate limit.
 *
 * @throws AuthError `auth.method_disabled`, `request.origin_not_allowed` for a passkey
 *   attempt continued from an origin outside the relying party, or what a text message is
 *   refused with (`sms.disabled`, `sms.country_not_allowed`, `sms.unavailable`) for an
 *   attempt that proved a texted code.
 */
async function requireProvenMethod(
  deps: Pick<
    Deps,
    'environmentSettings' | 'config' | 'oauthProviders' | 'secretBox' | 'sms' | 'nativeApps'
  >,
  tenant: Tenant,
  attempt: Pick<FlowAttemptRecord, 'kind' | 'identifier'>,
  state: Pick<State, 'passwordless' | 'firstFactor' | 'client'>,
  context: Pick<ClientContext, 'origin'>
): Promise<void> {
  if (attempt.kind === 'sign_up') {
    return requireSignUpMethod(deps, tenant, state)
  }
  const first = attempt.kind === 'password_reset' ? 'password' : (state.firstFactor ?? 'password')
  if (first === 'password') {
    return requirePasswordMethod(deps, tenant)
  }
  if (first === 'email_code' || first === 'email_link') {
    return Settings.requireMethod(deps, tenant, Factors.EMAIL_FACTOR_METHODS[first])
  }
  if (first === 'sms_code') {
    await requireSmsMethod(deps, tenant, attempt.identifier)
    return
  }
  if (first === 'passkey') {
    await Passkeys.relyingParty(deps, tenant, ceremony(context, state.client))
    return
  }
  await OAuth.credentials(deps, tenant, OAuthProviderSchema.parse(first.slice('oauth_'.length)))
}

/**
 * What of a flow request decides a passkey ceremony's relying party (`Passkeys.relyingParty`):
 * the request's `Origin` header and a client kind.
 *
 * The kind is the one the **attempt was started with**, never a header of a later call: it is
 * fixed at the start like everything else an attempt was asked for, so a step cannot move an
 * attempt from a browser's rule to a native app's. A request that has an `Origin` is judged
 * by it whatever the kind.
 *
 * @param context - The request.
 * @param client - The client kind: the start's own, or the attempt's.
 * @returns The two values, and nothing of the request's body.
 */
function ceremony(
  context: Pick<ClientContext, 'origin'>,
  client: SessionClient
): Passkeys.CeremonyRequest {
  return { origin: context.origin, client }
}

/** The device a flow request comes from. */
export interface ClientContext {
  /**
   * Decides how the refresh token is delivered when the flow completes. Read only when an
   * attempt starts; later calls use the kind the attempt was started with.
   */
  client: SessionClient
  /**
   * The session profile the client asked for (`x-tula-session-profile`), if any. Like `client`
   * it is read only when an attempt starts and kept on the attempt.
   */
  profile?: string
  userAgent: string | null
  ipAddress: string | null
  /**
   * A sign-in test's permit to use an address of the reserved test domain (ADR 0058). Only
   * `~/modules/sign-in-test/service` can make one, and no router ever sets it: for every
   * request such an address is not an address (`parseEmail`).
   */
  testAddress?: TestAddressPermit
  /**
   * The thumbprint of the device key the start's proof was accepted for (ADR 0043), when the
   * request that starts the attempt brought one. Like `client` it is read only when an attempt
   * starts and kept on the attempt: no later step adds, changes or removes it.
   */
  deviceThumbprint?: string
  /**
   * Whether the request may set or use the environment's cookies: it has no `Origin` header (not
   * a cross-origin browser request), or its origin is one the environment allows. The same rule
   * the refresh cookie is read under (`originMayUseCookies`).
   */
  originAllowed: boolean
  /**
   * The request's `Origin` header, for a passkey step: a browser's WebAuthn response is
   * verified against the origin of the page that made the request, and a request without one
   * can only be a registered native app's (ADR 0027). Unused by every other step.
   */
  origin?: string | null
}

/**
 * Which attempt a call is about: its id, and the secret the client was given when it started.
 *
 * Both are needed. The id travels in URL paths, which are logged; the secret travels only in
 * the `x-tula-attempt` header.
 */
export interface AttemptRef {
  id: string
  /** The presented secret, if any. A missing one never matches. */
  secret: string | undefined
}

/** The outcome of a flow call: the attempt's next step, plus tokens once it is `complete`. */
export interface FlowResult {
  attempt: FlowAttempt
  /** Present only when the step is `complete`. The router delivers the refresh token. */
  tokens?: Sessions.IssuedSession
  /** The client kind the attempt was started from. */
  client: SessionClient
}

/** Server-only state kept on an attempt. Never sent to clients. */
/**
 * What an attempt remembers of the client that started it: its kind, the profile it asked for
 * and the device key it proved. **The one place the key gets onto an attempt**: every start
 * builds its state from this, and no later step is given the request's proof.
 */
function asked(context: Pick<ClientContext, 'client' | 'profile' | 'deviceThumbprint'>): {
  client: SessionClient
  profile?: string
  deviceThumbprint?: string
} {
  return {
    client: context.client,
    ...(context.profile && { profile: context.profile }),
    ...(context.deviceThumbprint && { deviceThumbprint: context.deviceThumbprint }),
  }
}

const StateSchema = z.object({
  client: SessionClientSchema,
  /**
   * The session profile the client asked for when the attempt started. Only a request: the
   * session service decides at `finish` whether the environment offers it (ADR 0028).
   */
  profile: z.string().max(64).optional(),
  /**
   * The thumbprint of the device key the attempt's start accepted a proof for (ADR 0043). The
   * session the attempt ends in is bound to it. Set by the start and carried unchanged by
   * every step; absent for an attempt that brought no proof.
   */
  deviceThumbprint: z.string().optional(),
  /** Email as entered, for sending and for the masked destination. */
  email: z.string().optional(),
  firstName: z.string().nullable().optional(),
  lastName: z.string().nullable().optional(),
  /** argon2id hash of the password a sign-up will create the account with. */
  passwordHash: z.string().optional(),
  /**
   * The attempt can never complete: a sign-up for an email that already had an account, or a
   * password reset for one that had none.
   */
  decoy: z.boolean().optional(),
  /** The first factors a sign-in was offered when it started. */
  strategies: z.array(FirstFactorStrategySchema).optional(),
  /**
   * The first factor a sign-in proved. Kept while the attempt waits on a later step (an emailed
   * code, a second factor, an enrolment), because that step must still be refused once the
   * method that got the attempt there is switched off ({@link requireProvenMethod}). Not
   * derivable from `amr`: `email` is recorded by a code and by a link, `fed` by every provider.
   */
  firstFactor: FirstFactorStrategySchema.optional(),
  /** The second factors the user may choose from, while the attempt waits on one. */
  secondFactors: z.array(SecondFactorMethodSchema).optional(),
  /**
   * The second factor a code was last texted for while the attempt waits on one, and the
   * masked number it went to (`***42`: the last two digits, never the number). Kept so that
   * the step can say where the code went; the number itself is read from the account at
   * every send and every check.
   */
  secondFactorPrepared: z
    .object({ method: PreparedSecondFactorMethodSchema, destination: z.string().max(16) })
    .optional(),
  /** A sign-up made without a password (`signUp.password: 'optional'`). */
  passwordless: z.boolean().optional(),
  /** The first factor a sign-in last asked an email, or a text message, for. */
  prepared: PreparedFirstFactorStrategySchema.optional(),
  /**
   * SHA-256 of the binding returned to the browser that asked for an emailed link. The link is
   * honoured only together with that binding.
   */
  linkBindingHash: z.string().optional(),
  /**
   * The emailed link was opened in the browser that asked for it: the first factor is proven,
   * and the client holding the attempt's secret may complete the sign-in.
   */
  linkVerified: z.boolean().optional(),
  /**
   * What the attempt has proven so far, as `amr` values (`pwd`, `email`, `otp`, …). Becomes the
   * session's `authMethods` when the attempt completes.
   */
  amr: z.array(z.string()).optional(),
  /**
   * The attempt is a sign-in that created its account (a first sign-in with a provider). The
   * `before_session` hook is told so (`signUp`), also when the attempt waited on an enrolment
   * in between. A sign-up attempt needs no mark: its kind says it.
   */
  accountCreated: z.boolean().optional(),
  /**
   * The sign-in proved a password that is older than the environment's `password.expiryDays`
   * allows (ADR 0041): the attempt sets a new one before it completes. The value is when that
   * password was set (epoch milliseconds), kept so that the step which replaces it can tell
   * that it is still the password this attempt proved: one replaced meanwhile (the owner's
   * own reset) was set at another time, and then the attempt has proven nothing.
   */
  expiredPasswordSetAt: z.number().optional(),
  /**
   * The WebAuthn challenge an attempt issued and has not used yet (ADR 0027), and when it stops
   * being accepted (epoch milliseconds). Top-level, because taking it is a compare-and-set on
   * its value (`StateGuard`): a challenge is used up by the first request that presents an
   * assertion for it, whatever that assertion turns out to be.
   */
  passkeyChallenge: z.string().optional(),
  passkeyChallengeExpiresAt: z.number().optional(),
  /**
   * A native ID-token sign-in (ADR 0045): the provider whose token the attempt waits for.
   * Fixed by the start; the exchange reads the provider from here and never from a request.
   */
  idTokenProvider: IdTokenProviderSchema.optional(),
  /**
   * The nonce a native ID-token sign-in was started with, until a token is presented for
   * it. Top-level, because taking it is a compare-and-set on its value (`StateGuard`), as a
   * passkey challenge is taken: it is used up by the first request that presents a token,
   * whatever that token turns out to be, so a token is judged once per attempt.
   */
  idTokenNonce: z.string().optional(),
  /**
   * Where an OAuth attempt is in its round trip (ADR 0026). Top-level, because each move is a
   * compare-and-set on it (`StateGuard`): the attempt's `status` stays `needs_first_factor`
   * from the start until the ticket is exchanged, so the status alone could not make a state or
   * a ticket single-use.
   *
