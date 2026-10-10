import type { EnvironmentSettings } from '@tula/contract'
import type { Deps, Tenant } from '~/dependencies'
import { deviceFamily } from '~/lib/device'
import * as logger from '~/lib/logger'
import { describeMailFailure } from '~/lib/safe-error'
import * as Email from '~/modules/email/service'
import type {
  IdentityChangedMessage,
  MfaChangedMessage,
  PasswordChangedMessage,
  SecurityNoticeMessage,
} from '~/modules/email/templates'
import * as Settings from '~/modules/settings/service'
import type { UserRecord } from '~/ports/user-repository'

/**
 * Security notices of one kind a user is emailed per hour, in one environment.
 *
 * Notices have their own allowance, apart from the verification-code send limits (ADR 0007), so
 * that neither can use the other up: a burst of sign-ins or password changes cannot flood an
 * inbox, and it cannot stop the owner from being sent a reset code either. Three is enough to
 * tell the owner something is happening; the fourth email in an hour would tell them nothing new.
 */
export const NOTICES_PER_HOUR = 3

/** The window {@link NOTICES_PER_HOUR} is counted in, in milliseconds. */
export const NOTICE_WINDOW_MS = 3_600_000

/**
 * The most distinct devices of a user's earlier sessions a sign-in is compared with. Past it
 * the oldest are not looked at, so a family last used long ago can be announced again: the
 * error is on the side of telling the owner.
 */
export const KNOWN_DEVICES_LIMIT = 200

type Scope = Pick<Tenant, 'environmentId'>
type NoticeKind = SecurityNoticeMessage['type']
type SendDeps = Pick<Deps, 'mailer' | 'environmentSettings' | 'config' | 'rateLimiter'>

/** The settings switch of each notice. */
const SWITCHES: Record<NoticeKind, keyof EnvironmentSettings['notifications']> = {
  password_changed: 'passwordChanged',
  new_sign_in: 'newSignIn',
  mfa_changed: 'mfaChanged',
  identity_changed: 'identityChanged',
}

// Notices still on their way to the relay. Module state, not a dependency: a notice outlives
// the request that caused it, and shutdown and tests need to wait for all of them.
const pending = new Set<Promise<void>>()

/**
 * Rate-limiter key of a user's allowance for one kind of notice.
 *
 * A two-step verification notice has an allowance **per change** (turned on, turned off, reset
 * by an administrator, new backup codes, a backup code used): they are different events, and
 * one must not be able to use up another's. Otherwise three harmless ones (enrol, use a backup
 * code, make new codes) would silence the one that matters most, "an administrator reset your
 * two-step verification" or "it was turned off".
 *
 * @param kind - The notice.
 * @param scope - The environment.
 * @param userId - The user. An id, never an address: limiter keys may live in Redis.
 * @param change - For `mfa_changed`: which change the notice is about.
 * @returns The bucket key.
 */
export function limitKey(
  kind: NoticeKind,
  scope: Scope,
  userId: string,
  change?: MfaChangedMessage['change'] | IdentityChangedMessage['change']
): string {
  return `notice_${kind}${change ? `.${change}` : ''}:${scope.environmentId}:${userId}`
}

/**
 * Run a notice in the background and never let it fail anything.
 *
 * The caller has already committed what the notice describes and must answer its client now, so
 * the task is not awaited: a slow relay delays no sign-in, and whatever the task throws ends in
 * one log line. The line has the error's name and codes only (`describeMailFailure`): never the
 * message, which can quote the address, and never the address itself.
 */
function dispatch(kind: NoticeKind, scope: Scope, userId: string, task: () => Promise<void>): void {
  const run = (async () => {
    try {
      await task()
    } catch (error) {
      logger.warn('security notice not sent', {
        notice: kind,
        environmentId: scope.environmentId,
        userId,
        reason: describeMailFailure(error),
      })
    }
  })()
  pending.add(run)
  void run.finally(() => pending.delete(run))
}

/**
 * Wait until every notice started so far has been sent or given up on.
 *
 * Used when the server shuts down, and by tests before they look at the outbox.
 *
 * @returns Once nothing is on its way.
 */
export async function settled(): Promise<void> {
  while (pending.size > 0) {
    await Promise.all(pending)
  }
}

/** Whether the environment has this notice switched on. */
async function enabled(deps: SendDeps, scope: Scope, kind: NoticeKind): Promise<boolean> {
  return (await Settings.current(deps, scope)).notifications[SWITCHES[kind]]
}

