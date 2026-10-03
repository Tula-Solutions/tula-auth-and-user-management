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
  type PasswordResetRequest,
  type PasswordResetStartRequest,
  SecondFactorMethodSchema,
  type SessionClient,
  SessionClientSchema,
  type SessionTokens,
  type SignInStartRequest,
  type SignUpRequest,
} from '@tula/contract'
import { z } from 'zod'
import type { Deps, Tenant } from '~/dependencies'
import { AuthError, InvalidEmailError, RateLimitError, ValidationError } from '~/exceptions'
import { cleanOrigin } from '~/lib/actor'
import { randomToken, sha256Hex, timingSafeEqual } from '~/lib/crypto'
import { maskEmail, normalizeEmail, parseEmail } from '~/lib/email'
import * as logger from '~/lib/logger'
import * as Audit from '~/modules/audit/service'
import * as Factors from '~/modules/factor/service'
import * as Notices from '~/modules/notice/service'
import * as Passwords from '~/modules/password/service'
import * as Sessions from '~/modules/session/service'
import * as Settings from '~/modules/settings/service'
import * as Users from '~/modules/user/service'
import * as Verification from '~/modules/verification/service'
import type { FlowAttemptRecord } from '~/ports/flow-attempt-store'
import { CREDENTIAL_LOCKOUT, signInLockKey } from '~/ports/lockout'
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
  linkBinding?: string
): FlowAttempt {
  return {
    id: attempt.id,
    kind: attempt.kind,
    expiresAt: attempt.expiresAt.toISOString(),
    step,
    ...(secret !== undefined && { attemptSecret: secret }),
    ...(linkBinding !== undefined && { linkBinding }),
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
  }
): Promise<{ attempt: FlowAttemptRecord; secret: string }> {
  const now = deps.clock.now()
  const secret = `${ATTEMPT_SECRET_PREFIX}${randomToken()}`
  const attempt: FlowAttemptRecord = {
    id: deps.ids.next(),
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
 */
async function finish(
  deps: Deps,
  tenant: Tenant,
  attempt: FlowAttemptRecord,
  state: State,
  userId: string,
  context: ClientContext
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
  })
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
    attempt: toAttempt(attempt, { status: 'complete', userId, sessionId: tokens.sessionId }),
    tokens,
    client: state.client,
  }
}

/**
 * Park an attempt on `needs_second_factor`: the first factor (or a reset's code and password)
 * was accepted, and the user must now prove one of `secondFactors`.
 *
 * No session is created and no tokens are returned. The move is a compare-and-set, so of two
 * racing requests only one gets here.
 */
