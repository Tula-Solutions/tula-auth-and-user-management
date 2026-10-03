import {
  durationToMs,
  type FlowAttempt,
  type FlowKind,
  type FlowStep,
  type PasswordResetRequest,
  type PasswordResetStartRequest,
  type SessionClient,
  SessionClientSchema,
  type SessionTokens,
  type SignInStartRequest,
  type SignUpRequest,
} from '@tula/contract'
import { z } from 'zod'
import type { Deps, Tenant } from '~/dependencies'
import { AuthError, InvalidEmailError, RateLimitError } from '~/exceptions'
import { cleanOrigin } from '~/lib/actor'
import { maskEmail, normalizeEmail, parseEmail } from '~/lib/email'
import * as logger from '~/lib/logger'
import * as Audit from '~/modules/audit/service'
import * as Passwords from '~/modules/password/service'
import * as Sessions from '~/modules/session/service'
import * as Settings from '~/modules/settings/service'
import * as Users from '~/modules/user/service'
import * as Verification from '~/modules/verification/service'
import type { FlowAttemptRecord } from '~/ports/flow-attempt-store'
import { CREDENTIAL_LOCKOUT, signInLockKey } from '~/ports/lockout'
import { sendAccountExistsNotice, sendNoAccountNotice } from './mailer'
import { nextStatus } from './transitions'

/** How long a sign-in or sign-up attempt can be continued. */
export const ATTEMPT_TTL = '10m'
/**
 * Requests per minute for a whole environment, across all callers, on the steps that cost an
 * argon2id hash or an email. Generous for real traffic (ten sign-ups a second), tight enough
 * that a botnet aimed at one tenant can't monopolise the server. Refresh has no ceiling: every
 * active user refreshes about once a minute, so one would throttle a large app in normal use.
 */
