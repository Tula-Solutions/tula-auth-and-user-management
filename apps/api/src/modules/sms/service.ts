import {
  durationToMs,
  parsePhoneNumber,
  phoneNumberPrefix,
  SMS_USAGE_MAX_PREFIXES,
  type SmsUsage,
} from '@tula/contract'
import type { Deps, Tenant } from '~/dependencies'
import { AuthError, RateLimitError, ServiceException, ServiceUnavailableError } from '~/exceptions'
import * as logger from '~/lib/logger'
import { errorReason } from '~/lib/safe-error'
import * as Settings from '~/modules/settings/service'
import { type SmsFailureReason, SmsSendError } from '~/ports/sms-sender'
import { codeText } from './templates'

// The one path a text message takes (ADR 0037). A message costs the operator money, and an
// endpoint that sends one to a number of the caller's choosing is what SMS pumping abuses:
// so everything that decides whether a message goes, and everything that counts it, is here
// and nowhere else. A caller says who asks and where to; it brings no limit of its own.

/** The gap between two codes for one asker, and between two codes to one number. */
export const SMS_COOLDOWN = '1m'

/** Codes one asker may be texted in an hour, in one environment. */
export const SMS_ASKER_PER_HOUR = 5

/**
 * Numbers **new to them** one asker may have a code texted to in 24 hours, in one
 * environment. A number is new when it is not the one the asker was last being texted at
 * (the caller says: {@link CodeMessage.newNumber}).
 *
 * This is what keeps one account from working through other people's numbers: without it an
 * account could text {@link SMS_ASKER_PER_HOUR} strangers an hour, each of whom is then
 * closer to their own number's hourly limit.
 */
export const SMS_NEW_NUMBERS_PER_DAY = 3

/** Codes one number may be texted in an hour, in one environment, whoever asks. */
export const SMS_NUMBER_PER_HOUR = 5

/**
 * Codes that may be asked for from one address (as the per-IP request limits read it: the
 * address for IPv4, the /64 for IPv6) in an hour, in one environment, whoever asks and
 * whatever the number. Above one asker's hourly allowance, because an office or a carrier
 * shares an address.
 */
export const SMS_ADDRESS_PER_HOUR = 20

/**
 * What share of the day's limit one destination prefix (the contract's `phoneNumberPrefix`:
 * a country calling prefix) may take in an hour: a tenth. Numbers bought to be texted are
 * numbers of one destination, and one destination must not be able to spend the day in less
 * than ten hours. In an environment that texts one country this is the hourly limit that
 * binds.
 */
export const SMS_PREFIX_HOURLY_SHARE = 10

/**
 * What share of the day's limit the whole environment may send in an hour: a quarter. A day's
 * allowance then takes at least four hours to spend, which is time to notice.
 */
export const SMS_ENVIRONMENT_HOURLY_SHARE = 4

/** Keyed-hash purpose of the limiter keys that would otherwise hold a number or an address. */
export const SMS_LIMIT_HASH_PURPOSE = 'sms-send-limits'

/**
 * Which limit refused a message. A fixed word for the operator's log; the caller is told
 * `rate_limited` and how long to wait, and never which.
 */
export type SmsLimit =
  | 'asker'
  | 'new_number'
  | 'number'
  | 'address'
  | 'prefix'
  | 'environment'
  | 'daily'

/** The limits whose refusals an operator should see without looking for them. */
const COST_LIMITS: ReadonlySet<SmsLimit> = new Set(['prefix', 'environment', 'daily'])

/**
 * Who asked for a code: an id the server made, never anything a request chose.
 *
 * - `user`: a signed-in user, by their id (adding a phone number).
 * - `sign_in`: a sign-in with a texted code, which has no user. Its id is
 *   {@link signInAsker}: a keyed hash of the identifier being signed in to. **Never the
 *   attempt's id**: an attempt costs nothing to start, so an asker per attempt would be a
 *   fresh allowance per request. An asker per identifier cannot be had without choosing
 *   another number, and that number has its own limits. It follows that the per-asker
 *   limits of a sign-in bound nothing the per-number limits do not already bound: what
 *   bounds someone who is not signed in is the number, the address, the destination prefix,
 *   the environment and the day (ADR 0037, "The asker of a sign-in").
 * - `second_factor`: a user being texted the code of their second factor (at a sign-in past
 *   its first factor, a step-up, or its enrolment), by their id. An allowance of its own,
 *   apart from `user`'s: adding a number must not use up the codes a sign-in needs, nor the
 *   other way round. The number's own limits are shared, as they are by every asker.
 */
