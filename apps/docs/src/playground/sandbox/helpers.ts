import { ERROR_DEFINITIONS } from '@tula-tech/contract/error-codes'
import { evaluatePassword } from '@tula-tech/contract/password-rules'
import type { Operations, Schemas } from './api-types'
import { SandboxError } from './errors'
import { matchTotp } from './totp'
import type { SandboxAttempt, SandboxProvider, SandboxSession, SandboxUser } from './types'
import {
  ACCESS_TOKEN_TTL_MS,
  ATTEMPT_TTL_MS,
  maskEmail,
  normalizeEmail,
  SANDBOX_PASSWORD_POLICY,
  type World,
} from './world'

// The parts of the in-browser API that several routes share: the attempt a step belongs to,
// the step a status is drawn as, the session a sign-in ends with, and the checks of a code, a
// password and a second factor. `handlers.ts` is the table of routes; this is what they call.

/** The address the sandbox pretends to be served from. `.invalid` is reserved: it never resolves. */
export const SANDBOX_ORIGIN = 'https://sandbox.tula.invalid'

/** What a handler gets. */
export interface Context<Id extends keyof Operations> {
  world: World
  params: Operations[Id]['params']
  body: Operations[Id]['body']
  /** `x-tula-attempt`. */
  attemptSecret: string | null
  /** The bearer token. */
  accessToken: string | null
  /** `x-tula-client`. */
  client: Schemas['SessionClient']
  /** The request's JSON body parsed, for a handler that reads it loosely. */
  raw: unknown
}

/** The result a route answers with. */
export type Answer<Id extends keyof Operations> = Operations[Id]['response']

/**
 * The ordinary string of a value that should be one.
 *
 * @param value - Anything.
 * @param field - The field's name, for the error.
 * @returns The string.
 * @throws SandboxError `validation.failed` for a value that is not a non-empty string.
 */
export function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SandboxError('validation.failed', {
      fields: [{ field, code: 'validation.failed', message: 'This field is required.' }],
    })
  }
  return value
}

/**
 * Check an email address the way the sign-up form does.
 *
 * @param value - What was typed.
 * @returns The address, trimmed.
 * @throws SandboxError `email.invalid`.
 */
export function email(value: unknown): string {
  const address = typeof value === 'string' ? value.trim() : ''
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) || address.length > 254) {
    throw new SandboxError('email.invalid', {
      fields: [
        {
          field: 'email',
          code: 'email.invalid',
          message: ERROR_DEFINITIONS['email.invalid'].message,
        },
      ],
    })
  }
  return address
}

/**
 * Check a password against the environment's policy.
 *
 * @param password - The candidate.
 * @param info - The account's details a password must not contain.
 * @throws SandboxError with the first failing rule's code and every failing rule as a field error.
 */
export function assertPolicy(
  password: string,
  info: { email?: string; firstName?: string | null; lastName?: string | null }
): void {
  const result = evaluatePassword(SANDBOX_PASSWORD_POLICY, password, {
    ...(info.email && { email: info.email }),
    ...(info.firstName && { firstName: info.firstName }),
    ...(info.lastName && { lastName: info.lastName }),
  })
  const failed = result.checks.filter((check) => !check.passed)
  if (failed.length === 0) {
    return
  }
  const first = failed[0] as (typeof failed)[number]
  throw new SandboxError(first.code as Schemas['ErrorCode'], {
    ...(first.params && { params: first.params as Record<string, number> }),
    fields: failed.map((check) => ({
      field: 'password',
      code: check.code as Schemas['ErrorCode'],
      message:
        (ERROR_DEFINITIONS as Record<string, { message: string }>)[check.code]?.message ?? '',
      ...(check.params && { params: check.params as Record<string, number> }),
    })),
  })
}

function b64url(value: unknown): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * A token that looks like the real access token to the client (a JWT with `exp`) and is plainly
 * not one: its header names the sandbox, and its signature is the word `sandbox`.
 *
 * @param world - The sandbox.
 * @param session - The session it is for.
 * @returns The token.
 */
export function accessTokenFor(world: World, session: SandboxSession): string {
  const iat = Math.floor(world.now() / 1000)
  return [
    b64url({ alg: 'none', typ: 'JWT', note: 'sandbox token, not a credential' }),
    b64url({
      iss: SANDBOX_ORIGIN,
      sub: session.userId,
      sid: session.id,
      iat,
      exp: iat + Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      amr: session.amr,
    }),
    'sandbox',
  ].join('.')
}