/**
 * Send a notice, if the user's allowance for its kind has room.
 *
 * Every other limiter in the API fails closed: when it cannot count, the request is refused.
 * Here the opposite end is closed: **a limiter that cannot count means no notice**, because the
 * alternative is unbounded email. The limiter's failure reaches {@link dispatch} and is logged.
 */
async function deliver(
  deps: SendDeps,
  scope: Scope,
  user: Pick<UserRecord, 'id' | 'email'>,
  message: SecurityNoticeMessage
): Promise<void> {
  const { email } = user
  if (email === null) {
    // An account made by a provider Tula takes no address from (ADR 0026) has nowhere a
    // notice could go. Said here, by id, because the change it describes went unannounced.
    logger.info('security notice skipped: the account has no email address', {
      notice: message.type,
      environmentId: scope.environmentId,
      userId: user.id,
    })
    return
  }
  const decision = await deps.rateLimiter.hit(
    limitKey(
      message.type,
      scope,
      user.id,
      message.type === 'mfa_changed' || message.type === 'identity_changed'
        ? message.change
        : undefined
    ),
    NOTICES_PER_HOUR,
    NOTICE_WINDOW_MS
  )
  if (!decision.allowed) {
    logger.info('security notice skipped: the hourly limit for this user is reached', {
      notice: message.type,
      environmentId: scope.environmentId,
      userId: user.id,
    })
    return
  }
  await Email.send(deps, scope, email, message)
}

/**
 * Tell an account's owner that its password was changed, reset, set by an administrator,
 * added, or removed when they first proved the address by an emailed sign-in (`by:
 * 'verification'`, ADR 0024), so that a takeover does not go unnoticed (ADR 0023).
 *
 * Call it **after the change is stored**. It returns at once and never throws: the email
 * is sent in the background, at most {@link NOTICES_PER_HOUR} an hour per user, and only when the
 * environment has `notifications.passwordChanged` on. A relay, limiter or settings failure is
 * logged and changes nothing for the caller. Sending is not an audited action.
 *
 * @param deps - Mailer, settings store, config and rate limiter.
 * @param scope - The environment.
 * @param user - The account, with the address it had when the password was stored.
 * @param change - Who changed it, whether it was the account's first password, and when.
 *
 * @example
 * ```ts
 * Notices.passwordChanged(deps, scope, user, { by: 'reset', added: false, at: deps.clock.now() })
 * ```
 */
export function passwordChanged(
  deps: SendDeps,
  scope: Scope,
  user: Pick<UserRecord, 'id' | 'email'>,
  change: Pick<PasswordChangedMessage, 'by' | 'added' | 'at'>
): void {
  dispatch('password_changed', scope, user.id, async () => {
    if (await enabled(deps, scope, 'password_changed')) {
      await deliver(deps, scope, user, { type: 'password_changed', ...change })
    }
  })
}

/**
 * Tell an account's owner that its two-step verification changed: turned on, turned off, reset
 * by an administrator, backup codes replaced, or a backup code used to sign in (ADR 0025).
 *
 * Call it **after the change is stored**. It returns at once and never throws: the email is
 * sent in the background, at most {@link NOTICES_PER_HOUR} an hour per user, and only when the
 * environment has `notifications.mfaChanged` on. The email never carries a secret or a code.
 *
 * @param deps - Mailer, settings store, config and rate limiter.
 * @param scope - The environment.
 * @param user - The account.
 * @param change - What happened, when, and (for a used backup code) how many are left.
 *
 * @example
 * ```ts
 * Notices.mfaChanged(deps, scope, user, { change: 'enabled', at: deps.clock.now() })
 * ```
 */
export function mfaChanged(
  deps: SendDeps,
  scope: Scope,
  user: Pick<UserRecord, 'id' | 'email'>,
  change: Pick<MfaChangedMessage, 'change' | 'at' | 'remaining'>
): void {
  dispatch('mfa_changed', scope, user.id, async () => {
    if (await enabled(deps, scope, 'mfa_changed')) {
      await deliver(deps, scope, user, { type: 'mfa_changed', ...change })
    }
  })
}

/**
 * Tell an account's owner that a provider account was connected to it or disconnected from it
 * (ADR 0026): a new way in, or one fewer.
 *
 * Call it **after the change is stored**. It returns at once and never throws: the email is sent
 * in the background, at most {@link NOTICES_PER_HOUR} an hour per user and kind of change, and
 * only when the environment has `notifications.identityChanged` on. It names the provider and
 * nothing of the provider account.
 *
 * @param deps - Mailer, settings store, config and rate limiter.
 * @param scope - The environment.
 * @param user - The account.
 * @param change - What changed, for which provider, and when.
 *
 * @example
 * ```ts
 * Notices.identityChanged(deps, scope, user, { change: 'linked', provider: 'google', at })
 * ```
 */