export interface SmsAsker {
  type: 'user' | 'sign_in' | 'second_factor'
  id: string
}

/**
 * The asker of a sign-in with a texted code: the identifier it was started with, as a keyed
 * hash that also covers the environment.
 *
 * @param deps - The keyed hash.
 * @param environmentId - The environment.
 * @param identifier - What the sign-in was started with: a number in E.164 form, or
 *   whatever else was typed (which is never sent to).
 * @returns The asker. The same for every attempt at one identifier.
 */
export async function signInAsker(
  deps: Pick<Deps, 'keyedHash'>,
  environmentId: string,
  identifier: string
): Promise<SmsAsker> {
  return {
    type: 'sign_in',
    id: await deps.keyedHash.hmac(
      SMS_LIMIT_HASH_PURPOSE,
      `${environmentId}:sign-in-asker:${identifier}`
    ),
  }
}

/** What a code message needs, and what its limits are counted by. */
export interface CodeMessage {
  /** Recipient, in E.164 form. */
  to: string
  /** The code. */
  code: string
  /** Who asked. */
  asker: SmsAsker
  /**
   * Whether `to` is a number this asker was **not** already being texted at: the caller
   * knows (its pending code is for another number, or there is none). Such a send is also
   * counted under {@link SMS_NEW_NUMBERS_PER_DAY}.
   */
  newNumber: boolean
  /**
   * The address the request came from, as `ipBucket(clientIp(c, …))` gives it, or `null` for
   * a send no request asked for. `null` leaves out the per-address limit and nothing else.
   */
  address: string | null
  /**
   * Hand the message to the sender **without waiting for its answer** ({@link sendCode},
   * "A detached send"). For a sign-in, where how long the provider takes, and whether it
   * took the message, must not be something the caller can see: an unknown number sends
   * nothing ({@link DecoyMessage}) and has to answer the same. Left out, the send is waited
   * for and its failure is the caller's `sms.unavailable`.
   */
  detached?: boolean
  /**
   * For a detached send: run once the sender **took** the message, and not at all when it
   * did not (`failed`) or nothing says whether it did (`unconfirmed`). A sign-in stores its
   * code's token here, so a code that never left cannot be guessed against and an earlier
   * one keeps working. A failure of it is logged with fixed words and reaches nobody.
   */
  onTaken?: () => Promise<void>
}

/**
 * A message that is **never sent**: what a sign-in with a texted code asks for when no
 * account can be signed in to with the identifier (nobody holds the number, several do, its
 * proof is too old, or it is no number at all).
 *
 * It goes through everything that could refuse a real message, in the same order and under
 * the same keys, so that nothing the caller can observe tells it from one: the settings, the
 * sender, every limit the rate limiter keeps, and the day's limit, which it is refused by
 * when the day is spent and **does not take from** (ADR 0037, "An unknown number").
 */
export interface DecoyMessage {
  decoy: true
  /**
   * What the sign-in was started with. A number in E.164 form is limited as that number;
   * anything else has no destination prefix and is limited without one.
   */
  identifier: string
  /** Who asked: {@link signInAsker}. */
  asker: SmsAsker
  /** As {@link CodeMessage.address}. */
  address: string | null
  /**
   * Run after every refusal has been passed, **without being waited for**, as
   * {@link CodeMessage.onTaken} is for a message: a sign-in stores the decoy's token here,
   * so that the request does the same work before it answers for either kind of number.
   */
  onTaken?: () => Promise<void>
}

/** The limits one daily limit gives an environment. */
export interface SmsCostLimits {
  /** Messages an hour to the numbers of one destination prefix. */
  prefixPerHour: number
  /** Messages an hour, whatever the destination. */
  environmentPerHour: number
  /** Messages in one UTC day: the environment's `sms.dailyMessageLimit`. */
  perDay: number
}