/**
 * The tokens a session is handed to the client as: a `web` client keeps its refresh token in an
 * httpOnly cookie in the real service, and here in the world's cookie jar.
 *
 * @param world - The sandbox.
 * @param session - The session.
 * @param client - Which kind of client asked.
 * @returns The answer's `session` member.
 */
export function tokensFor(
  world: World,
  session: SandboxSession,
  client: Schemas['SessionClient']
): Schemas['SessionTokens'] {
  const issued = {
    sessionId: session.id,
    accessToken: accessTokenFor(world, session),
    accessTokenExpiresAt: new Date(world.now() + ACCESS_TOKEN_TTL_MS).toISOString(),
  }
  if (client === 'web') {
    world.cookie.refreshToken = session.refreshToken
    return issued
  }
  return { ...issued, refreshToken: session.refreshToken }
}

/**
 * Find the signed-in user for a request.
 *
 * @param ctx - The request.
 * @returns The user and the session.
 * @throws SandboxError `auth.unauthenticated` with no token, `session.invalid_token` or
 *   `session.expired` for a token the sandbox does not honour.
 */
export function authenticate(ctx: Pick<Context<keyof Operations>, 'world' | 'accessToken'>): {
  user: SandboxUser
  session: SandboxSession
} {
  if (!ctx.accessToken) {
    throw new SandboxError('auth.unauthenticated')
  }
  let claims: { sid?: unknown; exp?: unknown }
  try {
    const payload = ctx.accessToken.split('.')[1] ?? ''
    claims = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')))
  } catch {
    throw new SandboxError('session.invalid_token')
  }
  const session = typeof claims.sid === 'string' ? ctx.world.sessions.get(claims.sid) : undefined
  if (!session) {
    throw new SandboxError('session.revoked')
  }
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= ctx.world.now()) {
    throw new SandboxError('session.expired')
  }
  const user = ctx.world.users.get(session.userId)
  if (!user) {
    throw new SandboxError('session.revoked')
  }
  return { user, session }
}

/**
 * The signed-in user as the API describes them.
 *
 * @param user - The account.
 * @returns The `CurrentUser`.
 */
export function currentUser(user: SandboxUser): Schemas['CurrentUser'] {
  return {
    id: user.id,
    email: user.email,
    emailVerifiedAt: user.emailVerifiedAt,
    firstName: user.firstName,
    lastName: user.lastName,
    bannedAt: null,
    lastSignInAt: user.lastSignInAt,
    createdAt: user.createdAt,
    phoneNumber: null,
    phoneNumberVerifiedAt: null,
    hasPassword: user.password !== null,
  }
}

/**
 * The first factors the environment offers, from its settings and never from an identifier.
 *
 * @param world - The sandbox.
 * @returns The strategies, in the order the real service lists them.
 */
export function firstFactors(world: World): Schemas['FirstFactorStrategy'][] {
  const { methods, oauth } = world.settings
  const strategies: Schemas['FirstFactorStrategy'][] = []
  if (methods.password) {
    strategies.push('password')
  }
  if (methods.emailCode) {
    strategies.push('email_code')
  }
  if (methods.emailLink && methods.emailCode) {
    strategies.push('email_link')
  }
  if (methods.passkey) {
    strategies.push('passkey')
  }
  for (const provider of oauth) {
    strategies.push(`oauth_${provider}` as Schemas['FirstFactorStrategy'])
  }
  return strategies
}

/**
 * Make an attempt.
 *
 * @param world - The sandbox.
 * @param kind - Sign-in, sign-up or reset.
 * @param status - The step it starts on.
 * @param init - The rest.
 * @returns The attempt, stored.
 */
export function startAttempt(
  world: World,
  kind: Schemas['FlowKind'],
  status: SandboxAttempt['status'],
  init: Partial<SandboxAttempt> & { identifier: string }
): SandboxAttempt {
  const attempt: SandboxAttempt = {
    id: world.id('att'),
    secret: `sbx_as_${world.secret(24)}`,
    kind,
    expiresAt: world.now() + ATTEMPT_TTL_MS,
    status,
    strategies: [],
    userId: null,
    proven: [],
    signUp: null,
    verification: null,
    linkBinding: null,
    linkVerified: false,
    linkRedirectUrl: null,
    secondFactors: [],
    enrolmentSecret: null,
    prepared: null,
    oauth: null,
    sessionId: null,
    passwordProven: false,
    ...init,
  }
  world.attempts.set(attempt.id, attempt)
  return attempt
}