async function awaitSecondFactor(
  deps: Pick<Deps, 'flowAttempts' | 'clock'>,
  tenant: Tenant,
  attempt: FlowAttemptRecord,
  state: State,
  userId: string,
  secondFactors: State['secondFactors']
): Promise<FlowResult> {
  const pending: State = { ...state, secondFactors }
  const waiting = { ...attempt, status: 'needs_second_factor' as const, userId }
  const moved = await deps.flowAttempts.transition(
    tenant.environmentId,
    attempt.id,
    attempt.status,
    { status: waiting.status, userId, state: pending },
    deps.clock.now()
  )
  if (!moved) {
    throw new AuthError('flow.invalid_step')
  }
  return { attempt: toAttempt(waiting, stepFor(waiting, pending)), client: state.client }
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
  deps: Pick<Deps, 'flowAttempts' | 'clock' | 'ids' | 'environmentSettings' | 'config'>,
  tenant: Tenant,
  input: SignInStartRequest,
  context: ClientContext
): Promise<FlowResult> {
  requireAllowedOrigin(context.client, context)
  const strategies = Factors.firstFactors(await Settings.current(deps, tenant))
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

  const secondFactors = await Factors.requiredFor(deps, tenant, user.id)
  const next = nextStatus(attempt.kind, attempt.status, event, {
    strategies,
    emailVerified: user.emailVerifiedAt !== null,
    secondFactors,
  })
  if (next === 'complete') {
    return finish(deps, tenant, attempt, state, user.id, context)
  }
  if (next === 'needs_second_factor') {
    return awaitSecondFactor(deps, tenant, attempt, state, user.id, secondFactors)
  }

  const pending: State = { ...state, email: user.email }
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
  const secondFactors = await Factors.requiredFor(deps, tenant, user.id)
  const next = nextStatus(
    attempt.kind,
    attempt.status,
    { type: 'first_factor_verified', strategy },
    { strategies: state.strategies ?? [], emailVerified: true, secondFactors }
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
  return next === 'complete'
    ? finish(deps, tenant, attempt, rest, user.id, context)
    : awaitSecondFactor(deps, tenant, attempt, rest, user.id, secondFactors)
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
    const secondFactors = await Factors.requiredFor(deps, tenant, user.id)
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
      secondFactors,
    })
    return next === 'complete'
      ? finish(deps, tenant, attempt, state, user.id, context)
      : awaitSecondFactor(deps, tenant, attempt, state, user.id, secondFactors)
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
  return finish(deps, tenant, attempt, state, userId, context)
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
  const secondFactors = await Factors.requiredFor(deps, tenant, user.id)
  const next = nextStatus(attempt.kind, attempt.status, event, {
    strategies: [],
    // The code proves control of the address.
    emailVerified: true,
    secondFactors,
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
  return next === 'complete'
    ? finish(deps, tenant, attempt, state, user.id, context)
    : awaitSecondFactor(deps, tenant, attempt, state, user.id, secondFactors)
}

/**
 * Lockout key for second-factor guesses of one user in one environment.
 *
 * @param environmentId - The environment.
 * @param userId - The user the attempt belongs to.
 * @returns The key for `deps.lockout`.
 */
export function secondFactorLockKey(environmentId: string, userId: string): string {
  return `second_factor:${environmentId}:${userId}`
}

/**
 * Submit a second factor for an attempt waiting on `needs_second_factor`, and sign the user in.
 *
 * **The entry point every second factor uses.** The engine owns everything around the proof:
 * the attempt's secret and origin, the step, that the method is one the attempt offered, the
 * per-user lockout (`CREDENTIAL_LOCKOUT`: counted first, cleared on success, so parallel guesses
 * cannot slip through), the environment's ceiling, the ban check and the compare-and-set that
 * lets exactly one request create the session. The proof itself is checked by the verifier
 * registered for its method (`Factors.verify`). Step 1.8 adds TOTP and backup codes by
 * registering their verifiers and adding the route that calls this; nothing here changes.
 *
 * There is no HTTP route for it yet: no user can have a second factor until 1.8, so no attempt
 * reaches `needs_second_factor` outside tests.
 *
 * @param deps - All dependencies.
 * @param tenant - The environment the publishable key resolved to.
 * @param kind - Which flow the route belongs to (`sign_in` or `password_reset`).
 * @param ref - The attempt and its secret.
 * @param proof - The method and what the client submitted for it.
 * @param context - The requesting device.
 * @returns `complete` with tokens.
 * @throws AuthError `flow.not_found`, `request.origin_not_allowed`, `flow.invalid_step` (wrong
 *   step, or a method the attempt did not offer), `verification.invalid_code` for a proof that
 *   does not verify, or `auth.user_banned`.
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
  const lockKey = secondFactorLockKey(tenant.environmentId, userId)
  const lock = await deps.lockout.attempt(lockKey, CREDENTIAL_LOCKOUT, deps.clock.now())
  if (!lock.allowed) {
    throw new RateLimitError(lock.retryAfterMs)
  }
  await chargeEnvironment(deps, tenant, 'verify')

  const user = await deps.users.findById(tenant.environmentId, userId)
  if (!user || !(await Factors.verify(deps, tenant, userId, proof))) {
    throw new AuthError('verification.invalid_code')
  }
  await deps.lockout.clear(lockKey)
  if (user.bannedAt !== null) {
    throw new AuthError('auth.user_banned')
  }
  return finish(deps, tenant, attempt, state, user.id, context)
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