/**
 * The limits that bound what an environment's SMS can cost, from its one setting.
 *
 * @param dailyMessageLimit - The environment's `sms.dailyMessageLimit`.
 * @returns The hourly limits per prefix and per environment (shares of the day's, rounded
 *   up, never below one) and the day's. A value that is not a whole number of at least one
 *   (nothing the API stores) reads as one: a broken setting must send less, never more.
 */
export function limitsOf(dailyMessageLimit: number): SmsCostLimits {
  const perDay =
    Number.isInteger(dailyMessageLimit) && dailyMessageLimit >= 1 ? dailyMessageLimit : 1
  return {
    prefixPerHour: Math.ceil(perDay / SMS_PREFIX_HOURLY_SHARE),
    environmentPerHour: Math.ceil(perDay / SMS_ENVIRONMENT_HOURLY_SHARE),
    perDay,
  }
}

/** The UTC day of an instant, as `YYYY-MM-DD`. */
function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10)
}

const DAY_MS = 86_400_000

/**
 * Refuse a request that would send a message from a deployment that has no sender.
 *
 * Called after `Settings.requireSms` and **before any send limit is counted**: a try that
 * can only fail must not use up the user's, or the number's, allowance. One log line for the
 * operator, the same as for a send that failed.
 *
 * @param deps - The SMS sender.
 * @param tenant - The environment, for the log line.
 * @throws AuthError `sms.unavailable` when the deployment has no sender.
 */
export function requireSender(
  deps: Pick<Deps, 'sms'>,
  tenant: Pick<Tenant, 'environmentId'>
): void {
  if (!deps.sms.configured) {
    logger.warn('text message not sent', {
      environmentId: tenant.environmentId,
      reason: 'not_configured' satisfies SmsFailureReason,
    })
    throw new AuthError('sms.unavailable')
  }
}

type LimitDeps = Pick<Deps, 'rateLimiter' | 'keyedHash'>

/** What the limiter's counters are keyed by: the same for a message and for a decoy. */
interface Limited {
  /** The number in E.164 form, or what was typed in place of one. */
  to: string
  asker: SmsAsker
  /** Never set for a sign-in: its asker is its number (see {@link SmsAsker}). */
  newNumber: boolean
  address: string | null
}

/** One counter of the limiter: its key, how many it allows and for how long. */
interface Counter {
  limit: SmsLimit
  key: string
  allowed: number
  window: string
}

/**
 * Say in the operator's log that a limit refused a message: which limit, and for which
 * environment. Never the number, its prefix or the address. A limit that bounds cost is a
 * warning: it may be an attack.
 */
function logRefusal(environmentId: string, limit: SmsLimit): void {
  const log = COST_LIMITS.has(limit) ? logger.warn : logger.info
  log('text message not sent', { environmentId, reason: 'limit', limit })
}

/**
 * Count one message against every limit the rate limiter keeps, from the narrowest to the
 * widest, and refuse it at the first that is spent.
 *
 * Narrowest first, so that a send one asker's or one number's limit refuses is never counted
 * against the environment's hour: whoever hammers one number cannot spend everybody's
 * allowance with tries that send nothing. A limiter that cannot count throws
 * (`service.unavailable`), and nothing is sent.
 */