/**
 * The attempt a call belongs to. Missing, wrong, another attempt's and expired secrets are all
 * the same `flow.not_found`, so an answer says nothing about which.
 *
 * @param ctx - The request.
 * @param id - The attempt's id from the path.
 * @param kind - The kind the route is for.
 * @returns The attempt.
 * @throws SandboxError `flow.not_found`.
 */
export function loadAttempt(
  ctx: Pick<Context<keyof Operations>, 'world' | 'attemptSecret'>,
  id: string,
  kind: Schemas['FlowKind']
): SandboxAttempt {
  const attempt = ctx.world.attempts.get(id)
  if (
    !attempt ||
    attempt.kind !== kind ||
    !ctx.attemptSecret ||
    ctx.attemptSecret !== attempt.secret ||
    attempt.expiresAt <= ctx.world.now()
  ) {
    throw new SandboxError('flow.not_found')
  }
  return attempt
}

/**
 * Refuse a step the attempt is not waiting on.
 *
 * @param attempt - The attempt.
 * @param statuses - The steps the route accepts.
 * @throws SandboxError `flow.invalid_step`.
 */
export function requireStep(
  attempt: SandboxAttempt,
  ...statuses: SandboxAttempt['status'][]
): void {
  if (!statuses.includes(attempt.status)) {
    throw new SandboxError('flow.invalid_step')
  }
}

/**
 * The step an attempt is waiting on, as the contract draws it.
 *
 * @param world - The sandbox.
 * @param attempt - The attempt.
 * @returns The `FlowStep`.
 */
export function stepOf(world: World, attempt: SandboxAttempt): Schemas['FlowStep'] {
  const address = attempt.signUp
    ? attempt.identifier
    : (world.users.get(attempt.userId ?? '')?.email ?? attempt.identifier)
  switch (attempt.status) {
    case 'needs_password':
      return { status: 'needs_password' }
    case 'needs_first_factor':
      return {
        status: 'needs_first_factor',
        strategies: attempt.strategies,
        ...(attempt.prepared && {
          prepared: { strategy: attempt.prepared, destination: maskEmail(attempt.identifier) },
        }),
      }
    case 'needs_email_verification':
      return {
        status: 'needs_email_verification',
        destination: maskEmail(address),
        strategies: ['email_code'],
      }
    case 'needs_new_password':
      return {
        status: 'needs_new_password',
        destination: maskEmail(attempt.identifier),
        strategies: ['email_code'],
      }
    case 'needs_second_factor':
      return { status: 'needs_second_factor', options: attempt.secondFactors }
    case 'needs_factor_enrolment':
      return { status: 'needs_factor_enrolment', methods: ['totp'] }
    case 'complete':
      return {
        status: 'complete',
        userId: attempt.userId ?? '',
        sessionId: attempt.sessionId ?? '',
      }
  }
}

/**
 * The attempt as the API answers with it.
 *
 * @param world - The sandbox.
 * @param attempt - The attempt.
 * @param extra - The members only some answers carry (the secret at a start, tokens at the end).
 * @returns The `FlowAttempt`.
 */
export function attemptBody(
  world: World,
  attempt: SandboxAttempt,
  extra: Partial<Schemas['FlowAttempt']> = {}
): Schemas['FlowAttempt'] {
  return {
    id: attempt.id,
    kind: attempt.kind,
    expiresAt: new Date(attempt.expiresAt).toISOString(),
    step: stepOf(world, attempt),
    ...extra,
  }
}

/**
 * Send an emailed code (and, for a link, the link) for an attempt.
 *
 * An address with no account is sent a notice with no code or link, and the attempt holds a
 * decoy, so the answer says nothing about whether the account exists (as the real service).
 *
 * @param world - The sandbox.
 * @param attempt - The attempt.
 * @param options - Who to, whether there is an account, where a link leads and why.
 */