export function identityChanged(
  deps: SendDeps,
  scope: Scope,
  user: Pick<UserRecord, 'id' | 'email'>,
  change: Pick<IdentityChangedMessage, 'change' | 'provider' | 'at'>
): void {
  dispatch('identity_changed', scope, user.id, async () => {
    if (await enabled(deps, scope, 'identity_changed')) {
      await deliver(deps, scope, user, { type: 'identity_changed', ...change })
    }
  })
}

// An IPv4 address as a dual-stack socket reports it: `::ffff:203.0.113.7`.
const MAPPED_IPV4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i

/** An address as its owner would recognise it: an IPv4-mapped IPv6 address is shown as IPv4. */
function readable(ipAddress: string | null): string | null {
  return ipAddress?.replace(MAPPED_IPV4, '$1') ?? null
}

/**
 * Tell an account's owner about a sign-in from a device the account has not been seen on.
 *
 * Call it **after the session exists**, and only for a session a sign-in created: the session a
 * sign-up or a password reset ends in is not announced (the owner has just verified the address,
 * or is sent the password notice). It returns at once and never throws.
 *
 * "New" is decided from the session table, among the sessions of the user that began before
 * this one, active or ended, that are still in the table:
 *
 * - **a session that is not bound to a device key**: its {@link deviceFamily} (browser and
 *   operating system, or the native platform) is the family of none of them;
 * - **a session bound to a device key** (ADR 0043): none of them was bound to that key. The
 *   family is not asked: two phones of one platform are one family and two keys. A key is
 *   made by an installation of an app, so the first sign-in after a reinstall, and the first
 *   one of a version of the app that begins to bind, is announced. That is on purpose.
 *
 * An account with no earlier session gets no notice, so neither does its first-ever sign-in. Of sessions that began in the same instant one is the earlier, so two
 * racing sign-ins from one new device send one notice, not none. The limits of this definition
 * are in ADR 0023.
 *
 * The email shows the family (one of the fixed names, never the user agent), the time in UTC
 * and the IP address the session was created from, for a bound session too: nothing of a key
 * is in it, and its wording does not depend on the binding. At most {@link NOTICES_PER_HOUR} an hour per
 * user, and only when the environment has `notifications.newSignIn` on.
 *
 * @param deps - Mailer, settings store, config, rate limiter, sessions and users.
 * @param scope - The environment.
 * @param session - The session that was just created, and its user.
 *
 * @example
 * ```ts
 * const tokens = await Sessions.create(deps, tenant, input)
 * Notices.newSignIn(deps, tenant, { userId: input.userId, sessionId: tokens.sessionId })
 * ```
 */
export function newSignIn(
  deps: SendDeps & Pick<Deps, 'sessions' | 'users'>,
  scope: Scope,
  session: { userId: string; sessionId: string }
): void {
  dispatch('new_sign_in', scope, session.userId, async () => {
    if (!(await enabled(deps, scope, 'new_sign_in'))) {
      return
    }
    const created = await deps.sessions.findById(scope.environmentId, session.sessionId)
    if (!created || created.userId !== session.userId) {
      return
    }
    const earlier = await deps.sessions.listDevicesBefore(
      scope.environmentId,
      created.userId,
      created,
      KNOWN_DEVICES_LIMIT
    )
    const device = deviceFamily(created.client, created.userAgent)
    if (earlier.length === 0) {
      return
    }
    // A session bound to a device key is known by its key (ADR 0043): the family says only
    // what kind of device it is, and every phone of one platform is the same family. A
    // session that is not bound is known by its family, as it always was.
    const known =
      created.deviceThumbprint === null
        ? earlier.some((seen) => deviceFamily(seen.client, seen.userAgent) === device)
        : await deps.sessions.hasBoundSessionBefore(
            scope.environmentId,
            created.userId,
            created,
            created.deviceThumbprint
          )
    if (known) {
      return
    }
    const user = await deps.users.findById(scope.environmentId, created.userId)
    if (user) {
      await deliver(deps, scope, user, {
        type: 'new_sign_in',
        device,
        at: created.createdAt,
        ipAddress: readable(created.ipAddress),
      })
    }
  })
}