async function enforceLimits(
  deps: LimitDeps,
  environmentId: string,
  message: Limited,
  prefix: string | null,
  limits: SmsCostLimits
): Promise<void> {
  // Keyed hashes: limiter keys may live in Redis, a number is personal data, an address too,
  // and a prefix beside the other keys of one send would narrow a number down. Each covers
  // the environment, so no value can be followed from one environment to another.
  const hashed = (kind: string, value: string) =>
    deps.keyedHash.hmac(SMS_LIMIT_HASH_PURPOSE, `${environmentId}:${kind}:${value}`)
  const asker = `${environmentId}:${message.asker.type}:${message.asker.id}`
  const number = `${environmentId}:${await hashed('number', message.to)}`
  const counters: Counter[] = [
    { limit: 'asker', key: `sms_asker_cooldown:${asker}`, allowed: 1, window: SMS_COOLDOWN },
    { limit: 'asker', key: `sms_asker:${asker}`, allowed: SMS_ASKER_PER_HOUR, window: '1h' },
  ]
  if (message.newNumber) {
    counters.push({
      limit: 'new_number',
      key: `sms_asker_new_number:${asker}`,
      allowed: SMS_NEW_NUMBERS_PER_DAY,
      window: '24h',
    })
  }
  counters.push(
    { limit: 'number', key: `sms_number_cooldown:${number}`, allowed: 1, window: SMS_COOLDOWN },
    { limit: 'number', key: `sms_number:${number}`, allowed: SMS_NUMBER_PER_HOUR, window: '1h' }
  )
  if (message.address !== null) {
    counters.push({
      limit: 'address',
      key: `sms_address:${environmentId}:${await hashed('address', message.address)}`,
      allowed: SMS_ADDRESS_PER_HOUR,
      window: '1h',
    })
  }
  if (prefix !== null) {
    // Left out only for what is no number at all, which could never be sent to.
    counters.push({
      limit: 'prefix',
      key: `sms_prefix:${environmentId}:${await hashed('prefix', prefix)}`,
      allowed: limits.prefixPerHour,
      window: '1h',
    })
  }
  counters.push({
    limit: 'environment',
    key: `sms_environment:${environmentId}`,
    allowed: limits.environmentPerHour,
    window: '1h',
  })
  for (const counter of counters) {
    const decision = await deps.rateLimiter.hit(
      counter.key,
      counter.allowed,
      durationToMs(counter.window)
    )
    if (!decision.allowed) {
      logRefusal(environmentId, counter.limit)
      // For the caller: the one answer every limit gives.
      throw new RateLimitError(decision.retryAfterMs)
    }
  }
}

/**
 * Take one message of the environment's day, or refuse it when the day is spent.
 *
 * The day's count is the one the usage store keeps (`sms_code_counts`), not the rate
 * limiter's: it is in the database, so every instance counts on it with or without Redis and
 * a restart forgets nothing. Reading it and adding to it are one step of the store
 * (`SmsUsageStore.takeFromDay`), so two sends at once cannot both take the day's last
 * message. It is not done under `deps.environmentLock`: that lock's holder keeps one
 * database connection while its work waits for another, which is fine for an administrator's
 * rare write and, on a path any signed-in user reaches, a way for enough sends at once to
 * leave every connection held by a sender waiting for one. **A count that cannot be read or
 * written sends nothing.**
 *
 * @returns The UTC day the message was counted on.
 */
async function takeFromDay(
  deps: Pick<Deps, 'smsUsage' | 'clock'>,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  prefix: string,
  perDay: number
): Promise<string> {
  const now = deps.clock.now()
  const day = utcDay(now)
  let taken: boolean
  try {
    taken = await deps.smsUsage.takeFromDay(
      { projectId: tenant.projectId, environmentId: tenant.environmentId },
      day,
      prefix,
      perDay,
      now
    )
  } catch (error) {
    if (error instanceof ServiceException) {
      throw error
    }
    logger.warn('text message not sent', {
      environmentId: tenant.environmentId,
      reason: 'not_counted',
      err: errorReason(error),
    })
    throw new ServiceUnavailableError({ internalMessage: 'the SMS counts could not be written' })
  }
  if (!taken) {
    logRefusal(tenant.environmentId, 'daily')
    // The day ends at midnight UTC, whenever its first message was sent.
    throw new RateLimitError(DAY_MS - (now.getTime() % DAY_MS))
  }
  return day
}