export function sendCode(
  world: World,
  attempt: SandboxAttempt,
  options: {
    to: string
    known: boolean
    link?: string
    purpose: 'sign-in' | 'verify' | 'reset'
    /** What the notice says when there is nothing to send a code for. */
    notice?: 'no-account' | 'has-account'
  }
): void {
  const app = world.settings.appName
  if (!options.known) {
    const notice = world.sendEmail({
      to: options.to,
      subject: `Someone tried to use ${options.to} at ${app}`,
      text:
        options.notice === 'has-account'
          ? `Someone tried to sign up at ${app} with ${options.to}, but there is already an account with that address. If it was you, sign in or reset your password. If it was not, ignore this message. (No code or link is included, on purpose.)`
          : `Someone asked for a code for ${options.to}, but there is no account with that address. If it was you, sign up first. If it was not, ignore this message. (No code or link is included, on purpose.)`,
      notice: true,
    })
    attempt.verification = {
      code: world.digits(),
      linkToken: null,
      expiresAt: world.now() + ATTEMPT_TTL_MS,
      tries: 0,
      emailId: notice.id,
      decoy: true,
    }
    return
  }
  const code = world.digits()
  const linkToken = options.link ? `sbx_lt_${world.secret(18)}` : null
  const link =
    options.link && linkToken
      ? `${options.link}#tula_link=${linkToken}&tula_attempt=${attempt.id}`
      : undefined
  const subject = {
    'sign-in': `${code} is your ${app} sign-in code`,
    verify: `${code} is your ${app} verification code`,
    reset: `${code} is your ${app} password reset code`,
  }[options.purpose]
  const sent = world.sendEmail({
    to: options.to,
    subject,
    text: `Your code is ${code}. It expires in 10 minutes.${link ? ' You can also use the link below, in the browser where you started.' : ''}`,
    code,
    ...(link && { link }),
    notice: false,
  })
  attempt.verification = {
    code,
    linkToken,
    expiresAt: world.now() + ATTEMPT_TTL_MS,
    tries: 0,
    emailId: sent.id,
    decoy: false,
  }
}

/**
 * Check an emailed code: expired, wrong (five guesses), or right.
 *
 * @param world - The sandbox.
 * @param attempt - The attempt holding the code.
 * @param code - What the user typed.
 * @param identifier - The identifier whose lockout the guess counts against.
 * @throws SandboxError `verification.expired`, `verification.invalid_code`,
 *   `verification.too_many_attempts` or `rate_limited`.
 */
export function checkCode(
  world: World,
  attempt: SandboxAttempt,
  code: string,
  identifier: string
): void {
  world.assertNotLocked(identifier)
  const pending = attempt.verification
  if (!pending || pending.expiresAt <= world.now()) {
    throw new SandboxError('verification.expired')
  }
  if (pending.tries >= 5) {
    throw new SandboxError('verification.too_many_attempts', { retryAfterSeconds: 60 })
  }
  const mail = world.inbox.find((message) => message.id === pending.emailId)
  if (mail?.expired) {
    throw new SandboxError('verification.expired')
  }
  if (pending.decoy || pending.code !== code.trim()) {
    pending.tries += 1
    world.countFailure(identifier)
    throw new SandboxError('verification.invalid_code')
  }
  world.clearFailures(identifier)
  attempt.verification = null
}

/**
 * Check a TOTP or backup code for a user, counting a wrong guess once for all second factors.
 *
 * @param world - The sandbox.
 * @param user - The account.
 * @param proof - The method and code.
 * @throws SandboxError `mfa.invalid_code` or `rate_limited`.
 */
export async function checkSecondFactor(
  world: World,
  user: SandboxUser,
  proof: { method: 'totp' | 'backup_code'; code: string }
): Promise<void> {
  const key = `mfa:${user.id}`
  world.assertNotLocked(key)
  let ok = false
  if (proof.method === 'totp' && user.totp?.confirmedAt) {
    const step = await matchTotp(user.totp.secret, proof.code.replace(/\s/g, ''), world.now())
    const last = world.usedTotpSteps.get(user.id) ?? -1
    // A time step is accepted once, as in the real service.
    if (step !== null && step > last) {
      world.usedTotpSteps.set(user.id, step)
      ok = true
    }
  } else if (proof.method === 'backup_code') {
    const wanted = proof.code.trim().toLowerCase()
    const at = user.backupCodes.indexOf(wanted)
    if (at !== -1) {
      user.backupCodes.splice(at, 1)
      ok = true
    }
  }
  if (!ok) {
    world.countFailure(key)
    throw new SandboxError('mfa.invalid_code')
  }
  world.clearFailures(key)
}

/**
 * Make backup codes for a user.
 *
 * @param world - The sandbox.
 * @param user - The account; its codes are replaced.
 * @returns The new codes.
 */
export function newBackupCodes(world: World, user: SandboxUser): string[] {
  user.backupCodes = Array.from({ length: 10 }, () => {
    const digits = world.secret(4)
    return `sbx-${digits.slice(0, 4)}-${digits.slice(4)}`
  })
  return [...user.backupCodes]
}

/**
 * What a user must prove after a first factor, as the real service decides.
 *
 * @param world - The sandbox.
 * @param user - The account.
 * @returns The second factors to choose from, `enrol` where the policy requires one the user
 *   has not set up, or nothing.
 */