export const ENVIRONMENT_RATE_LIMITS = {
  signUp: 600,
  passwordReset: 600,
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
 * no guess, no code and no rate limit. Every flow today is a password flow; a flow for another
 * method checks its own switch.
 */
function requirePasswordMethod(
  deps: Pick<Deps, 'environmentSettings' | 'config'>,
  tenant: Pick<Tenant, 'environmentId'>
): Promise<void> {
  return Settings.requireMethod(deps, tenant, 'password')
}

/** The device a flow request comes from. Captured when the attempt starts. */
export interface ClientContext {
  /** Decides how the refresh token is delivered when the flow completes. */
  client: SessionClient
  userAgent: string | null
  ipAddress: string | null
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
  // Open attempts are only ever stored on the steps above or `needs_password`; `complete` is
  // built by `finish` with its ids.
  return { status: 'needs_password' }
}

function toAttempt(attempt: FlowAttemptRecord, step: FlowStep): FlowAttempt {
  return {
    id: attempt.id,
    kind: attempt.kind,
    expiresAt: attempt.expiresAt.toISOString(),
    step,
  }
}

async function start(
  deps: Pick<Deps, 'flowAttempts' | 'clock' | 'ids'>,
  tenant: Tenant,
  input: Pick<FlowAttemptRecord, 'kind' | 'status' | 'identifier'> & {
    state: State
    userId?: string
  }
): Promise<FlowAttemptRecord> {
  const now = deps.clock.now()
  const attempt: FlowAttemptRecord = {
    id: deps.ids.next(),
    projectId: tenant.projectId,
    environmentId: tenant.environmentId,
    userId: null,
    expiresAt: new Date(now.getTime() + durationToMs(ATTEMPT_TTL)),
    completedAt: null,
    createdAt: now,
    ...input,
  }
  await deps.flowAttempts.create(attempt)
  return attempt
}

/**
 * Load an open attempt of the given kind.
 *
 * Unknown, foreign-environment, wrong-kind, completed and expired attempts are all the same
 * `flow.not_found`, so attempt ids reveal nothing.
 */
async function load(
  deps: Pick<Deps, 'flowAttempts' | 'clock'>,
  tenant: Tenant,
  kind: FlowKind,
  attemptId: string
): Promise<{ attempt: FlowAttemptRecord; state: State }> {
  const attempt = await deps.flowAttempts.findById(tenant.environmentId, attemptId)
  if (
    !attempt ||
    attempt.kind !== kind ||
    attempt.completedAt !== null ||
    attempt.expiresAt.getTime() <= deps.clock.now().getTime()
  ) {
    throw new AuthError('flow.not_found')
  }
  return { attempt, state: StateSchema.parse(attempt.state) }
}

/**
 * Complete an attempt and start the user's session.
 *
 * The attempt is moved to `complete` first, as a compare-and-set, so of two racing requests
 * only one creates a session. Pending sign-up data (the password hash) is dropped from it.
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
 * Start a sign-up: check the email and password, then email a verification code.
 *
 * The account is created only when the email is verified, so nobody can squat on an address
 * they don't control. The response is the same whether or not the address already has an
 * account (no enumeration): an existing owner is emailed a notice instead of a code, and the
 * attempt gets a decoy code nobody knows, so later guesses behave identically and can never
 * complete it. The password is hashed in both cases so the two take the same time.
 *
 * @param deps - All dependencies.
 * @param tenant - The environment the publishable key resolved to.
 * @param input - Email, password and optional names.
 * @param context - The requesting device.
 * @returns The attempt, waiting on `needs_email_verification`.
 * @throws InvalidEmailError, or a `password.*` ServiceException with per-field `errors`.
 * @throws AuthError `auth.method_disabled` when the environment has switched passwords off.
 * @throws RateLimitError when the address was emailed too recently or too often.
 */
export async function signUp(
  deps: Deps,
  tenant: Tenant,
  input: SignUpRequest,
  context: ClientContext
): Promise<FlowResult> {
  const parsed = parseEmail(input.email)
  if (!parsed) {
    throw new InvalidEmailError()
  }
  const { email, normalized: identifier } = parsed
  await requirePasswordMethod(deps, tenant)
  await chargeEnvironment(deps, tenant, 'signUp')
  const firstName = input.firstName?.trim() || null
  const lastName = input.lastName?.trim() || null
  await Passwords.assess(deps, tenant, input.password, {
    email,
    firstName: firstName ?? undefined,
    lastName: lastName ?? undefined,
  })
  const passwordHash = await Passwords.hash(input.password)

  const decoy = (await deps.users.findByEmail(tenant.environmentId, identifier)) !== null
  const state: State = decoy
    ? { client: context.client, email, decoy: true }
    : { client: context.client, email, firstName, lastName, passwordHash }
  const attempt = await start(deps, tenant, {
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
  return { attempt: toAttempt(attempt, stepFor(attempt, state)), client: state.client }
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
 * Start a sign-in. Always answers `needs_password`, whoever the identifier belongs to and
 * whether or not it exists: the identifier is not looked up until a password is submitted.
 *
 * Password is the only first factor today, so an environment that has switched it off refuses
 * the start. Step 1.3 turns this into the choice of first factor (`needs_first_factor`).
 *
 * @param deps - Flow attempt store, clock, ids and settings.
 * @param tenant - The environment the publishable key resolved to.
 * @param input - The identifier (email).
 * @param context - The requesting device.
 * @returns The attempt, waiting on `needs_password`.
 * @throws AuthError `auth.method_disabled` when the environment has switched passwords off.
 */
export async function signIn(
  deps: Pick<Deps, 'flowAttempts' | 'clock' | 'ids' | 'environmentSettings' | 'config'>,
  tenant: Tenant,
  input: SignInStartRequest,
  context: ClientContext
): Promise<FlowResult> {
  await requirePasswordMethod(deps, tenant)
  const state: State = { client: context.client }
  const attempt = await start(deps, tenant, {
    kind: 'sign_in',
    status: 'needs_password',
    identifier: normalizeEmail(input.identifier),
    state,
  })
  return { attempt: toAttempt(attempt, stepFor(attempt, state)), client: state.client }
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
 * @param deps - All dependencies.
 * @param tenant - The environment the publishable key resolved to.
 * @param attemptId - The sign-in attempt.
 * @param password - The submitted password.
 * @param context - The requesting device.
 * @returns `complete` with tokens, or `needs_email_verification` for an unverified email.
 * @throws AuthError `flow.not_found`, `flow.invalid_step`, `auth.method_disabled`,
 *   `auth.invalid_credentials` or `auth.user_banned`.
 * @throws RateLimitError while the identifier is locked out after repeated failures.
 */
export async function submitPassword(
  deps: Deps,
  tenant: Tenant,
  attemptId: string,
  password: string,
  context: ClientContext
): Promise<FlowResult> {
  const { attempt, state } = await load(deps, tenant, 'sign_in', attemptId)
  if (attempt.status !== 'needs_password') {
    throw new AuthError('flow.invalid_step')
  }
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

  const next = nextStatus(attempt.kind, attempt.status, {
    type: 'password_verified',
    emailVerified: user.emailVerifiedAt !== null,
  })
  if (next === 'complete') {
    return finish(deps, tenant, attempt, state, user.id, context)
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
 * Submit the emailed code for an attempt waiting on `needs_email_verification`.
 *
 * For a sign-up this creates the account (now that the address is proven) and signs the user
 * in. For a sign-in it marks the user's email verified and completes the sign-in.
 *
 * @param deps - All dependencies.
 * @param tenant - The environment the publishable key resolved to.
 * @param kind - Which flow the route belongs to; an attempt of the other kind is not found.
 * @param attemptId - The attempt.
 * @param code - The 6-digit code.
 * @param context - The requesting device.
 * @returns `complete` with tokens.
 * @throws AuthError `flow.not_found`, `flow.invalid_step`, `auth.method_disabled`, a
 *   `verification.*` code or `auth.user_banned`.
 */
export async function verifyEmail(
  deps: Deps,
  tenant: Tenant,
  kind: FlowKind,
  attemptId: string,
  code: string,
  context: ClientContext
): Promise<FlowResult> {
  const { attempt, state } = await load(deps, tenant, kind, attemptId)
  // Throws `flow.invalid_step` unless the attempt is waiting on email verification.
  nextStatus(attempt.kind, attempt.status, { type: 'email_verified' })
  await requirePasswordMethod(deps, tenant)
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
    return finish(deps, tenant, attempt, state, user.id, context)
  }

  if (state.decoy || !state.passwordHash) {
    // Someone guessed the decoy code of a sign-up for an address that already has an account.
    // Answer as if the guess was wrong: the attempt can never create or enter an account.
    throw new AuthError('verification.invalid_code', { attemptsRemaining: 0 })
  }
  const userId = deps.ids.next()
  const created = await deps.users.createWithPassword(
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
      passwordHash: state.passwordHash,
    },
    Audit.entry(deps, tenant, {
      type: 'user.created',
      // They created the account themselves, so the new user is the actor.
      actor: { type: 'user', id: userId, ...context },
      target: { type: 'user', id: userId },
      data: { method: 'sign_up', emailVerified: true },
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
 * @throws AuthError `auth.method_disabled` when the environment has switched passwords off.
 * @throws RateLimitError when the address was emailed too recently or too often.
 */
export async function startPasswordReset(
  deps: Deps,
  tenant: Tenant,
  input: PasswordResetStartRequest,
  context: ClientContext
): Promise<FlowResult> {
  const parsed = parseEmail(input.email)
  if (!parsed) {
    throw new InvalidEmailError()
  }
  const { email, normalized: identifier } = parsed
  await requirePasswordMethod(deps, tenant)
  await chargeEnvironment(deps, tenant, 'passwordReset')
  const user = await deps.users.findByEmail(tenant.environmentId, identifier)
  const state: State = { client: context.client, email, ...(!user && { decoy: true }) }
  const attempt = await start(deps, tenant, {
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
  return { attempt: toAttempt(attempt, stepFor(attempt, state)), client: state.client }
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
 * @param deps - All dependencies.
 * @param tenant - The environment the publishable key resolved to.
 * @param attemptId - The password-reset attempt.
 * @param input - The emailed code and the new password.
 * @param context - The requesting device.
 * @returns `complete` with tokens.
 * @throws AuthError `flow.not_found`, `flow.invalid_step`, `auth.method_disabled`, a
 *   `verification.*` code or `auth.user_banned`.
 * @throws ServiceException a `password.*` code when the new password fails the policy.
 */
export async function resetPassword(
  deps: Deps,
  tenant: Tenant,
  attemptId: string,
  input: PasswordResetRequest,
  context: ClientContext
): Promise<FlowResult> {
  const { attempt, state } = await load(deps, tenant, 'password_reset', attemptId)
  // Throws `flow.invalid_step` unless the attempt is waiting on the new password.
  nextStatus(attempt.kind, attempt.status, { type: 'password_reset' })
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
 * @param attemptId - The attempt.
 * @returns The attempt, still waiting on the same step.
 * @throws AuthError `flow.not_found`, `flow.invalid_step` or `auth.method_disabled`.
 * @throws RateLimitError when the address was emailed too recently or too often.
 */
export async function resendCode(
  deps: Deps,
  tenant: Tenant,
  kind: FlowKind,
  attemptId: string
): Promise<FlowResult> {
  const { attempt, state } = await load(deps, tenant, kind, attemptId)
  const waitsOn = kind === 'password_reset' ? 'needs_new_password' : 'needs_email_verification'
  if (attempt.status !== waitsOn) {
    throw new AuthError('flow.invalid_step')
  }
  await requirePasswordMethod(deps, tenant)
  await issueCode(deps, tenant, attempt, state, {
    userId: attempt.userId ?? undefined,
    charge: true,
  })
  return { attempt: toAttempt(attempt, stepFor(attempt, state)), client: state.client }
}