/**
 * Text a verification code to a number: the **one** way a text message leaves the server.
 *
 * In this order, and a message refused at one step is counted by none of the later ones:
 *
 * 1. the environment's settings (`Settings.requireSms`): SMS on, and the number's country
 *    on the allow-list. Nothing is counted for a number that is never sent to;
 * 2. the deployment has a sender ({@link requireSender});
 * 3. the send limits the rate limiter keeps, narrowest first: per asker (one a minute,
 *    {@link SMS_ASKER_PER_HOUR} an hour, {@link SMS_NEW_NUMBERS_PER_DAY} new numbers a day),
 *    per number (one a minute, {@link SMS_NUMBER_PER_HOUR} an hour), per address
 *    ({@link SMS_ADDRESS_PER_HOUR} an hour), per destination prefix and per environment
 *    (hourly shares of the day's limit: {@link limitsOf});
 * 4. the environment's daily limit (`sms.dailyMessageLimit`, per UTC day), counted in the
 *    database with the codes sent to the prefix;
 * 5. the send, in the words and with the app name of the environment
 *    (`modules/sms/templates.ts`).
 *
 * **A limit is counted when it is reached, so a send a later step refuses has still been
 * counted by the earlier ones.** A user turned away by the prefix's or the environment's
 * hour, or by a spent day, has used their minute, one of their hour's tries and, for a new
 * number, one of the day's new numbers. That is the price of the order, and the order is
 * the point: counted the other way round, one asker's refused tries would use up the
 * allowance everyone shares.
 *
 * Every limit answers the same `rate_limited`; which one it was is in the operator's log.
 * **A limiter or a count that cannot count sends nothing** (`service.unavailable`): no limit
 * on this path lets a message through uncounted. A message the sender did not take stays
 * counted by the limiter (the provider needs the breathing room, and a send that fails for
 * one number must not be a free retry loop), is taken back out of the day and of the codes
 * sent, and is `sms.unavailable` (503) for the caller, with one log line: the sender's fixed
 * word and the environment, never the number, the code or the text.
 *
 * **A send whose outcome is unknown stays counted.** When the sender says `unconfirmed` (no
 * answer says the provider refused: a deadline, a connection that died, a 5xx), or throws anything
 * that is not the port's error, the message may have gone out and been billed. The caller
 * gets the same `sms.unavailable`, and the day's count and the codes sent are **not** taken
 * back (the log line says `count: 'kept'`). Only `failed` and `not_configured`, which say
 * the message did not go, give a message back to the day.
 *
 * **A detached send** ({@link CodeMessage.detached}, a sign-in's). Everything up to and
 * including the day's take happens before this returns, and refuses as above. The message is
 * then handed to the sender and **not waited for**: a failure is logged and counted exactly
 * as above (taken back out of the day for `failed`, kept for `unconfirmed`), and the caller
 * is told nothing of it. {@link CodeMessage.onTaken} runs only after the sender took the
 * message. A sign-in must answer the same, and as fast, for a number that is
 * sent to and for one that is not, and a provider's latency or refusal would tell the two
 * apart. The cost: the person signing in is not told that the message could not be sent.
 *
 * **A decoy** ({@link DecoyMessage}) sends nothing and takes nothing from the day; it is
 * refused by every step that would refuse a message, the spent day included.
 *
 * @param deps - Settings, the SMS sender, the limiter, the keyed hash, the counts and the
 *   clock.
 * @param tenant - The environment the code is for.
 * @param message - The recipient, the code, and who asked from where; or a decoy.
 * @throws AuthError `sms.disabled` or `sms.country_not_allowed` (the settings),
 *   `sms.unavailable` (no sender, the sender did not take the message, or nothing says
 *   whether it did).
 * @throws RateLimitError when a limit, or the daily limit, is spent.
 * @throws ServiceUnavailableError when the limiter or the counts cannot count.
 *
 * @example
 * ```ts
 * await Sms.sendCode(deps, tenant, {
 *   to: '+14155550100',
 *   code: '123456',
 *   asker: { type: 'user', id: userId },
 *   newNumber: true,
 *   address: ipBucket(clientIp(c, deps.config.trustProxy)),
 * })
 * ```
 */