export function secondFactorsFor(
  world: World,
  user: SandboxUser
): { options: Schemas['SecondFactorMethod'][]; enrol: boolean } {
  if (user.totp?.confirmedAt) {
    return {
      options: user.backupCodes.length > 0 ? ['totp', 'backup_code'] : ['totp'],
      enrol: false,
    }
  }
  return { options: [], enrol: world.settings.mfaPolicy === 'required' }
}

/**
 * Move an attempt on after a first factor was proven, the way `nextStatus` does: an unverified
 * address first, then a second factor or an enrolment, then the end.
 *
 * @param world - The sandbox.
 * @param attempt - The attempt.
 * @param user - The account the factor named.
 * @param proof - What it proved (for the session's `amr`).
 * @param options - Whether the address still has to be verified.
 */
export function afterFirstFactor(
  world: World,
  attempt: SandboxAttempt,
  user: SandboxUser,
  proof: string,
  options: { verifyEmail: boolean } = { verifyEmail: true }
): void {
  attempt.userId = user.id
  attempt.proven.push(proof)
  if (options.verifyEmail && user.emailVerifiedAt === null) {
    attempt.status = 'needs_email_verification'
    sendCode(world, attempt, { to: user.email, known: true, purpose: 'verify' })
    return
  }
  afterEmailOrFactor(world, attempt, user)
}

/**
 * The part of {@link afterFirstFactor} after the address is verified.
 *
 * @param world - The sandbox.
 * @param attempt - The attempt.
 * @param user - The account.
 */
export function afterEmailOrFactor(world: World, attempt: SandboxAttempt, user: SandboxUser): void {
  // A passkey sign-in is a multi-factor proof of its own and never stops at a second step.
  if (attempt.proven.includes('passkey')) {
    attempt.status = 'complete'
    return
  }
  const { options, enrol } = secondFactorsFor(world, user)
  if (options.length > 0) {
    attempt.status = 'needs_second_factor'
    attempt.secondFactors = options
  } else if (enrol) {
    attempt.status = 'needs_factor_enrolment'
  } else {
    attempt.status = 'complete'
  }
}

/**
 * Finish an attempt that reached `complete`: start the session and hand over its tokens once.
 *
 * @param world - The sandbox.
 * @param attempt - The attempt.
 * @param client - The kind of client.
 * @param extra - More members for the answer (backup codes of an enrolment).
 * @returns The answer.
 */
export function finish(
  world: World,
  attempt: SandboxAttempt,
  client: Schemas['SessionClient'],
  extra: Partial<Schemas['FlowAttempt']> = {}
): Schemas['FlowAttempt'] {
  const user = world.users.get(attempt.userId ?? '')
  if (!user) {
    throw new SandboxError('flow.invalid_step')
  }
  if (attempt.sessionId === null) {
    const amr = [...new Set(attempt.proven)]
    const session = world.createSession(user, client, amr)
    attempt.sessionId = session.id
  }
  const session = world.sessions.get(attempt.sessionId)
  if (!session) {
    throw new SandboxError('flow.invalid_step')
  }
  world.changed()
  return attemptBody(world, attempt, { ...extra, session: tokensFor(world, session, client) })
}

/**
 * The answer after a step: tokens when the attempt is complete, the next step otherwise.
 *
 * @param world - The sandbox.
 * @param attempt - The attempt.
 * @param client - The kind of client.
 * @param extra - More members for the answer.
 * @returns The answer.
 */
export function advance(
  world: World,
  attempt: SandboxAttempt,
  client: Schemas['SessionClient'],
  extra: Partial<Schemas['FlowAttempt']> = {}
): Schemas['FlowAttempt'] {
  return attempt.status === 'complete'
    ? finish(world, attempt, client, extra)
    : attemptBody(world, attempt, extra)
}

/**
 * The provider names for the strategy `oauth_<provider>`.
 *
 * @param provider - A provider.
 * @returns The strategy.
 */
export function oauthStrategy(provider: SandboxProvider): Schemas['FirstFactorStrategy'] {
  return `oauth_${provider}` as Schemas['FirstFactorStrategy']
}

/**
 * Look a user up by address, case-insensitively.
 *
 * @param world - The sandbox.
 * @param address - The address.
 * @returns The account, if any.
 */
export function userByEmail(world: World, address: string): SandboxUser | undefined {
  return world.findUserByEmail(normalizeEmail(address))
}
