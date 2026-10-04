import {
  durationToMs,
  EMAIL_LINK_ATTEMPT_PARAM,
  EMAIL_LINK_TOKEN_PARAM,
  type EmailLinkRequest,
  type EmailLinkResult,
  EmailVerificationStrategySchema,
  type FirstFactorAttemptRequest,
  type FirstFactorPrepareRequest,
  FirstFactorStrategySchema,
  type FlowAttempt,
  type FlowKind,
  type FlowStep,
  type Identity,
  type IdentityLinkStart,
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
  type SecondFactorMethod,
  SecondFactorMethodSchema,
  type SessionClient,
  SessionClientSchema,
  type SessionTokens,
  type SignInStartRequest,
  type SignUpRequest,
  type TotpEnrolment,
} from '@tula/contract'
import { z } from 'zod'
import type { Deps, Tenant } from '~/dependencies'
import { AuthError, InvalidEmailError, RateLimitError, ValidationError } from '~/exceptions'
import { type Actor, cleanOrigin, systemActor } from '~/lib/actor'
import { randomToken, sha256Hex, timingSafeEqual } from '~/lib/crypto'
import { maskEmail, normalizeEmail, parseEmail } from '~/lib/email'
import * as logger from '~/lib/logger'
import * as WebAuthn from '~/lib/webauthn'
import * as Audit from '~/modules/audit/service'
import * as Factors from '~/modules/factor/service'
import * as Mfa from '~/modules/mfa/service'
import * as Notices from '~/modules/notice/service'
import * as OAuth from '~/modules/oauth/service'
import * as Passkeys from '~/modules/passkey/service'
import * as Passwords from '~/modules/password/service'
import * as Sessions from '~/modules/session/service'
import * as Settings from '~/modules/settings/service'
import * as Users from '~/modules/user/service'
import * as Verification from '~/modules/verification/service'
import type { FlowAttemptRecord } from '~/ports/flow-attempt-store'
import { CREDENTIAL_LOCKOUT, signInLockKey } from '~/ports/lockout'
import { OAuthProviderError } from '~/ports/oauth-provider'
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
 */