export async function sendCode(
  deps: Pick<
    Deps,
    'sms' | 'smsUsage' | 'rateLimiter' | 'keyedHash' | 'clock' | 'environmentSettings' | 'config'
  >,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  message: CodeMessage | DecoyMessage
): Promise<void> {
  const decoy = 'decoy' in message
  // A decoy's identifier may be no number at all (an email address typed where a number
  // belongs): then only the switch is asked, and there is no prefix to limit by.
  const number = decoy ? parsePhoneNumber(message.identifier) : message.to
  await Settings.requireSms(deps, tenant, number ?? undefined)
  requireSender(deps, tenant)
  const prefix = number === null ? null : phoneNumberPrefix(number)
  if (number !== null && prefix === null) {
    // What `requireSms` has refused already: a number of no destination is never sent to.
    throw new AuthError('sms.country_not_allowed')
  }
  const { app, urls, sms } = await Settings.current(deps, tenant)
  const limits = limitsOf(sms.dailyMessageLimit)
  const limited: Limited = decoy
    ? {
        to: number ?? message.identifier,
        asker: message.asker,
        newNumber: false,
        address: message.address,
      }
    : message
  await enforceLimits(deps, tenant.environmentId, limited, prefix, limits)
  if (decoy || prefix === null) {
    // Refused by a spent day exactly as a message would be, and counted by nothing: no
    // message goes, so none is taken from the day (see `DecoyMessage`).
    await requireDayNotSpent(deps, tenant, limits.perDay)
    if (decoy && message.onTaken) {
      detach(tenant.environmentId, Promise.resolve(), message.onTaken)
    }
    return
  }
  const day = await takeFromDay(deps, tenant, prefix, limits.perDay)
  const text = codeText({
    appName: app.name,
    allowedOrigins: urls.allowedOrigins,
    code: message.code,
  })
  const sent = dispatch(deps, tenant, { to: message.to, prefix, text, day })
  if (message.detached) {
    // Started, never awaited, and it cannot reject: what the sender does with the message
    // is in the log and the counts, not in this caller's answer or its timing.
    detach(tenant.environmentId, sent, message.onTaken)
    return
  }
  await sent
}

/** Detached sends still on their way, so that tests can wait for them. */
const detached = new Set<Promise<void>>()

/**
 * Let a send finish by itself. The promise kept cannot reject: a send that failed has
 * logged its fixed words in {@link dispatch} and is done; `onTaken` runs only after one that
 * did not fail, and whatever it throws is logged by name and goes no further.
 */
function detach(
  environmentId: string,
  sent: Promise<void>,
  onTaken: (() => Promise<void>) | undefined
): void {
  const run = sent
    .then(
      () => true,
      () => false
    )
    .then(async (taken) => {
      if (!taken || !onTaken) {
        return
      }
      try {
        await onTaken()
      } catch (error) {
        // The error's name and never its message: a store's own text may quote the number.
        logger.warn('texted code not stored', {
          environmentId,
          err: error instanceof Error ? error.name : 'unknown',
        })
      }
    })
  detached.add(run)
  void run.finally(() => detached.delete(run))
}

/**
 * Wait for every detached send that has been started ({@link CodeMessage.detached}).
 *
 * For tests: a detached send's message, its log line and a count taken back are there only
 * once this resolves.
 *
 * @returns Once none is left on its way.
 */
export async function settled(): Promise<void> {
  while (detached.size > 0) {
    await Promise.all(detached)
  }
}

/**
 * Refuse a decoy on a day that is spent, as {@link takeFromDay} refuses a message, and
 * count nothing. A count that cannot be read refuses too: a decoy must not answer where a
 * message could not have.
 */
async function requireDayNotSpent(
  deps: Pick<Deps, 'smsUsage' | 'clock'>,
  tenant: Pick<Tenant, 'environmentId'>,
  perDay: number
): Promise<void> {
  const now = deps.clock.now()
  let sent: number
  try {
    sent = await deps.smsUsage.sentOn(tenant.environmentId, utcDay(now))
  } catch (error) {
    if (error instanceof ServiceException) {
      throw error
    }
    logger.warn('text message not sent', {
      environmentId: tenant.environmentId,
      reason: 'not_counted',
      err: errorReason(error),
    })
    throw new ServiceUnavailableError({ internalMessage: 'the SMS counts could not be read' })
  }
  if (sent >= perDay) {
    logRefusal(tenant.environmentId, 'daily')
    throw new RateLimitError(DAY_MS - (now.getTime() % DAY_MS))
  }
}

/**
 * Hand one counted message to the sender, and settle the counts by what it says.
 *
 * @throws AuthError `sms.unavailable` when the sender did not take the message, or nothing
 *   says whether it did.
 */
