import {
  durationToMs,
  type FlowAttempt,
  type FlowKind,
  type FlowStep,
  type SessionClient,
  SessionClientSchema,
  type SessionTokens,
  type SignInStartRequest,
  type SignUpRequest,
} from '@tula/contract'
import { z } from 'zod'
import type { Deps, Tenant } from '~/dependencies'
import { AuthError, InvalidEmailError, RateLimitError } from '~/exceptions'
import { sha256Hex } from '~/lib/crypto'
import { maskEmail, normalizeEmail, parseEmail } from '~/lib/email'
import * as logger from '~/lib/logger'
import * as Passwords from '~/modules/password/service'
import * as Sessions from '~/modules/session/service'
import * as Verification from '~/modules/verification/service'
import type { FlowAttemptRecord } from '~/ports/flow-attempt-store'
import { sendAccountExistsNotice } from './mailer'
import { nextStatus } from './transitions'

/** How long a sign-in or sign-up attempt can be continued. */
export const ATTEMPT_TTL = '10m'
/** Password submissions allowed per identifier and environment in {@link PASSWORD_ATTEMPTS_WINDOW}. */
export const PASSWORD_ATTEMPTS = 10
/** Window for {@link PASSWORD_ATTEMPTS}. */
export const PASSWORD_ATTEMPTS_WINDOW = '15m'

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
  /** The email already had an account when this sign-up started; it can never complete. */
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
  // Phase 0 only ever stores `needs_password` and `needs_email_verification` on open attempts;
  // `complete` is built by `finish` with its ids.
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
  input: Pick<FlowAttemptRecord, 'kind' | 'status' | 'identifier'> & { state: State }
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

/** Email the attempt's verification code, or the notice for a decoy sign-up. */
async function issueCode(
  deps: Deps,
  tenant: Tenant,
  attempt: FlowAttemptRecord,
  state: State,
  userId?: string
): Promise<void> {
  await Verification.issue(deps, tenant, {
    purpose: 'email_verification',
    destination: state.email ?? attempt.identifier,
    flowAttemptId: attempt.id,
    userId,
    ...(state.decoy && { deliver: ({ to }) => sendAccountExistsNotice(deps, to) }),
  })
}

/**
 * Start a sign-in. Always answers `needs_password`, whoever the identifier belongs to and
 * whether or not it exists: the identifier is not looked up until a password is submitted.
 *
 * @param deps - Flow attempt store, clock and ids.
 * @param tenant - The environment the publishable key resolved to.
 * @param input - The identifier (email).
 * @param context - The requesting device.
 * @returns The attempt, waiting on `needs_password`.
 */
export async function signIn(
  deps: Pick<Deps, 'flowAttempts' | 'clock' | 'ids'>,
  tenant: Tenant,
  input: SignInStartRequest,
  context: ClientContext
): Promise<FlowResult> {
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
 * someone who knows the password. Submissions are limited per identifier, so the limit follows
 * the account across attempts and IPs.
 *
 * @param deps - All dependencies.
 * @param tenant - The environment the publishable key resolved to.
 * @param attemptId - The sign-in attempt.
 * @param password - The submitted password.
 * @param context - The requesting device.
 * @returns `complete` with tokens, or `needs_email_verification` for an unverified email.
 * @throws AuthError `flow.not_found`, `flow.invalid_step`, `auth.invalid_credentials` or
 *   `auth.user_banned`.
 * @throws RateLimitError after too many submissions for the identifier.
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
  // Hash the identifier so limiter keys (which may live in Redis) hold no email.
  const limit = await deps.rateLimiter.hit(
    `sign_in_password:${tenant.environmentId}:${sha256Hex(attempt.identifier)}`,
    PASSWORD_ATTEMPTS,
    durationToMs(PASSWORD_ATTEMPTS_WINDOW)
  )
  if (!limit.allowed) {
    throw new RateLimitError(limit.retryAfterMs)
  }

  const found = await deps.users.findByEmailWithPassword(tenant.environmentId, attempt.identifier)
  if (!(await Passwords.verify(found?.passwordHash ?? null, password)) || !found) {
    throw new AuthError('auth.invalid_credentials')
  }
  const { user } = found
  if (user.bannedAt !== null) {
    throw new AuthError('auth.user_banned')
  }
  if (found.passwordHash && Passwords.needsRehash(found.passwordHash)) {
    await deps.users.setPasswordHash(
      tenant.environmentId,
      user.id,
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
  await issueCode(deps, tenant, waiting, pending, user.id)
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
 * @throws AuthError `flow.not_found`, `flow.invalid_step`, a `verification.*` code or
 *   `auth.user_banned`.
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
    await deps.users.markEmailVerified(tenant.environmentId, user.id, now)
    return finish(deps, tenant, attempt, state, user.id, context)
  }

  if (state.decoy || !state.passwordHash) {
    // Someone guessed the decoy code of a sign-up for an address that already has an account.
    // Answer as if the guess was wrong: the attempt can never create or enter an account.
    throw new AuthError('verification.invalid_code', { attemptsRemaining: 0 })
  }
  const userId = deps.ids.next()
  const created = await deps.users.createWithPassword({
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
  })
  if (!created) {
    // Another sign-up for the same address was verified first.
    throw new AuthError('flow.invalid_step')
  }
  return finish(deps, tenant, attempt, state, userId, context)
}

/**
 * Send a fresh verification code for an attempt waiting on `needs_email_verification`.
 *
 * Subject to the same per-address send limits as the first email. A decoy sign-up resends its
 * notice, so resending cannot be used to tell new from existing addresses either.
 *
 * @param deps - All dependencies.
 * @param tenant - The environment the publishable key resolved to.
 * @param kind - Which flow the route belongs to.
 * @param attemptId - The attempt.
 * @returns The attempt, still waiting on `needs_email_verification`.
 * @throws AuthError `flow.not_found` or `flow.invalid_step`.
 * @throws RateLimitError when the address was emailed too recently or too often.
 */
export async function resendVerification(
  deps: Deps,
  tenant: Tenant,
  kind: FlowKind,
  attemptId: string
): Promise<FlowResult> {
  const { attempt, state } = await load(deps, tenant, kind, attemptId)
  if (attempt.status !== 'needs_email_verification') {
    throw new AuthError('flow.invalid_step')
  }
  await issueCode(deps, tenant, attempt, state, attempt.userId ?? undefined)
  return { attempt: toAttempt(attempt, stepFor(attempt, state)), client: state.client }
}

/**
 * Delete every expired attempt in every environment.
 *
 * Abandoned sign-ups hold the hash of a password that was never used; nothing else removes
 * them. Run on boot and on a timer by `server.ts`. A failure in one environment is logged and
 * skipped, so it cannot keep the environments after it from being purged.
 *
 * @param deps - Environments, flow attempt store and clock.
 * @returns How many attempts were removed.
 */
export async function purgeExpired(
  deps: Pick<Deps, 'environments' | 'flowAttempts' | 'clock'>
): Promise<number> {
  const now = deps.clock.now()
  let removed = 0
  for (const environment of await deps.environments.listAll()) {
    try {
      removed += await deps.flowAttempts.deleteExpired(environment.id, now)
    } catch (error) {
      logger.warn('could not purge expired flow attempts', {
        environmentId: environment.id,
        err: error instanceof Error ? error.name : 'unknown',
      })
    }
  }
  return removed
}