export const ENVIRONMENT_RATE_LIMITS = {
  signUp: 600,
  passwordReset: 600,
  emailSignIn: 600,
  password: 3_000,
  verify: 3_000,
  oauth: 3_000,
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

/** The device a flow request comes from. */
export interface ClientContext {
  /**
   * Decides how the refresh token is delivered when the flow completes. Read only when an
   * attempt starts; later calls use the kind the attempt was started with.
   */
  client: SessionClient
  userAgent: string | null
  ipAddress: string | null
  /**
   * Whether the request may set or use the environment's cookies: it has no `Origin` header (not
   * a cross-origin browser request), or its origin is one the environment allows. The same rule
   * the refresh cookie is read under (`originMayUseCookies`).
   */
  originAllowed: boolean
  /**
   * The request's `Origin` header, for a passkey step: a WebAuthn response is verified against
   * the origin of the page that made the request (ADR 0027). Unused by every other step.
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
  tokens?: SessionTokens
  /** The client kind the attempt was started from. */
  client: SessionClient
}

/** Server-only state kept on an attempt. Never sent to clients. */
const StateSchema = z.object({
  client: SessionClientSchema,
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
  /** The second factors the user may choose from, while the attempt waits on one. */
  secondFactors: z.array(SecondFactorMethodSchema).optional(),
  /** A sign-up made without a password (`signUp.password: 'optional'`). */
  passwordless: z.boolean().optional(),
  /** The email first factor a sign-in last asked an email for. */
  prepared: EmailVerificationStrategySchema.optional(),
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
   * The WebAuthn challenge an attempt issued and has not used yet (ADR 0027), and when it stops
   * being accepted (epoch milliseconds). Top-level, because taking it is a compare-and-set on
   * its value (`StateGuard`): a challenge is used up by the first request that presents an
   * assertion for it, whatever that assertion turns out to be.
   */
  passkeyChallenge: z.string().optional(),
  passkeyChallengeExpiresAt: z.number().optional(),
  /**
   * Where an OAuth attempt is in its round trip (ADR 0026). Top-level, because each move is a
   * compare-and-set on it (`StateGuard`): the attempt's `status` stays `needs_first_factor`
   * from the start until the ticket is exchanged, so the status alone could not make a state or
   * a ticket single-use.
   *
   * `started` (the user is at the provider) → `returned` (the callback consumed the state) →
   * `proven` (the provider vouched; a ticket is out) → `exchanged` (the ticket was used).
   */
  oauthPhase: z.enum(['started', 'returned', 'proven', 'exchanged']).optional(),
  /** What an OAuth attempt keeps server-side. None of it is ever sent to a client. */
  oauth: z
    .object({
      provider: OAuthProviderSchema,
      /** `sign_in` also creates the account; `link` connects the identity to a signed-in user. */
      intent: z.enum(['sign_in', 'link']),
      /** The app's page the callback redirects to. Checked against the allow-list at the start. */
      redirectUrl: z.string(),
      /** SHA-256 of the `state` parameter. */
      stateHash: z.string(),
      /** PKCE verifier and OIDC nonce: needed once, for the code exchange. */
      codeVerifier: z.string().optional(),
      nonce: z.string().optional(),
      /** SHA-256 of the binding the starting browser was given. */
      bindingHash: z.string(),
      /** For `link`: the signed-in user the attempt was started by. */
      linkUserId: z.string().optional(),
      /** SHA-256 of the ticket, and when it stops being accepted (epoch milliseconds). */
      ticketHash: z.string().optional(),
      ticketExpiresAt: z.number().optional(),
      /** What the provider vouched for, kept from the callback until the exchange. */
      profile: z
        .object({
          subject: z.string(),
          email: z.string().nullable(),
          emailVerified: z.boolean(),
          givenName: z.string().optional(),
          familyName: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
})
type State = z.infer<typeof StateSchema>

function stepFor(
  attempt: Pick<FlowAttemptRecord, 'status' | 'identifier'>,
  state: State
): FlowStep {
  if (attempt.status === 'needs_email_verification') {
    return {
      status: 'needs_email_verification',
      destination: maskEmail(state.email ?? attempt.identifier),
      strategies: ['email_code'],
    }
  }
  if (attempt.status === 'needs_new_password') {
    return {
      status: 'needs_new_password',
      destination: maskEmail(state.email ?? attempt.identifier),
      strategies: ['email_code'],
    }
  }
  if (attempt.status === 'needs_first_factor') {
    return {
      status: 'needs_first_factor',
      strategies: state.strategies ?? [],
      // The identifier as it was typed at the start, masked: it says nothing about an account.
      ...(state.prepared && {
        prepared: { strategy: state.prepared, destination: maskEmail(attempt.identifier) },
      }),
    }
  }
  if (attempt.status === 'needs_second_factor') {
    return { status: 'needs_second_factor', options: state.secondFactors ?? [] }
  }
  if (attempt.status === 'needs_factor_enrolment') {
    return { status: 'needs_factor_enrolment', methods: [...Factors.ENROLMENT_METHODS] }
  }
  // Open attempts are only ever stored on the steps above or `needs_password`; `complete` is
  // built by `finish` with its ids.
  return { status: 'needs_password' }
}

/**
 * @param secret - Given only for the response that starts the attempt: the one time the client
 *   is told its secret.
 * @param linkBinding - Given only for the response to asking for an emailed link.
 */
function toAttempt(
  attempt: FlowAttemptRecord,
  step: FlowStep,
  secret?: string,
  linkBinding?: string,
  once: CompletionExtras = {}
): FlowAttempt {
  return {
    id: attempt.id,
    kind: attempt.kind,
    expiresAt: attempt.expiresAt.toISOString(),
    step,
    ...(secret !== undefined && { attemptSecret: secret }),
    ...(linkBinding !== undefined && { linkBinding }),
    ...once,
  }
}

/** What only the response that completes an attempt may carry, once. */
type CompletionExtras = Pick<FlowAttempt, 'backupCodes' | 'backupCodesRemaining'>

/** An attempt's state with newly proven methods added to what it has proven so far. */
function proven(state: State, ...methods: string[]): State {
  return { ...state, amr: [...new Set([...(state.amr ?? []), ...methods])] }
}

/** What stands between a user who has passed everything else and their session. */
interface Requirement {
  /** The second factors the user must prove one of. */
  secondFactors: SecondFactorMethod[]
  /** The environment requires a second factor and the user has none to prove. */
  enrolmentRequired: boolean
}

/** Ask what a user still has to do: prove a second factor, enrol one, or nothing. */
async function requirement(
  deps: Pick<Deps, 'factors' | 'passkeys' | 'environmentSettings' | 'config'>,
  tenant: Tenant,
  userId: string
): Promise<Requirement> {
  const secondFactors = await Factors.requiredFor(deps, tenant, userId)
  return {
    secondFactors,
    enrolmentRequired: await Factors.enrolmentRequired(deps, tenant, secondFactors),
  }
}

/**
 * Refuse a browser flow driven from a page the environment does not allow (login CSRF).
 *
 * A browser stores the session cookie a completed flow sets, whoever wrote the page that made
 * the request. Without this, a page on another origin could finish an attacker's own sign-in in
 * the victim's browser and leave the victim signed in to the attacker's account. So a `web`
 * attempt is refused, at its start and at every later step, unless the request has no `Origin`
 * or an allowed one: the same rule under which the cookie is later honoured. Other client
 * kinds get their tokens in the response body, which a foreign page cannot read, and set no
 * cookie.
 *
 * Always checked before anything is counted, spent, sent or stored.
 *
 * @throws AuthError `request.origin_not_allowed`.
 */
function requireAllowedOrigin(
  client: SessionClient,
  context: Pick<ClientContext, 'originAllowed'>
): void {
  if (client === 'web' && !context.originAllowed) {
    throw new AuthError('request.origin_not_allowed')
  }
}

/**
 * Store a new attempt, bound to a fresh secret.
 *
 * The secret is 256 bits from the CSPRNG. Only its SHA-256 is stored; the caller returns the
 * secret itself once, in the response that starts the attempt, and it is never logged, audited
 * or sent again.
 */
async function start(
  deps: Pick<Deps, 'flowAttempts' | 'clock' | 'ids'>,
  tenant: Tenant,
  input: Pick<FlowAttemptRecord, 'kind' | 'status' | 'identifier'> & {
    state: State
    userId?: string
    /** An id chosen by the caller, when the state has to name the attempt before it exists. */
    id?: string
  }
): Promise<{ attempt: FlowAttemptRecord; secret: string }> {
  const now = deps.clock.now()
  const secret = `${ATTEMPT_SECRET_PREFIX}${randomToken()}`
  const attempt: FlowAttemptRecord = {
    id: input.id ?? deps.ids.next(),
    projectId: tenant.projectId,
    environmentId: tenant.environmentId,
    userId: null,
    secretHash: sha256Hex(secret),
    expiresAt: new Date(now.getTime() + durationToMs(ATTEMPT_TTL)),
    completedAt: null,
    createdAt: now,
    ...input,
  }
  await deps.flowAttempts.create(attempt)
  return { attempt, secret }
}

/**
 * Load an open attempt of the given kind, for the client that started it.
 *
 * Every step of every flow goes through here, so none can forget either check:
 *
 * - **The attempt's secret.** Unknown, foreign-environment, wrong-kind, completed and expired
 *   attempts, and any attempt presented without its secret, with a wrong one or with another
 *   attempt's, are all the same `flow.not_found`: an attempt id alone reveals and does nothing.
 *   Hashes are compared in constant time, and a comparison is made even when there is no
 *   attempt. An attempt with no stored hash (written before attempts were bound) matches no
 *   secret: it is never treated as "no secret needed".
 * - **The origin**, for a browser attempt (see {@link requireAllowedOrigin}), after the secret
 *   so that it says nothing to someone who does not hold the attempt.
 */
async function load(
  deps: Pick<Deps, 'flowAttempts' | 'clock'>,
  tenant: Tenant,
  kind: FlowKind,
  ref: AttemptRef,
  context: Pick<ClientContext, 'originAllowed'>
): Promise<{ attempt: FlowAttemptRecord; state: State }> {
  const attempt = await deps.flowAttempts.findById(tenant.environmentId, ref.id)
  const expected = attempt?.secretHash ?? null
  const presented = timingSafeEqual(sha256Hex(ref.secret ?? ''), expected ?? NO_SECRET_HASH)
  if (
    !attempt ||
    expected === null ||
    ref.secret === undefined ||
    !presented ||
    attempt.kind !== kind ||
    attempt.completedAt !== null ||
    attempt.expiresAt.getTime() <= deps.clock.now().getTime()
  ) {
    throw new AuthError('flow.not_found')
  }
  const state = StateSchema.parse(attempt.state)
  requireAllowedOrigin(state.client, context)
  return { attempt, state }
}

/**
 * Complete an attempt and start the user's session.
 *
 * The attempt is moved to `complete` first, as a compare-and-set, so of two racing requests
 * only one creates a session. Pending sign-up data (the password hash) is dropped from it.
 *
 * The only place a flow creates a session, and so the only place the "new sign-in" notice is
 * started (ADR 0023): after `Sessions.create` has returned, so a request that lost the race,
 * stopped at a second factor or failed before this point created no session and sends nothing.
 * Only a sign-in is announced. A sign-up's session belongs to someone who has just verified the
 * address, and a password reset is announced by the password notice.
 *
 * **No session without a factor the user has by now.** An attempt that did not prove a second
 * factor re-reads, after its session is created, whether the user has one. If they do (it was
 * confirmed while this attempt was between its first factor and here), the session is revoked,
 * no tokens are returned and the answer is `flow.invalid_step`: start again. (Not for a
 * sign-up: its account is created by the same request and cannot have a factor yet.)
 */
async function finish(
  deps: Deps,
  tenant: Tenant,
  attempt: FlowAttemptRecord,
  state: State,
  userId: string,
  context: ClientContext,
  once: CompletionExtras = {}
): Promise<FlowResult> {
  const now = deps.clock.now()
  const moved = await deps.flowAttempts.transition(
    tenant.environmentId,
    attempt.id,
    attempt.status,
    { status: 'complete', userId, state: { client: state.client }, completedAt: now },
    now
  )
  if (!moved) {
    throw new AuthError('flow.invalid_step')
  }
  const tokens = await Sessions.create(deps, tenant, {
    userId,
    client: state.client,
    userAgent: context.userAgent,
    ipAddress: context.ipAddress,
    authMethods: state.amr ?? [],
  })
  if (
    attempt.kind !== 'sign_up' &&
    !state.amr?.includes('mfa') &&
    (await Factors.requiredFor(deps, tenant, userId)).length > 0
  ) {
    // The user turned two-step verification on between this attempt's "no second factor
    // needed" and the session just created. Their confirmation ended "every other session"
    // before this one existed, so it would be the one session that never proved the factor.
    // It is ended through the session service (so its access token is denylisted) and no
    // tokens leave. The attempt is already `complete` and cannot be moved back under the
    // compare-and-set rules, so the client starts again and is asked for the factor.
    await Sessions.revoke(deps, tenant, {
      userId,
      sessionId: tokens.sessionId,
      reason: 'mfa_changed',
      actor: systemActor(context),
    })
    throw new AuthError('flow.invalid_step')
  }
  if (attempt.kind === 'sign_in') {
    // Not awaited and cannot throw: the notice must neither delay nor fail the sign-in.
    Notices.newSignIn(deps, tenant, { userId, sessionId: tokens.sessionId })
  }
  try {
    await deps.users.recordSignIn(tenant.environmentId, userId, now)
  } catch (error) {
    // Bookkeeping only: the session exists, so failing here would throw its tokens away.
    logger.warn('could not record the sign-in time', {
      environmentId: tenant.environmentId,
      err: error instanceof Error ? error.name : 'unknown',
    })
  }
  return {
    attempt: toAttempt(
      attempt,
      { status: 'complete', userId, sessionId: tokens.sessionId },
      undefined,
      undefined,
      once
    ),
    tokens,
    client: state.client,
  }
}

/**
 * Park an attempt on `needs_second_factor` or `needs_factor_enrolment`: everything before it was
 * accepted, and the user must now prove one of `secondFactors`, or enrol a factor.
 *
 * No session is created and no tokens are returned. The move is a compare-and-set, so of two
 * racing requests only one gets here. Only what the next step needs is kept on the attempt:
 * never a sign-up's password hash.
 */
async function park(
  deps: Pick<Deps, 'flowAttempts' | 'clock'>,
  tenant: Tenant,
  attempt: FlowAttemptRecord,
  state: State,
  userId: string,
  status: 'needs_second_factor' | 'needs_factor_enrolment',
  secondFactors: State['secondFactors']
): Promise<FlowResult> {
  const { passwordHash: _hash, secondFactors: _earlier, ...kept } = state
  const pending: State = status === 'needs_second_factor' ? { ...kept, secondFactors } : { ...kept }
  const waiting = { ...attempt, status, userId }
  const moved = await deps.flowAttempts.transition(
    tenant.environmentId,
    attempt.id,
    attempt.status,
    { status, userId, state: pending },
    deps.clock.now()
  )
  if (!moved) {
    throw new AuthError('flow.invalid_step')
  }
  return { attempt: toAttempt(waiting, stepFor(waiting, pending)), client: state.client }
}

/**
 * Take an attempt past its last proof: to a session, or to the second factor or the enrolment
 * that still stands in the way.
 */
function advance(
  deps: Deps,
  tenant: Tenant,
  attempt: FlowAttemptRecord,
  state: State,
  userId: string,
  next: FlowStep['status'],
  required: Requirement,
  context: ClientContext
): Promise<FlowResult> {
  if (next === 'needs_second_factor' || next === 'needs_factor_enrolment') {
    return park(deps, tenant, attempt, state, userId, next, required.secondFactors)
  }
  return finish(deps, tenant, attempt, state, userId, context)
}

/**
 * Start a sign-up: check the email and password, then email a verification code.
 *
 * The account is created only when the email is verified, so nobody can squat on an address
 * they don't control. The response is the same whether or not the address already has an
 * account (no enumeration): an existing owner is emailed a notice instead of a code, and the
 * attempt gets a decoy code nobody knows, so later guesses behave identically and can never
 * complete it. The password is hashed in both cases so the two take the same time.
 *
 * **Without a password** (only where the environment says `signUp.password: 'optional'`) the
 * account is created with no password credential: it signs in with an emailed code or link,
 * and gets a first password through the reset flow. Nothing is hashed for either kind of
 * address, so the two still take the same time.
 *
 * @param deps - All dependencies.
 * @param tenant - The environment the publishable key resolved to.
 * @param input - Email, optional password and optional names.
 * @param context - The requesting device.
 * @returns The attempt, waiting on `needs_email_verification`.
 * @throws InvalidEmailError, or a `password.*` ServiceException with per-field `errors`.
 * @throws ValidationError on `password` when it is left out where the environment requires one.
 * @throws AuthError `auth.method_disabled` when the environment has switched off the method the
 *   sign-up relies on (passwords, or the email code for a sign-up without one), or
 *   `request.origin_not_allowed` for a browser attempt from an origin the environment does not
 *   allow.
 * @throws RateLimitError when the address was emailed too recently or too often.
 */
export async function signUp(
  deps: Deps,
  tenant: Tenant,
  input: SignUpRequest,
  context: ClientContext
): Promise<FlowResult> {
  requireAllowedOrigin(context.client, context)
  const parsed = parseEmail(input.email)
  if (!parsed) {
    throw new InvalidEmailError()
  }
  const { email, normalized: identifier } = parsed
  const passwordless = input.password === undefined
  if (passwordless && (await Settings.current(deps, tenant)).signUp.password !== 'optional') {
    throw new ValidationError({
      errors: [{ field: 'password', code: 'validation.failed', message: 'Enter a password.' }],
    })
  }
  await requireSignUpMethod(deps, tenant, { passwordless })
  await chargeEnvironment(deps, tenant, 'signUp')
  const firstName = input.firstName?.trim() || null
  const lastName = input.lastName?.trim() || null
  let passwordHash: string | undefined
  if (input.password !== undefined) {
    await Passwords.assess(deps, tenant, input.password, {
      email,
      firstName: firstName ?? undefined,
      lastName: lastName ?? undefined,
    })
    passwordHash = await Passwords.hash(input.password)
  }

  const decoy = (await deps.users.findByEmail(tenant.environmentId, identifier)) !== null
  const base = { client: context.client, email, ...(passwordless && { passwordless }) }
  const state: State = decoy
    ? { ...base, decoy: true }
    : { ...base, firstName, lastName, ...(passwordHash !== undefined && { passwordHash }) }
  const { attempt, secret } = await start(deps, tenant, {
    kind: 'sign_up',
    status: 'needs_email_verification',
    identifier,
    state,
  })
  try {
    await issueCode(deps, tenant, attempt, state)
  } catch (error) {
    // No email went out, so the attempt can never be completed: don't keep its password hash.
    await deps.flowAttempts.delete(tenant.environmentId, attempt.id)
    throw error
  }
  return { attempt: toAttempt(attempt, stepFor(attempt, state), secret), client: state.client }
}

/**
 * Email the attempt's code (a reset code for a password reset, otherwise a verification code),
 * or the notice that stands in for it on a decoy attempt.
 *
 * @param options.userId - The user the code is for, once known.
 * @param options.charge - Count the email against the environment's ceiling, but only
 *   once the per-address send limits have allowed it: a resend refused by the cooldown sends
 *   nothing and must not use the ceiling up.
 */
async function issueCode(
  deps: Deps,
  tenant: Tenant,
  attempt: FlowAttemptRecord,
  state: State,
  options: { userId?: string; charge?: boolean } = {}
): Promise<void> {
  const reset = attempt.kind === 'password_reset'
  const notice = reset ? sendNoAccountNotice : sendAccountExistsNotice
  await Verification.issue(deps, tenant, {
    purpose: reset ? 'password_reset' : 'email_verification',
    destination: state.email ?? attempt.identifier,
    flowAttemptId: attempt.id,
    userId: options.userId,
    ...(state.decoy && { deliver: ({ to }) => notice(deps, tenant, to) }),
    ...(options.charge && {
      onAllowed: () => chargeEnvironment(deps, tenant, reset ? 'passwordReset' : 'signUp'),
    }),
  })
}

/**
 * Start a sign-in: answer with the first factors the environment offers.
 *
 * `needs_password` when the password is the only enabled method (so the simplest client stays
 * simple), `needs_first_factor` with the enabled strategies otherwise.
 *
 * **The answer depends only on the environment's settings, never on the identifier**, which is
 * not looked up until a factor is submitted: whoever the address belongs to, whether it exists,
 * and whether that account has a password or a passkey, the step is the same. The strategies
 * are kept on the attempt, so a later step accepts exactly what this response offered.
 *
 * @param deps - Flow attempt store, clock, ids and settings.
 * @param tenant - The environment the publishable key resolved to.
 * @param input - The identifier (email).
 * @param context - The requesting device.
 * @returns The attempt, waiting on `needs_password` or `needs_first_factor`, with its secret.
 * @throws AuthError `auth.method_disabled` when the environment has every method switched off,
 *   or `request.origin_not_allowed` for a browser attempt from an origin it does not allow.
 */
export async function signIn(
  deps: Pick<
    Deps,
    'flowAttempts' | 'clock' | 'ids' | 'environmentSettings' | 'config' | 'oauthProviders'
  >,
  tenant: Tenant,
  input: SignInStartRequest,
  context: ClientContext
): Promise<FlowResult> {
  requireAllowedOrigin(context.client, context)
  const strategies = Factors.firstFactors(
    await Settings.current(deps, tenant),
    await OAuth.enabledProviders(deps, tenant)
  )
  if (strategies.length === 0) {
    throw new AuthError('auth.method_disabled')
  }
  const state: State = { client: context.client, strategies }
  const { attempt, secret } = await start(deps, tenant, {
    kind: 'sign_in',
    status:
      strategies.length === 1 && strategies[0] === 'password'
        ? 'needs_password'
        : 'needs_first_factor',
    identifier: normalizeEmail(input.identifier),
    state,
  })
  return { attempt: toAttempt(attempt, stepFor(attempt, state), secret), client: state.client }
}

/**
 * Submit the password for a sign-in attempt.
 *
 * Every failure is the same `auth.invalid_credentials`: unknown identifier, no password set,
 * wrong password. Unknown users still cost one argon2id verify. A ban is only revealed to
 * someone who knows the password. Failures back off exponentially per identifier
 * (`CREDENTIAL_LOCKOUT`), so the lockout follows the account across attempts and IPs; a
 * successful sign-in clears it.
 *
 * Valid on `needs_password`, and on `needs_first_factor` when `password` is among the strategies
 * the attempt was offered.
 *
 * @param deps - All dependencies.
 * @param tenant - The environment the publishable key resolved to.
 * @param ref - The sign-in attempt and its secret.
 * @param password - The submitted password.
 * @param context - The requesting device.
 * @returns `complete` with tokens; `needs_email_verification` for an unverified email; or
 *   `needs_second_factor`, without tokens, for a user who has a second factor.
 * @throws AuthError `flow.not_found`, `flow.invalid_step`, `request.origin_not_allowed`,
 *   `auth.method_disabled`, `auth.invalid_credentials` or `auth.user_banned`.
 * @throws RateLimitError while the identifier is locked out after repeated failures.
 */
export async function submitPassword(
  deps: Deps,
  tenant: Tenant,
  ref: AttemptRef,
  password: string,
  context: ClientContext
): Promise<FlowResult> {
  const { attempt, state } = await load(deps, tenant, 'sign_in', ref, context)
  const strategies = state.strategies ?? []
  const event = { type: 'first_factor_verified', strategy: 'password' } as const
  assertAccepts(attempt.kind, attempt.status, event, strategies)
  await requirePasswordMethod(deps, tenant)
  // Hash the identifier so lockout keys (which may live in Redis) hold no email. The attempt is
  // counted as a failure up front and cleared on success, so parallel guesses can't all slip
  // through; it happens before the lookup, so unknown identifiers lock out exactly the same.
  const lockKey = signInLockKey(tenant.environmentId, attempt.identifier)
  const lock = await deps.lockout.attempt(lockKey, CREDENTIAL_LOCKOUT, deps.clock.now())
  if (!lock.allowed) {
    throw new RateLimitError(lock.retryAfterMs)
  }
  // After the lockout, so a locked-out identifier's refused tries (which hash nothing) can't
  // use the environment's ceiling up. A try the ceiling refuses has already been counted by the
  // lockout as a failure: no password is checked, so it never grants a guess, but while the
  // ceiling is saturated repeated tries do add to that identifier's backoff.
  await chargeEnvironment(deps, tenant, 'password')

  const found = await deps.users.findByEmailWithPassword(tenant.environmentId, attempt.identifier)
  if (!(await Passwords.verify(found?.passwordHash ?? null, password)) || !found) {
    throw new AuthError('auth.invalid_credentials')
  }
  await deps.lockout.clear(lockKey)
  const { user } = found
  if (user.bannedAt !== null) {
    throw new AuthError('auth.user_banned')
  }
  if (found.passwordHash && Passwords.needsRehash(found.passwordHash)) {
    // Only if the stored hash is still the one just verified: a password changed in the
    // meantime must not be overwritten with the old one. Losing that race is fine.
    await deps.users.upgradePasswordHash(
      tenant.environmentId,
      user.id,
      found.passwordHash,
      await Passwords.hash(password),
      deps.clock.now()
    )
  }

  const required = await requirement(deps, tenant, user.id)
  const next = nextStatus(attempt.kind, attempt.status, event, {
    strategies,
    emailVerified: user.emailVerifiedAt !== null,
    ...required,
  })
  if (next !== 'needs_email_verification') {
    return advance(deps, tenant, attempt, proven(state, 'pwd'), user.id, next, required, context)
  }

  const pending: State = { ...proven(state, 'pwd'), email: user.email }
  const waiting = { ...attempt, status: next, userId: user.id }
  // Send the code before moving the attempt: if the send is refused (e.g. the address is on
  // its cooldown) the attempt stays on the password step and can simply be retried.
  await issueCode(deps, tenant, waiting, pending, { userId: user.id })
  const moved = await deps.flowAttempts.transition(
    tenant.environmentId,
    attempt.id,
    attempt.status,
    { status: next, userId: user.id, state: pending },
    deps.clock.now()
  )
  if (!moved) {
    throw new AuthError('flow.invalid_step')
  }
  return { attempt: toAttempt(waiting, stepFor(waiting, pending)), client: state.client }
}

/**
 * Finish a sign-in whose email first factor (a code, or a link opened in the asking browser)
 * has just been proven for `user`.
 *
 * The email proves the inbox, so the address counts as verified (and is marked so, with its
 * audit entry) and the attempt never detours through `needs_email_verification`. A ban is
 * revealed only here, after the factor. A user with a second factor gets `needs_second_factor`
 * and no tokens.
 *
 * @param spend - Uses the proof up. Called after the second factors are read and before
 *   anything is changed, so a failure to read them leaves the proof usable, and of two racing
 *   requests holding the same proof only one gets past it.
 */
async function completeEmailFactor(
  deps: Deps,
  tenant: Tenant,
  attempt: FlowAttemptRecord,
  state: State,
  user: UserRecord,
  strategy: 'email_code' | 'email_link',
  context: ClientContext,
  spend: () => Promise<void>
): Promise<FlowResult> {
  if (user.bannedAt !== null) {
    throw new AuthError('auth.user_banned')
  }
  const required = await requirement(deps, tenant, user.id)
  const next = nextStatus(
    attempt.kind,
    attempt.status,
    { type: 'first_factor_verified', strategy },
    { strategies: state.strategies ?? [], emailVerified: true, ...required }
  )
  await spend()
  if (user.emailVerifiedAt === null) {
    try {
      await deps.users.markEmailVerified(
        tenant.environmentId,
        user.id,
        deps.clock.now(),
        Audit.entry(deps, tenant, {
          type: 'user.email_verified',
          actor: { type: 'user', id: user.id, ...cleanOrigin(context) },
          target: { type: 'user', id: user.id },
        })
      )
    } catch (error) {
      // The proof is spent, so failing here would strand the user. A later password sign-in
      // asks them to verify the address instead.
      logger.warn('could not mark the email verified after an email sign-in', {
        environmentId: tenant.environmentId,
        err: error instanceof Error ? error.name : 'unknown',
      })
    }
  }
  // What the email flow kept on the attempt has done its job and is not carried further.
  const {
    prepared: _prepared,
    linkBindingHash: _linkBindingHash,
    linkVerified: _linkVerified,
    ...rest
  } = state
  return advance(deps, tenant, attempt, proven(rest, 'email'), user.id, next, required, context)
}

/**
 * Email the code (and, for `email_link`, the link) that proves a sign-in's email first factor.
 *
 * **The answer is the same for every address.** An address with no account is sent a notice
 * instead (no code, no link), its attempt holds a decoy code nobody knows, and the per-address
 * send limits, the environment's ceiling, the response and the cost of one email are identical.
 * A banned user is sent a code like anyone else and learns of the ban only after proving the
 * inbox. Calling it again sends a fresh email and retires the previous code and link.
 *
 * **`email_link`** (ADR 0024). `redirectUrl` must be, exactly, one of the environment's
 * `urls.allowedRedirectUrls`. The email's link is that URL with the link token and the attempt
 * id in the **fragment**, which a browser never sends to a server. The response carries a
 * `linkBinding`, once: 256 random bits whose SHA-256 is kept on the attempt. The link is
 * honoured only together with it ({@link verifyEmailLink}), so a link opened in any browser but
 * the one that asked proves nothing. The binding is not a credential: without the emailed
 * token it does nothing, and the session still goes only to the holder of the attempt's secret.
 *
 * @param deps - All dependencies.
 * @param tenant - The environment the publishable key resolved to.
 * @param ref - The sign-in attempt and its secret.
 * @param input - The strategy, and the redirect URL for a link.
 * @param context - The requesting device.
 * @returns The attempt, still on `needs_first_factor`, now with `prepared`; and `linkBinding`
 *   for `email_link`.
 * @throws AuthError `flow.not_found`, `request.origin_not_allowed`, `flow.invalid_step` (not on
 *   `needs_first_factor`, or a strategy it was not offered), `auth.method_disabled` or
 *   `request.redirect_not_allowed`.
 * @throws InvalidEmailError when the attempt's identifier is not an email address.
 * @throws RateLimitError when the address was emailed too recently or too often.
 */
export async function prepareFirstFactor(
  deps: Deps,
  tenant: Tenant,
  ref: AttemptRef,
  input: FirstFactorPrepareRequest,
  context: ClientContext
): Promise<FlowResult> {
  const { attempt, state } = await load(deps, tenant, 'sign_in', ref, context)
  const { strategy } = input
  assertAccepts(
    attempt.kind,
    attempt.status,
    { type: 'first_factor_verified', strategy },
    state.strategies ?? []
  )
  await Settings.requireMethod(deps, tenant, Factors.EMAIL_FACTOR_METHODS[strategy])
  const redirectUrl =
    strategy === 'email_link'
      ? await Settings.requireRedirectUrl(deps, tenant, input.redirectUrl)
      : undefined
  const parsed = parseEmail(attempt.identifier)
  if (!parsed) {
    throw new InvalidEmailError()
  }

  const user = await deps.users.findByEmail(tenant.environmentId, attempt.identifier)
  // Made for every address, so the response has the same shape whether or not it has an account.
  const linkBinding =
    redirectUrl === undefined ? undefined : `${LINK_BINDING_PREFIX}${randomToken()}`
  await Verification.issue(deps, tenant, {
    purpose: 'sign_in',
    destination: parsed.email,
    flowAttemptId: attempt.id,
    userId: user?.id,
    onAllowed: () => chargeEnvironment(deps, tenant, 'emailSignIn'),
    ...(user
      ? redirectUrl !== undefined && {
          // In the fragment, never the query: a fragment is not sent to the app's server, to a
          // proxy or in `Referer`.
          linkUrl: (token: string) =>
            `${redirectUrl}#${EMAIL_LINK_TOKEN_PARAM}=${encodeURIComponent(token)}` +
            `&${EMAIL_LINK_ATTEMPT_PARAM}=${attempt.id}`,
        }
      : { deliver: ({ to }) => sendNoAccountSignInNotice(deps, tenant, to) }),
  })

  const { linkBindingHash: _old, linkVerified: _proven, ...kept } = state
  const pending: State = {
    ...kept,
    prepared: strategy,
    ...(linkBinding !== undefined && { linkBindingHash: sha256Hex(linkBinding) }),
  }
  const moved = await deps.flowAttempts.transition(
    tenant.environmentId,
    attempt.id,
    attempt.status,
    { status: attempt.status, state: pending },
    deps.clock.now()
  )
  if (!moved) {
    throw new AuthError('flow.invalid_step')
  }
  return {
    attempt: toAttempt(attempt, stepFor(attempt, pending), undefined, linkBinding),
    client: state.client,
  }
}

/**
 * Prove a sign-in's email first factor.
 *
 * **`email_code`**: checks the emailed code. A wrong one is `verification.invalid_code`; the
 * code allows five guesses, and every try also counts against the per-identifier lockout
 * (`CREDENTIAL_LOCKOUT`, under the same key as password sign-in, so guessing codes and guessing
 * passwords share one budget). A code issued for another purpose (verifying an address,
 * resetting a password) is never accepted here. The right code of a decoy attempt, for an
 * address with no account, answers like a wrong one.
 *
 * **`email_link`**: asks whether the emailed link has been opened in the browser that asked for
 * it ({@link verifyEmailLink}). Until then it answers the unchanged step: nothing is counted as
 * a guess and nothing is charged, so the waiting client can simply ask again, and the answer is
 * the same for an address with no account, whose link never arrives.
 *
 * Either way the session goes to the caller, who holds the attempt's secret. Of two requests
 * that arrive together once the link was accepted (two tabs, a retry), exactly one creates the
 * session; the other answers `flow.invalid_step`, and any later one `flow.not_found`.
 *
 * @param deps - All dependencies.
 * @param tenant - The environment the publishable key resolved to.
 * @param ref - The sign-in attempt and its secret.
 * @param input - The strategy, and the code for `email_code`.
 * @param context - The requesting device.
 * @returns `complete` with tokens; `needs_second_factor`, without tokens, for a user who has a
 *   second factor; or, for a link not opened yet, the attempt still on `needs_first_factor`.
 * @throws AuthError `flow.not_found`, `request.origin_not_allowed`, `flow.invalid_step`,
 *   `auth.method_disabled`, a `verification.*` code or `auth.user_banned`.
 * @throws RateLimitError while the identifier is locked out after repeated failures.
 */
export async function attemptFirstFactor(
  deps: Deps,
  tenant: Tenant,
  ref: AttemptRef,
  input: FirstFactorAttemptRequest,
  context: ClientContext
): Promise<FlowResult> {
  const { attempt, state } = await load(deps, tenant, 'sign_in', ref, context)
  assertAccepts(
    attempt.kind,
    attempt.status,
    { type: 'first_factor_verified', strategy: input.strategy },
    state.strategies ?? []
  )
  await Settings.requireMethod(deps, tenant, Factors.EMAIL_FACTOR_METHODS[input.strategy])

  if (input.strategy === 'email_link') {
    if (!state.linkVerified || !attempt.userId) {
      return { attempt: toAttempt(attempt, stepFor(attempt, state)), client: state.client }
    }
    await chargeEnvironment(deps, tenant, 'verify')
    const user = await deps.users.findById(tenant.environmentId, attempt.userId)
    if (!user || user.emailNormalized !== attempt.identifier) {
      // The account was deleted or moved to another address since the link was opened.
      throw new AuthError('flow.invalid_step')
    }
    // The link's token was spent when it was opened; the attempt's own compare-and-set (in
    // `finish`) is what lets only one request complete.
    return completeEmailFactor(deps, tenant, attempt, state, user, 'email_link', context, () =>
      Promise.resolve()
    )
  }

  // Counted as a failure up front and cleared on success, exactly as a password is.
  const lockKey = signInLockKey(tenant.environmentId, attempt.identifier)
  const lock = await deps.lockout.attempt(lockKey, CREDENTIAL_LOCKOUT, deps.clock.now())
  if (!lock.allowed) {
    throw new RateLimitError(lock.retryAfterMs)
  }
  await chargeEnvironment(deps, tenant, 'verify')
  const token = await Verification.verifyCode(deps, tenant, {
    purpose: 'sign_in',
    subject: { flowAttemptId: attempt.id },
    code: input.code,
    consume: false,
  })
  const user = token.userId ? await deps.users.findById(tenant.environmentId, token.userId) : null
  if (!user || user.emailNormalized !== attempt.identifier) {
    // Someone guessed the decoy code of a sign-in for an address with no account, or the
    // account was deleted or moved to another address meanwhile. Answer as if the guess was
    // wrong: a code proves control of the address it was sent to, not of an account.
    throw new AuthError('verification.invalid_code', { attemptsRemaining: 0 })
  }
  await deps.lockout.clear(lockKey)
  return completeEmailFactor(deps, tenant, attempt, state, user, 'email_code', context, () =>
    Verification.consume(deps, tenant, token.id)
  )
}

/**
 * Accept an emailed sign-in link, opened in the browser that asked for it.
 *
 * This is the one flow step that is **not** authorized by the attempt's secret: the page a link
 * leads to is a fresh page and does not have it. It is authorized instead by the link's token
 * (256 bits, single use, ten minutes, newest only, purpose `sign_in`, issued for exactly this
 * attempt) **together with** the binding the asking browser was given.
 *
 * The threat this answers: an attacker starts a sign-in for a victim's address, and the victim,
 * receiving a genuine email, clicks the link. If that click completed the attacker's waiting
 * attempt, the attacker would be signed in as the victim. The victim's browser never received
 * the attacker's binding, so here the click proves nothing:
 *
 * - No link, an unknown, used, replaced or expired one, one for another attempt or purpose, or
 *   an attempt that is gone: `verification.expired`, exactly like any dead link.
 * - A good link without the matching binding (another browser or device, or someone else's
 *   attempt): `verification.different_browser`, and **nothing is used up**. The link still
 *   works in the browser that asked, and so does the code in the same email.
 * - A good link with its binding: the token is spent (which also ends the code) and the attempt
 *   is marked as proven. **No session is created and no tokens are returned**: the client that
 *   holds the attempt's secret completes the sign-in with {@link attemptFirstFactor}.
 *
 * @param deps - All dependencies.
 * @param tenant - The environment the publishable key resolved to.
 * @param input - The link's token and attempt id, and this browser's binding (if it has one).
 * @param context - The requesting device.
 * @returns `verified`.
 * @throws AuthError `verification.expired`, `verification.different_browser`,
 *   `request.origin_not_allowed` or `auth.method_disabled`.
 */
export async function verifyEmailLink(
  deps: Deps,
  tenant: Tenant,
  input: EmailLinkRequest,
  context: Pick<ClientContext, 'originAllowed'>
): Promise<EmailLinkResult> {
  const attempt = await deps.flowAttempts.findById(tenant.environmentId, input.attemptId)
  const parsed = attempt ? StateSchema.safeParse(attempt.state) : null
  const state = parsed?.success ? parsed.data : null
  // Compared in constant time, and compared even when there is nothing to compare with.
  const bound = timingSafeEqual(
    sha256Hex(input.binding ?? ''),
    state?.linkBindingHash ?? NO_SECRET_HASH
  )
  const token = await Verification.verifyLink(deps, tenant, {
    purpose: 'sign_in',
    linkToken: input.token,
    consume: false,
  })
  if (
    !attempt ||
    !state ||
    attempt.kind !== 'sign_in' ||
    attempt.status !== 'needs_first_factor' ||
    attempt.completedAt !== null ||
    attempt.expiresAt.getTime() <= deps.clock.now().getTime() ||
    token.flowAttemptId !== attempt.id ||
    token.userId === null ||
    !state.strategies?.includes('email_link')
  ) {
    throw new AuthError('verification.expired')
  }
  if (!bound || input.binding === undefined || state.linkBindingHash === undefined) {
    throw new AuthError('verification.different_browser')
  }
  requireAllowedOrigin(state.client, context)
  await Settings.requireMethod(deps, tenant, 'emailLink')
  await chargeEnvironment(deps, tenant, 'verify')
  // Single use: of two tabs opening the same link, only the first gets past this.
  await Verification.consume(deps, tenant, token.id)
  const moved = await deps.flowAttempts.transition(
    tenant.environmentId,
    attempt.id,
    attempt.status,
    { status: attempt.status, userId: token.userId, state: { ...state, linkVerified: true } },
    deps.clock.now()
  )
  if (!moved) {
    // The attempt completed or expired between the read and the write.
    throw new AuthError('verification.expired')
  }
  return { status: 'verified' }
}

/** The parts of an OAuth `state`: which environment and attempt it belongs to. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * The fragment an OAuth callback sends the app's page.
 *
 * In the fragment, never the query: a fragment is not sent to the app's server, to a proxy or
 * in `Referer`.
 */
function oauthRedirect(redirectUrl: string, attemptId: string, name: string, value: string) {
  return `${redirectUrl}#${name}=${encodeURIComponent(value)}&${EMAIL_LINK_ATTEMPT_PARAM}=${attemptId}`
}

/** What starting an OAuth attempt answers, before a router shapes it. */
export interface OAuthStartResult {
  attempt: FlowAttempt
  authorizationUrl: string
  /** Returned once. Only its SHA-256 is kept. */
  binding: string
}

/**
 * Start "continue with a provider" (ADR 0026): a sign-in that creates the account when the
 * provider's verified address has none, or (with `link`) connecting a provider account to the
 * signed-in user.
 *
 * Nothing is looked up about any user. The answer depends on the environment alone: the
 * provider must be enabled (`auth.method_disabled` otherwise) and `redirectUrl` must be,
 * exactly, one of its `urls.allowedRedirectUrls` (`request.redirect_not_allowed`).
 *
 * Kept on the attempt, server-side: the hash of `state` (random, single use: the only link
 * between the provider's answer and this attempt), the PKCE verifier and the OIDC nonce. The
 * client receives the provider's URL, which carries `state`, the PKCE challenge and the nonce
 * as the standard parameters, and a **binding**: 256 random bits, returned once, whose hash is
 * kept. The provider's answer is honoured only together with it ({@link exchangeOAuth}), so a
 * callback fed to another browser completes nothing there (login CSRF).
 *
 * The attempt is a sign-in on `needs_first_factor` offering only the provider's strategy: no
 * password or emailed code is accepted on it.
 *
 * @param deps - All dependencies.
 * @param tenant - The environment the publishable key resolved to.
 * @param input - The provider and the app's page to return to.
 * @param context - The requesting device.
 * @param link - For connecting from a profile: the signed-in user.
 * @returns The attempt (with its secret), the provider's URL and the binding.
 * @throws AuthError `request.origin_not_allowed`, `auth.method_disabled` or
 *   `request.redirect_not_allowed`.
 * @throws RateLimitError when the environment's ceiling is reached.
 */
export async function startOAuth(
  deps: Deps,
  tenant: Tenant,
  input: OAuthStartRequest,
  context: ClientContext,
  link?: { userId: string }
): Promise<OAuthStartResult & { client: SessionClient }> {
  requireAllowedOrigin(context.client, context)
  const { provider } = input
  const credentials = await OAuth.credentials(deps, tenant, provider)
  const redirectUrl = await Settings.requireRedirectUrl(deps, tenant, input.redirectUrl)
  await chargeEnvironment(deps, tenant, 'oauth')

  const id = deps.ids.next()
  // The callback has no API key to say which environment it is for, so the state names the
  // environment and the attempt; the random part is what makes it unguessable.
  const oauthState = `${tenant.environmentId}.${id}.${randomToken()}`
  const codeVerifier = randomToken()
  const nonce = randomToken()
  const binding = `${OAUTH_BINDING_PREFIX}${randomToken()}`
  const state: State = {
    client: context.client,
    strategies: [OAuth.strategyOf(provider)],
    oauthPhase: 'started',
    oauth: {
      provider,
      intent: link ? 'link' : 'sign_in',
      redirectUrl,
      stateHash: sha256Hex(oauthState),
      codeVerifier,
      nonce,
      bindingHash: sha256Hex(binding),
      ...(link && { linkUserId: link.userId }),
    },
  }
  const { attempt, secret } = await start(deps, tenant, {
    id,
    kind: 'sign_in',
    status: 'needs_first_factor',
    // An OAuth attempt has no identifier: who it is for is what the provider will say.
    identifier: `oauth:${provider}`,
    state,
  })
  const authorizationUrl = deps.oauth[provider].authorizationUrl(credentials, {
    state: oauthState,
    codeVerifier,
    nonce,
    redirectUri: OAuth.callbackUrl(deps.config, provider),
  })
  return {
    attempt: toAttempt(attempt, stepFor(attempt, state), secret),
    authorizationUrl,
    binding,
    client: state.client,
  }
}

/**
 * Start connecting a provider account to the signed-in user (ADR 0026).
 *
 * The same attempt as a sign-in's, bound to the user who asked: the callback and
 * {@link exchangeOAuthLink} then connect the identity to **that** user, whatever email the
 * provider reports. The attempt's secret is not returned: nothing is ever done with it.
 *
 * @param deps - All dependencies.
 * @param tenant - The environment.
 * @param userId - The signed-in user.
 * @param input - The provider and the app's page to return to.
 * @param context - The requesting device.
 * @returns The attempt's id and expiry, the provider's URL and the binding.
 * @throws AuthError as {@link startOAuth}.
 */
export async function startOAuthLink(
  deps: Deps,
  tenant: Tenant,
  userId: string,
  input: OAuthStartRequest,
  context: ClientContext
): Promise<IdentityLinkStart> {
  const started = await startOAuth(deps, tenant, input, context, { userId })
  return {
    attemptId: started.attempt.id,
    expiresAt: started.attempt.expiresAt,
    authorizationUrl: started.authorizationUrl,
    binding: started.binding,
  }
}

/** What the provider sent to the callback: a query for most, a form post for Apple. */
export interface OAuthCallbackInput {
  state?: string
  code?: string
  /** An OAuth error code (`access_denied`, …). Only compared with known values, never shown. */
  error?: string
  /** Apple's unsigned `user` field. */
  user?: string
}

/** Where the callback sends the browser: back to the app, or to a static page. */
export type OAuthCallbackResult = { redirectTo: string } | { invalid: true }

/**
 * Handle a provider's answer (`GET`/`POST /v1/oauth/callback/:provider`).
 *
 * This request is cross-site by nature and carries no API key and no cookie. **`state` is the
 * only thing that links it to an attempt**, and it is single use: it is consumed (a
 * compare-and-set on the attempt's phase) before the code is exchanged, so a replayed callback
 * finds nothing to do whether the first one succeeded or not.
 *
 * It sets no cookie, creates no session and returns no tokens. It exchanges the code with the
 * verifier the attempt stored, has the adapter verify the provider's answer (for OIDC: the ID
 * token's signature, issuer, audience, expiry and nonce), records **on the attempt** what the
 * provider vouched for, and sends the browser to the attempt's allow-listed `redirectUrl` with a
 * single-use, {@link OAUTH_TICKET_TTL} ticket in the URL **fragment**, or with a contract error
 * code there. Which account that is, and whether to create or connect one, is decided only when
 * the ticket is exchanged by the browser that holds the binding.
 *
 * Nothing the provider sent is ever reflected: the answer is a redirect to a URL the
 * environment allows, or (when the state matches no attempt, so there is no such URL) a static
 * page. Provider failures are logged by kind only and reach the app as one of
 * `oauth.access_denied`, `oauth.provider_error`, `oauth.state_invalid`, `auth.method_disabled`
 * or `rate_limited`.
 *
 * @param deps - All dependencies.
 * @param provider - The provider named in the callback's path.
 * @param input - What the provider sent.
 * @returns Where to send the browser.
 */
export async function oauthCallback(
  deps: Deps,
  provider: OAuthProvider,
  input: OAuthCallbackInput
): Promise<OAuthCallbackResult> {
  const [environmentId, attemptId, random] = (input.state ?? '').split('.')
  if (
    !environmentId ||
    !attemptId ||
    !random ||
    !UUID.test(environmentId) ||
    !UUID.test(attemptId)
  ) {
    return { invalid: true }
  }
  const attempt = await deps.flowAttempts.findById(environmentId, attemptId)
  const parsed = attempt ? StateSchema.safeParse(attempt.state) : null
  const state = parsed?.success ? parsed.data : null
  // Compared in constant time, and compared even when there is nothing to compare with.
  const known = timingSafeEqual(
    sha256Hex(input.state ?? ''),
    state?.oauth?.stateHash ?? NO_SECRET_HASH
  )
  if (!attempt || !state?.oauth || !known || state.oauth.provider !== provider) {
    return { invalid: true }
  }
  const { oauth } = state
  const tenant: Tenant = { projectId: attempt.projectId, environmentId, apiKeyId: '' }
  try {
    // The URL was allowed when the attempt started; the allow-list may have changed since.
    await Settings.requireRedirectUrl(deps, tenant, oauth.redirectUrl)
  } catch {
    return { invalid: true }
  }
  const failed = (code: string): OAuthCallbackResult => ({
    redirectTo: oauthRedirect(oauth.redirectUrl, attempt.id, OAUTH_ERROR_PARAM, code),
  })

  // The state is used up here, whatever happens next.
  const returned: State = { ...state, oauthPhase: 'returned' }
  const consumed = await deps.flowAttempts.transition(
    environmentId,
    attempt.id,
    'needs_first_factor',
    { status: 'needs_first_factor', state: returned },
    deps.clock.now(),
    { key: 'oauthPhase', value: 'started' }
  )
  if (!consumed) {
    // Replayed, expired or already completed.
    return failed('oauth.state_invalid')
  }
  if (input.error !== undefined) {
    return failed(input.error === 'access_denied' ? 'oauth.access_denied' : 'oauth.provider_error')
  }
  if (!input.code || !oauth.codeVerifier || !oauth.nonce) {
    return failed('oauth.provider_error')
  }
  try {
    await chargeEnvironment(deps, tenant, 'oauth')
  } catch {
    // A JSON error would strand the browser on the API: the app's page shows this one.
    return failed('rate_limited')
  }

  let profile: NonNullable<NonNullable<State['oauth']>['profile']>
  try {
    const credentials = await OAuth.credentials(deps, tenant, provider)
    const answered = await deps.oauth[provider].exchange(credentials, {
      code: input.code,
      codeVerifier: oauth.codeVerifier,
      nonce: oauth.nonce,
      redirectUri: OAuth.callbackUrl(deps.config, provider),
      ...(input.user !== undefined && { user: input.user }),
    })
    profile = {
      subject: answered.subject,
      email: answered.email,
      emailVerified: answered.emailVerified,
      ...(answered.givenName !== undefined && { givenName: answered.givenName }),
      ...(answered.familyName !== undefined && { familyName: answered.familyName }),
    }
  } catch (error) {
    if (error instanceof AuthError) {
      // The provider was switched off after the attempt started.
      return failed(error.code)
    }
    // The kind of failure only: a provider's response can hold a token or the user's address.
    logger.warn('OAuth code exchange failed', {
      environmentId,
      provider,
      failure: error instanceof OAuthProviderError ? error.failure : 'unexpected',
    })
    return failed('oauth.provider_error')
  }

  const ticket = `${OAUTH_TICKET_PREFIX}${randomToken()}`
  // The verifier and the nonce have done their job and are not kept.
  const { codeVerifier: _verifier, nonce: _nonce, ...kept } = oauth
  const proven: State = {
    ...state,
    oauthPhase: 'proven',
    oauth: {
      ...kept,
      profile,
      ticketHash: sha256Hex(ticket),
      ticketExpiresAt: deps.clock.now().getTime() + durationToMs(OAUTH_TICKET_TTL),
    },
  }
  const stored = await deps.flowAttempts.transition(
    environmentId,
    attempt.id,
    'needs_first_factor',
    { status: 'needs_first_factor', state: proven },
    deps.clock.now(),
    { key: 'oauthPhase', value: 'returned' }
  )
  if (!stored) {
    // The attempt expired while the provider was being asked.
    return failed('oauth.state_invalid')
  }
  return { redirectTo: oauthRedirect(oauth.redirectUrl, attempt.id, OAUTH_TICKET_PARAM, ticket) }
}

/** An OAuth attempt whose ticket and binding were both accepted, and is now used up. */
interface RedeemedTicket {
  attempt: FlowAttemptRecord
  /** The attempt's state without anything of the OAuth round trip. */
  state: State
  provider: OAuthProvider
  profile: NonNullable<NonNullable<State['oauth']>['profile']>
  linkUserId: string | undefined
  /** The attempt's new secret: the one it was started with was lost in the navigation. */
  secret: string
}

/**
 * Accept an OAuth ticket from the browser that started the attempt, and use it up.
 *
 * Authorized by the ticket (256 bits, single use, {@link OAUTH_TICKET_TTL}) **together with**
 * the binding the starting browser was given, not by the attempt's secret: the page the
 * provider's round trip ends on is a fresh page and no longer has it.
 *
 * - An unknown, used or expired ticket, one for another attempt, or an attempt of the other
 *   intent: `oauth.ticket_invalid`.
 * - A good ticket **without the matching binding**: `oauth.different_browser`, and nothing is
 *   used up or completed. This is the login-CSRF case: an attacker signs in to *their own*
 *   provider account, stops before the app's page, and gets a victim's browser to open that
 *   page with the attacker's ticket. The victim's browser was never given the attacker's
 *   binding, so it cannot be signed in to the attacker's account.
 * - Both good: the ticket is spent as a compare-and-set, so of two requests exactly one gets
 *   past it, and the attempt's secret is **rotated**: the secret it was started with stops
 *   working and the caller is handed a fresh one for the steps that may follow.
 */
async function redeemOAuthTicket(
  deps: Deps,
  tenant: Tenant,
  input: OAuthExchangeRequest,
  intent: 'sign_in' | 'link',
  context: Pick<ClientContext, 'originAllowed'>
): Promise<RedeemedTicket> {
  const attempt = await deps.flowAttempts.findById(tenant.environmentId, input.attemptId)
  const parsed = attempt ? StateSchema.safeParse(attempt.state) : null
  const state = parsed?.success ? parsed.data : null
  const oauth = state?.oauth
  // Both compared in constant time, and compared even when there is nothing to compare with.
  const ticketed = timingSafeEqual(sha256Hex(input.ticket), oauth?.ticketHash ?? NO_SECRET_HASH)
  const bound = timingSafeEqual(
    sha256Hex(input.binding ?? ''),
    oauth?.bindingHash ?? NO_SECRET_HASH
  )
  const now = deps.clock.now()
  if (
    !attempt ||
    !state ||
    !oauth?.profile ||
    !ticketed ||
    attempt.kind !== 'sign_in' ||
    attempt.status !== 'needs_first_factor' ||
    attempt.completedAt !== null ||
    attempt.expiresAt.getTime() <= now.getTime() ||
    state.oauthPhase !== 'proven' ||
    oauth.intent !== intent ||
    (oauth.ticketExpiresAt ?? 0) <= now.getTime()
  ) {
    throw new AuthError('oauth.ticket_invalid')
  }
  if (!bound || input.binding === undefined) {
    throw new AuthError('oauth.different_browser')
  }
  requireAllowedOrigin(state.client, context)
  // A provider switched off while the user was away must not complete.
  await OAuth.credentials(deps, tenant, oauth.provider)
  await chargeEnvironment(deps, tenant, 'verify')

  const secret = `${ATTEMPT_SECRET_PREFIX}${randomToken()}`
  const { oauth: _oauth, oauthPhase: _phase, ...rest } = state
  const spent = await deps.flowAttempts.transition(
    tenant.environmentId,
    attempt.id,
    attempt.status,
    {
      status: attempt.status,
      // The profile leaves the attempt with the ticket: it is used in this request or never.
      state: { ...rest, oauthPhase: 'exchanged' },
      secretHash: sha256Hex(secret),
    },
    now,
    { key: 'oauthPhase', value: 'proven' }
  )
  if (!spent) {
    throw new AuthError('oauth.ticket_invalid')
  }
  return {
    attempt,
    state: { ...rest, oauthPhase: 'exchanged' },
    provider: oauth.provider,
    profile: oauth.profile,
    linkUserId: oauth.linkUserId,
    secret,
  }
}

/**
 * Exchange an OAuth ticket for the sign-in's next step (ADR 0026).
 *
 * With the ticket and the binding accepted ({@link redeemOAuthTicket}), the account is resolved
 * (`OAuth.resolveAccount`: the identity's user, a new user, an automatic link, or a refusal) and
 * the engine continues **exactly as after any first factor**: the ban check, `Factors.requiredFor`
 * (a user with a second factor gets `needs_second_factor` and no tokens), the environment's MFA
 * policy (`needs_factor_enrolment`), otherwise a session. The session records `fed` in `amr`.
 *
 * When the flow continues, the response carries the attempt's **new** secret as `attemptSecret`,
 * so the second-factor and enrolment steps work as for any other attempt.
 *
 * A refusal here (`oauth.account_exists`, `oauth.email_unverified`, …) ends the attempt: its
 * ticket is spent. The user starts again.
 *
 * @param deps - All dependencies.
 * @param tenant - The environment the publishable key resolved to.
 * @param input - The ticket and attempt id from the URL fragment, and this browser's binding.
 * @param context - The requesting device.
 * @returns `complete` with tokens; or `needs_second_factor` / `needs_factor_enrolment`, without
 *   tokens and with the new `attemptSecret`.
 * @throws AuthError `oauth.ticket_invalid`, `oauth.different_browser`,
 *   `request.origin_not_allowed`, `auth.method_disabled`, `oauth.email_missing`,
 *   `oauth.email_unverified`, `oauth.account_exists` or `auth.user_banned`.
 */
export async function exchangeOAuth(
  deps: Deps,
  tenant: Tenant,
  input: OAuthExchangeRequest,
  context: ClientContext
): Promise<FlowResult> {
  const redeemed = await redeemOAuthTicket(deps, tenant, input, 'sign_in', context)
  const { attempt, state, provider } = redeemed
  const { user, created } = await OAuth.resolveAccount(
    deps,
    tenant,
    provider,
    redeemed.profile,
    context
  )
  if (user.bannedAt !== null) {
    throw new AuthError('auth.user_banned')
  }
  // An account created a moment ago has no factor to prove, but the environment may require one.
  const required: Requirement = created
    ? { secondFactors: [], enrolmentRequired: await Factors.enrolmentRequired(deps, tenant, []) }
    : await requirement(deps, tenant, user.id)
  const next = nextStatus(
    attempt.kind,
    attempt.status,
    { type: 'first_factor_verified', strategy: OAuth.strategyOf(provider) },
    {
      strategies: state.strategies ?? [],
      // The provider's identity is the proof here, not the inbox: the attempt never detours
      // through `needs_email_verification`, and the address's own flag is left as it is.
      emailVerified: true,
      ...required,
    }
  )
  const result = await advance(
    deps,
    tenant,
    attempt,
    proven(state, 'fed'),
    user.id,
    next,
    required,
    context
  )
  return result.tokens
    ? result
    : { ...result, attempt: { ...result.attempt, attemptSecret: redeemed.secret } }
}

/**
 * Exchange an OAuth ticket of a **link** attempt: connect the provider account to the signed-in
 * user who started it (ADR 0026).
 *
 * The caller must be signed in as the user the attempt was started by; anyone else's ticket is
 * `oauth.ticket_invalid`. The ticket and the binding are checked as for a sign-in. No session is
 * created and the attempt ends here.
 *
 * @param deps - All dependencies.
 * @param tenant - The environment.
 * @param userId - The signed-in user.
 * @param input - The ticket and attempt id from the URL fragment, and this browser's binding.
 * @param context - The requesting device.
 * @param actor - The user with the request's origin, for the audit log.
 * @returns The connected identity.
 * @throws AuthError `oauth.ticket_invalid`, `oauth.different_browser`,
 *   `request.origin_not_allowed`, `auth.method_disabled`, `oauth.identity_in_use` or
 *   `oauth.already_linked`.
 */
export async function exchangeOAuthLink(
  deps: Deps,
  tenant: Tenant,
  userId: string,
  input: OAuthExchangeRequest,
  context: ClientContext,
  actor: Actor
): Promise<Identity> {
  const peek = await deps.flowAttempts.findById(tenant.environmentId, input.attemptId)
  const owner = StateSchema.safeParse(peek?.state).data?.oauth?.linkUserId
  if (owner !== undefined && owner !== userId) {
    // Another user's link attempt: answered like a ticket that does not exist, and left alone.
    throw new AuthError('oauth.ticket_invalid')
  }
  const redeemed = await redeemOAuthTicket(deps, tenant, input, 'link', context)
  if (redeemed.linkUserId !== userId) {
    throw new AuthError('oauth.ticket_invalid')
  }
  return OAuth.link(deps, tenant, userId, redeemed.provider, redeemed.profile, actor)
}

/**
 * Submit the emailed code for an attempt waiting on `needs_email_verification`.
 *
 * For a sign-up this creates the account (now that the address is proven) and signs the user
 * in. For a sign-in it marks the user's email verified and completes the sign-in, unless the
 * user has a second factor: then the attempt moves to `needs_second_factor`, without tokens.
 *
 * @param deps - All dependencies.
 * @param tenant - The environment the publishable key resolved to.
 * @param kind - Which flow the route belongs to; an attempt of the other kind is not found.
 * @param ref - The attempt and its secret.
 * @param code - The 6-digit code.
 * @param context - The requesting device.
 * @returns `complete` with tokens, or `needs_second_factor` without.
 * @throws AuthError `flow.not_found`, `flow.invalid_step`, `request.origin_not_allowed`,
 *   `auth.method_disabled`, a `verification.*` code or `auth.user_banned`.
 */
export async function verifyEmail(
  deps: Deps,
  tenant: Tenant,
  kind: FlowKind,
  ref: AttemptRef,
  code: string,
  context: ClientContext
): Promise<FlowResult> {
  const { attempt, state } = await load(deps, tenant, kind, ref, context)
  const event = { type: 'email_verified' } as const
  // Throws `flow.invalid_step` unless the attempt is waiting on email verification.
  assertAccepts(attempt.kind, attempt.status, event)
  // A sign-in reaches this step only after a password (an email factor verifies the address
  // itself), so its switch is the password's.
  await requireSignUpMethod(deps, tenant, attempt.kind === 'sign_up' ? state : {})
  await chargeEnvironment(deps, tenant, 'verify')

  await Verification.verifyCode(deps, tenant, {
    purpose: 'email_verification',
    subject: { flowAttemptId: attempt.id },
    code,
  })
  const now = deps.clock.now()

  if (attempt.kind === 'sign_in') {
    const user = attempt.userId
      ? await deps.users.findById(tenant.environmentId, attempt.userId)
      : null
    if (!user) {
      throw new AuthError('flow.invalid_step')
    }
    if (user.bannedAt !== null) {
      throw new AuthError('auth.user_banned')
    }
    const required = await requirement(deps, tenant, user.id)
    await deps.users.markEmailVerified(
      tenant.environmentId,
      user.id,
      now,
      Audit.entry(deps, tenant, {
        type: 'user.email_verified',
        actor: { type: 'user', id: user.id, ...context },
        target: { type: 'user', id: user.id },
      })
    )
    const next = nextStatus(attempt.kind, attempt.status, event, {
      strategies: state.strategies ?? [],
      emailVerified: true,
      ...required,
    })
    return advance(deps, tenant, attempt, proven(state, 'email'), user.id, next, required, context)
  }

  if (state.decoy || (!state.passwordHash && !state.passwordless)) {
    // Someone guessed the decoy code of a sign-up for an address that already has an account.
    // Answer as if the guess was wrong: the attempt can never create or enter an account.
    throw new AuthError('verification.invalid_code', { attemptsRemaining: 0 })
  }
  const userId = deps.ids.next()
  const created = await deps.users.create(
    {
      id: userId,
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      email: state.email ?? attempt.identifier,
      emailNormalized: attempt.identifier,
      emailVerifiedAt: now,
      firstName: state.firstName ?? null,
      lastName: state.lastName ?? null,
      createdAt: now,
      identityId: deps.ids.next(),
      credentialId: deps.ids.next(),
      passwordHash: state.passwordHash ?? null,
    },
    Audit.entry(deps, tenant, {
      type: 'user.created',
      // They created the account themselves, so the new user is the actor.
      actor: { type: 'user', id: userId, ...context },
      target: { type: 'user', id: userId },
      data: {
        method: 'sign_up',
        emailVerified: true,
        ...(!state.passwordHash && { passwordless: true }),
      },
    })
  )
  if (!created) {
    // Another sign-up for the same address was verified first.
    throw new AuthError('flow.invalid_step')
  }
  // The account is seconds old: it has no factor to prove, but the environment may require one.
  const required: Requirement = {
    secondFactors: [],
    enrolmentRequired: await Factors.enrolmentRequired(deps, tenant, []),
  }
  const next = nextStatus(attempt.kind, attempt.status, event, {
    strategies: [],
    emailVerified: true,
    ...required,
  })
  return advance(deps, tenant, attempt, proven(state, 'email'), userId, next, required, context)
}

/**
 * Start a password reset: email a 6-digit code to the address.
 *
 * The response is the same whether or not the address has an account (no enumeration). An
 * address without one is emailed a notice instead of a code, and the attempt is a decoy holding
 * a code nobody knows, so guesses, resends and send limits behave identically and it can never
 * complete. A banned user is sent a code like anyone else and learns of the ban only after
 * proving they own the address.
 *
 * @param deps - All dependencies.
 * @param tenant - The environment the publishable key resolved to.
 * @param input - The email address.
 * @param context - The requesting device.
 * @returns The attempt, waiting on `needs_new_password`.
 * @throws InvalidEmailError when the address is malformed.
 * @throws AuthError `auth.method_disabled` when the environment has switched passwords off, or
 *   `request.origin_not_allowed` for a browser attempt from an origin the environment does not
 *   allow.
 * @throws RateLimitError when the address was emailed too recently or too often.
 */
export async function startPasswordReset(
  deps: Deps,
  tenant: Tenant,
  input: PasswordResetStartRequest,
  context: ClientContext
): Promise<FlowResult> {
  requireAllowedOrigin(context.client, context)
  const parsed = parseEmail(input.email)
  if (!parsed) {
    throw new InvalidEmailError()
  }
  const { email, normalized: identifier } = parsed
  await requirePasswordMethod(deps, tenant)
  await chargeEnvironment(deps, tenant, 'passwordReset')
  const user = await deps.users.findByEmail(tenant.environmentId, identifier)
  const state: State = { client: context.client, email, ...(!user && { decoy: true }) }
  const { attempt, secret } = await start(deps, tenant, {
    kind: 'password_reset',
    status: 'needs_new_password',
    identifier,
    state,
    ...(user && { userId: user.id }),
  })
  try {
    await issueCode(deps, tenant, attempt, state, { userId: user?.id })
  } catch (error) {
    // No email went out, so the attempt can never be completed.
    await deps.flowAttempts.delete(tenant.environmentId, attempt.id)
    throw error
  }
  return { attempt: toAttempt(attempt, stepFor(attempt, state), secret), client: state.client }
}

/**
 * Finish a password reset: check the emailed code, store the new password and sign the user in.
 *
 * The code and the password arrive together, so no request ever leaves an attempt that could
 * set a password without the code. The code is only spent once the new password has passed the
 * policy: a rejected password costs one of the code's guesses but the user can try another.
 * Every existing session of the user ends (before the password is stored, so a failure midway
 * never leaves a new password with old sessions alive), the sign-in lockout for the address is
 * cleared, and the email counts as verified, since the code proved control of it. If a step
 * fails after the code is spent, the user starts a new reset.
 *
 * A user with a second factor is **not** signed in by the reset: once the password is stored
 * the attempt moves to `needs_second_factor` and yields no tokens until one is proven, so an
 * inbox alone never bypasses MFA. The stored password is not rolled back if the second factor
 * is never proven: the user did prove the inbox, and the second factor gates the session, not
 * the reset. The attempt cannot set a password again (its code is spent and it has left
 * `needs_new_password`). A user with no password gets their first one this way.
 *
 * @param deps - All dependencies.
 * @param tenant - The environment the publishable key resolved to.
 * @param ref - The password-reset attempt and its secret.
 * @param input - The emailed code and the new password.
 * @param context - The requesting device.
 * @returns `complete` with tokens, or `needs_second_factor` without.
 * @throws AuthError `flow.not_found`, `flow.invalid_step`, `request.origin_not_allowed`,
 *   `auth.method_disabled`, a `verification.*` code or `auth.user_banned`.
 * @throws ServiceException a `password.*` code when the new password fails the policy.
 */
export async function resetPassword(
  deps: Deps,
  tenant: Tenant,
  ref: AttemptRef,
  input: PasswordResetRequest,
  context: ClientContext
): Promise<FlowResult> {
  const { attempt, state } = await load(deps, tenant, 'password_reset', ref, context)
  const event = { type: 'password_reset' } as const
  // Throws `flow.invalid_step` unless the attempt is waiting on the new password.
  assertAccepts(attempt.kind, attempt.status, event)
  await requirePasswordMethod(deps, tenant)
  await chargeEnvironment(deps, tenant, 'verify')

  const token = await Verification.verifyCode(deps, tenant, {
    purpose: 'password_reset',
    subject: { flowAttemptId: attempt.id },
    code: input.code,
    consume: false,
  })
  const user =
    !state.decoy && attempt.userId
      ? await deps.users.findById(tenant.environmentId, attempt.userId)
      : null
  if (!user || user.emailNormalized !== attempt.identifier) {
    // Someone guessed the decoy code of a reset for an address with no account, or the account
    // was deleted or moved to another address meanwhile: a code proves control of the address
    // it was sent to, not of the account. Answer as if the guess was wrong.
    throw new AuthError('verification.invalid_code', { attemptsRemaining: 0 })
  }
  if (user.bannedAt !== null) {
    throw new AuthError('auth.user_banned')
  }
  // Asked before anything is spent or stored, so a failure here leaves the reset retryable.
  const required = await requirement(deps, tenant, user.id)
  const next = nextStatus(attempt.kind, attempt.status, event, {
    strategies: [],
    // The code proves control of the address.
    emailVerified: true,
    ...required,
  })
  const actor = { type: 'user', id: user.id, ...cleanOrigin(context) } as const
  await Users.resetPassword(deps, tenant, user.id, input.password, actor, () =>
    Verification.consume(deps, tenant, token.id)
  )
  if (user.emailVerifiedAt === null) {
    try {
      await deps.users.markEmailVerified(
        tenant.environmentId,
        user.id,
        deps.clock.now(),
        Audit.entry(deps, tenant, {
          type: 'user.email_verified',
          actor,
          target: { type: 'user', id: user.id },
        })
      )
    } catch (error) {
      // The password is stored and the code is spent, so failing here would strand the user.
      // Their next sign-in asks them to verify the address instead.
      logger.warn('could not mark the email verified after a password reset', {
        environmentId: tenant.environmentId,
        err: error instanceof Error ? error.name : 'unknown',
      })
    }
  }
  // What the reset proved is the emailed code: the inbox.
  return advance(deps, tenant, attempt, proven(state, 'email'), user.id, next, required, context)
}

/**
 * Lockout key for second-factor guesses of one user in one environment: the one budget shared by
 * every place a TOTP or backup code is checked (`Mfa.secondFactorLockKey`).
 *
 * @param environmentId - The environment.
 * @param userId - The user the attempt belongs to.
 * @returns The key for `deps.lockout`.
 */
export function secondFactorLockKey(environmentId: string, userId: string): string {
  return Mfa.secondFactorLockKey(environmentId, userId)
}

/**
 * Submit a second factor for an attempt waiting on `needs_second_factor`, and sign the user in.
 *
 * **The entry point every second factor uses.** The engine owns everything around the proof:
 * the attempt's secret and origin, the step, that the method is one the attempt offered, the
 * per-user lockout (`CREDENTIAL_LOCKOUT`: counted first, cleared on success, so parallel guesses
 * cannot slip through), the environment's ceiling, the ban check and the compare-and-set that
 * lets exactly one request create the session. The proof itself is checked by the verifier
 * registered for its method (`Factors.verify`): an authenticator code (accepted once per time
 * step), a backup code (spent, recorded, and the owner told how many are left; the response
 * says so too, as `backupCodesRemaining`) or a passkey (an assertion for the challenge of
 * {@link secondFactorPasskeyOptions}, which is used up whatever the assertion turns out to be).
 *
 * @param deps - All dependencies.
 * @param tenant - The environment the publishable key resolved to.
 * @param kind - Which flow the route belongs to (`sign_in` or `password_reset`).
 * @param ref - The attempt and its secret.
 * @param proof - The method and what the client submitted for it.
 * @param context - The requesting device.
 * @returns `complete` with tokens.
 * @throws AuthError `flow.not_found`, `request.origin_not_allowed`, `flow.invalid_step` (wrong
 *   step, or a method the attempt did not offer), `mfa.invalid_code` for a proof that does not
 *   verify, or `auth.user_banned`.
 * @throws RateLimitError while the user is locked out after repeated wrong proofs.
 */
export async function submitSecondFactor(
  deps: Deps,
  tenant: Tenant,
  kind: FlowKind,
  ref: AttemptRef,
  proof: Factors.SecondFactorProof,
  context: ClientContext
): Promise<FlowResult> {
  const { attempt, state } = await load(deps, tenant, kind, ref, context)
  assertAccepts(attempt.kind, attempt.status, { type: 'second_factor_verified' })
  const userId = attempt.userId
  if (!userId || !state.secondFactors?.includes(proof.method)) {
    throw new AuthError('flow.invalid_step')
  }
  if (proof.method === 'passkey') {
    // Passkeys switched off since the attempt was offered one, or a foreign origin: refused
    // before the guess is counted or the challenge used.
    await Passkeys.relyingParty(deps, tenant, context.origin)
  }
  const lockKey = secondFactorLockKey(tenant.environmentId, userId)
  const lock = await deps.lockout.attempt(lockKey, CREDENTIAL_LOCKOUT, deps.clock.now())
  if (!lock.allowed) {
    throw new RateLimitError(lock.retryAfterMs)
  }
  await chargeEnvironment(deps, tenant, 'verify')

  const user = await deps.users.findById(tenant.environmentId, userId)
  const actor = { type: 'user', id: userId, ...cleanOrigin(context) } as const
  let current = state
  let checked = proof
  if (proof.method === 'passkey') {
    // The challenge is used up before the assertion is looked at: a response works once.
    const taken = await takePasskeyChallenge(deps, tenant, attempt, state, context)
    current = taken.state
    checked = {
      method: 'passkey',
      response: { credential: proof.response, expected: taken.expected },
    }
    if (!taken.expected) {
      throw new AuthError('mfa.invalid_code')
    }
  }
  const outcome = user ? await Factors.verify(deps, tenant, userId, checked, actor) : null
  if (!user || !outcome) {
    throw new AuthError('mfa.invalid_code')
  }
  await deps.lockout.clear(lockKey)
  if (user.bannedAt !== null) {
    throw new AuthError('auth.user_banned')
  }
  return finish(
    deps,
    tenant,
    attempt,
    proven(current, ...outcome.methods, 'mfa'),
    user.id,
    context,
    outcome.backupCodesRemaining === undefined
      ? {}
      : { backupCodesRemaining: outcome.backupCodesRemaining }
  )
}

/**
 * Put a fresh WebAuthn challenge on an attempt, replacing an unused one. The attempt's step
 * does not change.
 */
async function issuePasskeyChallenge(
  deps: Pick<Deps, 'flowAttempts' | 'clock'>,
  tenant: Tenant,
  attempt: FlowAttemptRecord,
  state: State
): Promise<string> {
  const now = deps.clock.now()
  const challenge = WebAuthn.newChallenge()
  const moved = await deps.flowAttempts.transition(
    tenant.environmentId,
    attempt.id,
    attempt.status,
    {
      status: attempt.status,
      state: {
        ...state,
        passkeyChallenge: challenge,
        passkeyChallengeExpiresAt: now.getTime() + PASSKEY_CHALLENGE_TTL_MS,
      },
    },
    now
  )
  if (!moved) {
    throw new AuthError('flow.invalid_step')
  }
  return challenge
}

/**
 * Take an attempt's WebAuthn challenge: a compare-and-set on its value, so of any number of
 * requests presenting an assertion for it exactly one gets it, and a replay finds none.
 *
 * The relying party is resolved first (`Passkeys.relyingParty`: passkeys still on, the
 * request's origin allowed and matching), so a step refused for that uses nothing up.
 *
 * @returns The attempt's state without the challenge, and what an assertion must match; no
 *   `expected` when the attempt has no challenge, it expired, or another request took it.
 */
async function takePasskeyChallenge(
  deps: Pick<Deps, 'flowAttempts' | 'clock' | 'environmentSettings' | 'config'>,
  tenant: Tenant,
  attempt: FlowAttemptRecord,
  state: State,
  context: Pick<ClientContext, 'origin'>
): Promise<{ state: State; expected?: WebAuthn.Expected }> {
  const rp = await Passkeys.relyingParty(deps, tenant, context.origin)
  const { passkeyChallenge: challenge, passkeyChallengeExpiresAt: expiresAt, ...rest } = state
  const now = deps.clock.now()
  if (challenge === undefined) {
    return { state: rest }
  }
  const taken = await deps.flowAttempts.transition(
    tenant.environmentId,
    attempt.id,
    attempt.status,
    { status: attempt.status, state: rest },
    now,
    { key: 'passkeyChallenge', value: challenge }
  )
  if (!taken || expiresAt === undefined || expiresAt <= now.getTime()) {
    return { state: rest }
  }
  return { state: rest, expected: { challenge, ...rp } }
}

/**
 * Start a sign-in by passkey: an attempt of its own, and the options for
 * `navigator.credentials.get()`.
 *
 * **Usernameless, and the same for every caller.** There is no identifier and the options
 * carry no `allowCredentials`: the authenticator finds the credential (it is discoverable), so
 * nothing here depends on, or says anything about, any account. The challenge is 32 random
 * bytes kept on the attempt, which binds it to the attempt's secret and, for a browser, its
 * origin; it is honoured once and for five minutes.
 *
 * @param deps - Attempt store, settings, config, rate limiter, ids and clock.
 * @param tenant - The environment the publishable key resolved to.
 * @param context - The requesting device, with the request's `Origin`.
 * @returns The attempt on `needs_first_factor` (`strategies: ['passkey']`) with its secret, and
 *   the request options.
 * @throws AuthError `auth.method_disabled` when passkeys are off, or
 *   `request.origin_not_allowed` for an origin the environment does not allow or that does not
 *   belong to its relying-party id.
 * @throws RateLimitError when the environment's ceiling is reached.
 */
export async function startPasskeySignIn(
  deps: Pick<
    Deps,
    'flowAttempts' | 'clock' | 'ids' | 'environmentSettings' | 'config' | 'rateLimiter'
  >,
  tenant: Tenant,
  context: ClientContext
): Promise<{ attempt: FlowAttempt; options: PasskeyRequestOptions; client: SessionClient }> {
  requireAllowedOrigin(context.client, context)
  const rp = await Passkeys.relyingParty(deps, tenant, context.origin)
  await chargeEnvironment(deps, tenant, 'verify')
  const challenge = WebAuthn.newChallenge()
  const state: State = {
    client: context.client,
    strategies: ['passkey'],
    passkeyChallenge: challenge,
    passkeyChallengeExpiresAt: deps.clock.now().getTime() + PASSKEY_CHALLENGE_TTL_MS,
  }
  const { attempt, secret } = await start(deps, tenant, {
    kind: 'sign_in',
    status: 'needs_first_factor',
    // No identifier: the passkey says who is signing in.
    identifier: '',
    state,
  })
  return {
    attempt: toAttempt(attempt, stepFor(attempt, state), secret),
    options: Passkeys.requestOptions(rp, challenge),
    client: state.client,
  }
}

/**
 * Prove a passkey for an attempt started with {@link startPasskeySignIn}, and sign the user in.
 *
 * **Every failure is the same `auth.invalid_credentials`**: an unknown credential, another
 * environment's, a wrong signature, a response made for another origin, relying party or
 * challenge, one without user verification, a used or expired challenge, a counter that went
 * backwards. The challenge is used up by the first response presented for it.
 *
 * **A passkey satisfies two-step verification on its own** (ADR 0027): it is something the
 * user has, unlocked by something they are or know, and it cannot be phished. So this step
 * never stops at `needs_second_factor` or `needs_factor_enrolment`, whatever the user has
 * enrolled and whatever the environment's policy; the session records `hwk` or `swk`, `user`
 * and `mfa`. A user whose email address is not verified is still asked to verify it.
 *
 * There is no identifier, so there is no per-identifier lockout: a credential id is not a
 * guessable secret and a signature cannot be guessed. Tries are bounded per IP by the route
 * and per environment here.
 *
 * @param deps - All dependencies.
 * @param tenant - The environment the publishable key resolved to.
 * @param ref - The attempt and its secret.
 * @param credential - The browser's assertion.
 * @param context - The requesting device, with the request's `Origin`.
 * @returns `complete` with tokens, or `needs_email_verification`.
 * @throws AuthError `flow.not_found`, `request.origin_not_allowed`, `flow.invalid_step`,
 *   `auth.method_disabled`, `auth.invalid_credentials` or `auth.user_banned`.
 * @throws RateLimitError when the environment's ceiling is reached.
 */
export async function submitPasskey(
  deps: Deps,
  tenant: Tenant,
  ref: AttemptRef,
  credential: PasskeyAssertionCredential,
  context: ClientContext
): Promise<FlowResult> {
  const { attempt, state } = await load(deps, tenant, 'sign_in', ref, context)
  const strategies = state.strategies ?? []
  const event = { type: 'first_factor_verified', strategy: 'passkey' } as const
  assertAccepts(attempt.kind, attempt.status, event, strategies)
  // Resolves the relying party (so: passkeys still on, origin allowed) before anything is used.
  const taken = await takePasskeyChallenge(deps, tenant, attempt, state, context)
  await chargeEnvironment(deps, tenant, 'verify')
  const { challenge, ...rp } = taken.expected ?? { challenge: null, rpId: '', origin: '' }
  const asserted =
    challenge === null
      ? null
      : await Passkeys.assert(deps, tenant, {
          credential,
          challenge,
          rp,
          actor: systemActor(context),
        })
  const user = asserted
    ? await deps.users.findById(tenant.environmentId, asserted.passkey.userId)
    : null
  if (!asserted || !user) {
    throw new AuthError('auth.invalid_credentials')
  }
  if (user.bannedAt !== null) {
    throw new AuthError('auth.user_banned')
  }
  // Nothing more is asked of a user who proved a passkey: no second factor, no enrolment.
  const required: Requirement = { secondFactors: [], enrolmentRequired: false }
  const next = nextStatus(attempt.kind, attempt.status, event, {
    strategies,
    emailVerified: user.emailVerifiedAt !== null,
    ...required,
  })
  const done = proven(taken.state, ...asserted.methods, 'mfa')
  if (next !== 'needs_email_verification') {
    return advance(deps, tenant, attempt, done, user.id, next, required, context)
  }
  const pending: State = { ...done, email: user.email }
  const waiting = { ...attempt, status: next, userId: user.id, identifier: user.emailNormalized }
  await issueCode(deps, tenant, waiting, pending, { userId: user.id })
  const moved = await deps.flowAttempts.transition(
    tenant.environmentId,
    attempt.id,
    attempt.status,
    { status: next, userId: user.id, state: pending },
    deps.clock.now()
  )
  if (!moved) {
    throw new AuthError('flow.invalid_step')
  }
  return { attempt: toAttempt(waiting, stepFor(waiting, pending)), client: state.client }
}

/**
 * The options for proving a passkey as the second factor of an attempt waiting on
 * `needs_second_factor` whose options include `passkey`.
 *
 * They name the user's own passkeys (`allowCredentials`): the caller holds the attempt's secret
 * and has already proven the first factor. The challenge is kept on the attempt and used up by
 * the next `second-factor` call with `method: 'passkey'`; asking again replaces it.
 *
 * @param deps - All dependencies.
 * @param tenant - The environment the publishable key resolved to.
 * @param kind - Which flow the route belongs to (`sign_in` or `password_reset`).
 * @param ref - The attempt and its secret.
 * @param context - The requesting device, with the request's `Origin`.
 * @returns `PublicKeyCredentialRequestOptionsJSON`.
 * @throws AuthError `flow.not_found`, `request.origin_not_allowed`, `auth.method_disabled`, or
 *   `flow.invalid_step` (wrong step, or an attempt that was not offered a passkey).
 */
export async function secondFactorPasskeyOptions(
  deps: Deps,
  tenant: Tenant,
  kind: FlowKind,
  ref: AttemptRef,
  context: ClientContext
): Promise<PasskeyRequestOptions> {
  const { attempt, state } = await load(deps, tenant, kind, ref, context)
  assertAccepts(attempt.kind, attempt.status, { type: 'second_factor_verified' })
  if (!attempt.userId || !state.secondFactors?.includes('passkey')) {
    throw new AuthError('flow.invalid_step')
  }
  const rp = await Passkeys.relyingParty(deps, tenant, context.origin)
  await chargeEnvironment(deps, tenant, 'verify')
  const owned = await deps.passkeys.listForUser(tenant.environmentId, attempt.userId)
  const challenge = await issuePasskeyChallenge(deps, tenant, attempt, state)
  return Passkeys.requestOptions(rp, challenge, owned)
}

/** The attempt of an enrolment step, and the user it belongs to. */
async function loadEnrolment(
  deps: Deps,
  tenant: Tenant,
  kind: FlowKind,
  ref: AttemptRef,
  context: ClientContext
): Promise<{ attempt: FlowAttemptRecord; state: State; userId: string }> {
  const { attempt, state } = await load(deps, tenant, kind, ref, context)
  // Throws `flow.invalid_step` unless the attempt is waiting on an enrolment.
  assertAccepts(attempt.kind, attempt.status, { type: 'factor_enrolled' })
  if (!attempt.userId) {
    throw new AuthError('flow.invalid_step')
  }
  await chargeEnvironment(deps, tenant, 'verify')
  return { attempt, state, userId: attempt.userId }
}

/**
 * Start enrolling an authenticator app inside an attempt waiting on `needs_factor_enrolment`
 * (the environment requires a second factor and the user has none).
 *
 * The same pending-factor mechanics as enrolling from a profile (`Mfa.startTotp`), authorized
 * by the attempt's secret instead of a session: the user has passed their first factor but has
 * no session yet. Calling it again replaces the pending secret.
 *
 * @param deps - All dependencies.
 * @param tenant - The environment the publishable key resolved to.
 * @param kind - Which flow the route belongs to.
 * @param ref - The attempt and its secret.
 * @param context - The requesting device.
 * @returns The secret and its `otpauth://` URI, once.
 * @throws AuthError `flow.not_found`, `request.origin_not_allowed`, `flow.invalid_step`,
 *   `mfa.not_available` or `mfa.already_enabled`.
 */
export async function startFactorEnrolment(
  deps: Deps,
  tenant: Tenant,
  kind: FlowKind,
  ref: AttemptRef,
  context: ClientContext
): Promise<TotpEnrolment> {
  const { userId } = await loadEnrolment(deps, tenant, kind, ref, context)
  return Mfa.startTotp(deps, tenant, userId)
}

/**
 * Confirm the authenticator enrolled inside an attempt, and complete the attempt.
 *
 * The code is checked exactly as from a profile (`Mfa.confirmTotp`: the user's second-factor
 * lockout, one confirmation wins, backup codes stored as keyed hashes, `user.mfa_enabled`
 * recorded, every existing session of the user ended, the owner emailed). Then the attempt
 * completes: the response carries the session **and the ten backup codes, once**.
 *
 * **The factor and the session stand or fall together.** If the attempt cannot complete after
 * the factor was confirmed (it expired in that instant, or the session could not be created),
 * the response that would have carried the backup codes is lost, so the enrolment is undone:
 * the factor and its codes are removed again (recorded as `user.mfa_disabled`, `method:
 * 'enrolment_incomplete'`) and the user enrols afresh at their next sign-in. Nobody is left
 * with a second factor whose backup codes they never saw. The owner is told the factor is on
 * only once the attempt has completed.
 *
 * @param deps - All dependencies.
 * @param tenant - The environment the publishable key resolved to.
 * @param kind - Which flow the route belongs to.
 * @param ref - The attempt and its secret.
 * @param code - The 6-digit code the app shows.
 * @param context - The requesting device.
 * @returns `complete` with tokens and `backupCodes`.
 * @throws AuthError `flow.not_found`, `request.origin_not_allowed`, `flow.invalid_step`,
 *   `mfa.enrolment_expired`, `mfa.already_enabled`, `mfa.invalid_code` or `auth.user_banned`.
 * @throws RateLimitError while the user is locked out after repeated wrong codes.
 */
export async function confirmFactorEnrolment(
  deps: Deps,
  tenant: Tenant,
  kind: FlowKind,
  ref: AttemptRef,
  code: string,
  context: ClientContext
): Promise<FlowResult> {
  const { attempt, state, userId } = await loadEnrolment(deps, tenant, kind, ref, context)
  const user = await deps.users.findById(tenant.environmentId, userId)
  if (!user) {
    throw new AuthError('flow.invalid_step')
  }
  if (user.bannedAt !== null) {
    throw new AuthError('auth.user_banned')
  }
  const actor = { type: 'user', id: userId, ...cleanOrigin(context) } as const
  const { codes, factorId } = await Mfa.confirmTotp(deps, tenant, { userId }, code, actor, {
    notify: false,
  })
  let result: FlowResult
  try {
    result = await finish(deps, tenant, attempt, proven(state, 'otp', 'mfa'), userId, context, {
      backupCodes: codes,
    })
  } catch (error) {
    try {
      await deps.factors.removeForUser(
        tenant.environmentId,
        userId,
        Audit.entry(deps, tenant, {
          type: 'user.mfa_disabled',
          actor: systemActor(context),
          target: { type: 'user', id: userId },
          data: { method: 'enrolment_incomplete' },
        }),
        // Only the factor this request confirmed: if the user was reset and enrolled again
        // meanwhile, that factor is not this request's to remove.
        factorId
      )
    } catch (undo) {
      // Both failed: the factor is on and its codes were never shown. The user signs in with
      // the authenticator and makes new codes, or an administrator resets them.
      logger.warn('could not undo an enrolment whose attempt did not complete', {
        environmentId: tenant.environmentId,
        err: undo instanceof Error ? undo.name : 'unknown',
      })
    }
    throw error
  }
  Notices.mfaChanged(deps, tenant, user, { change: 'enabled', at: deps.clock.now() })
  return result
}

/**
 * Send a fresh code for an attempt waiting on an emailed code (`needs_email_verification`, or
 * `needs_new_password` for a password reset).
 *
 * Subject to the same per-address send limits as the first email. A decoy attempt resends its
 * notice, so resending cannot be used to tell which addresses have accounts either.
 *
 * @param deps - All dependencies.
 * @param tenant - The environment the publishable key resolved to.
 * @param kind - Which flow the route belongs to.
 * @param ref - The attempt and its secret.
 * @param context - The requesting device.
 * @returns The attempt, still waiting on the same step.
 * @throws AuthError `flow.not_found`, `request.origin_not_allowed`, `flow.invalid_step` or
 *   `auth.method_disabled`.
 * @throws RateLimitError when the address was emailed too recently or too often.
 */
export async function resendCode(
  deps: Deps,
  tenant: Tenant,
  kind: FlowKind,
  ref: AttemptRef,
  context: ClientContext
): Promise<FlowResult> {
  const { attempt, state } = await load(deps, tenant, kind, ref, context)
  const waitsOn = kind === 'password_reset' ? 'needs_new_password' : 'needs_email_verification'
  if (attempt.status !== waitsOn) {
    throw new AuthError('flow.invalid_step')
  }
  await requireSignUpMethod(deps, tenant, kind === 'sign_up' ? state : {})
  await issueCode(deps, tenant, attempt, state, {
    userId: attempt.userId ?? undefined,
    charge: true,
  })
  return { attempt: toAttempt(attempt, stepFor(attempt, state)), client: state.client }
}