async function dispatch(
  deps: Pick<Deps, 'sms' | 'smsUsage' | 'clock'>,
  tenant: Pick<Tenant, 'environmentId'>,
  message: { to: string; text: string; prefix: string; day: string }
): Promise<void> {
  try {
    await deps.sms.send({ to: message.to, text: message.text })
  } catch (error) {
    // A fixed word from the adapter. Anything else that was thrown is not read at all (a
    // provider's own message can quote the number), and says nothing about whether the
    // message went: it is "unconfirmed" like a lost answer.
    const reason = error instanceof SmsSendError ? error.reason : 'unconfirmed'
    if (reason === 'unconfirmed') {
      // Nothing says the provider refused, so the message may have gone out and may be
      // billed. It stays a message of the day and a code sent: the ceiling counts what may
      // have been spent, never only what is known to have been. The caller is told what a
      // failure tells them, because nobody can promise a code is on its way.
      logger.warn('text message not sent', {
        environmentId: tenant.environmentId,
        reason,
        count: 'kept',
      })
      throw new AuthError('sms.unavailable')
    }
    logger.warn('text message not sent', { environmentId: tenant.environmentId, reason })
    // Known not to have been sent: not a code sent, and not a message of the day. When this
    // cannot be written the counts stay one too high, which errs on the side of sending less.
    await counted(tenant.environmentId, () =>
      deps.smsUsage.recordNotSent(
        tenant.environmentId,
        message.day,
        message.prefix,
        deps.clock.now()
      )
    )
    throw new AuthError('sms.unavailable')
  }
}

/**
 * Write a count, and let what it describes stand when the write fails: the message was not
 * taken by the sender, or the code was confirmed, and neither is undone for the sake of a
 * statistic. Never for the count of a message about to be sent: that one fails closed.
 */
async function counted(environmentId: string, write: () => Promise<void>): Promise<void> {
  try {
    await write()
  } catch (error) {
    logger.warn('text message not counted', { environmentId, err: errorReason(error) })
  }
}

/**
 * Count a texted code as used: the step that accepted it calls this once the code has done
 * what it was for.
 *
 * It is counted against the day the code was **sent** on, so that every used code pairs with
 * its own send. A count that cannot be written is logged and never fails the caller.
 *
 * @param deps - The counts and the clock.
 * @param tenant - The environment.
 * @param code - The number the code was texted to, and when.
 */
export async function recordUsed(
  deps: Pick<Deps, 'smsUsage' | 'clock'>,
  tenant: Pick<Tenant, 'environmentId'>,
  code: { to: string; sentAt: Date }
): Promise<void> {
  const prefix = phoneNumberPrefix(code.to)
  if (prefix === null) {
    return
  }
  await counted(tenant.environmentId, () =>
    deps.smsUsage.recordUsed(tenant.environmentId, utcDay(code.sentAt), prefix, deps.clock.now())
  )
}

/**
 * The codes an environment texted in the last days, by destination prefix: what an operator
 * reads to spot SMS pumping (codes sent and never used).
 *
 * @param deps - The counts and the clock.
 * @param tenant - The environment.
 * @param query - How many days back to read, today included.
 * @returns The totals, and the prefixes with the most unused codes first (at most
 *   `SMS_USAGE_MAX_PREFIXES`). Counts only: no number, and nothing about who asked.
 */
export async function usage(
  deps: Pick<Deps, 'smsUsage' | 'clock'>,
  tenant: Pick<Tenant, 'environmentId'>,
  query: { days: number }
): Promise<SmsUsage> {
  const since = utcDay(new Date(deps.clock.now().getTime() - (query.days - 1) * DAY_MS))
  const summary = await deps.smsUsage.summary(tenant.environmentId, since, SMS_USAGE_MAX_PREFIXES)
  return {
    since,
    days: query.days,
    sent: summary.sent,
    used: summary.used,
    unused: summary.sent - summary.used,
    prefixes: summary.prefixes.map((count) => ({ ...count, unused: count.sent - count.used })),
    truncated: summary.truncated,
  }
}
