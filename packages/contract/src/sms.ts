import { z } from 'zod'
import { SMS_PREFIX_MAX_DIGITS } from './phone'

// What an operator is shown of the text messages an environment sent (ADR 0037): counts by
// destination prefix, never a number.

/** How many days back `GET /v1/admin/sms/usage` reads at most. */
export const SMS_USAGE_MAX_DAYS = 30

/** How many days back it reads when the request does not say. */
export const SMS_USAGE_DEFAULT_DAYS = 7

/** How many prefixes one answer of it lists at most. */
export const SMS_USAGE_MAX_PREFIXES = 100

const count = z.number().int().min(0)

/**
 * The codes texted to the numbers of one destination prefix, and how many of them were used.
 *
 * - `prefix`: the destination the numbers share (`phoneNumberPrefix`), with the `+`: a
 *   country calling code, or a calling code and the digits that tell one country from another
 *   inside a shared one (`+1242`). It names a destination, never a number.
 * - `sent`: codes texted.
 * - `used`: of those, the ones a user then entered correctly.
 * - `unused`: `sent - used`. A prefix where nearly every code goes unused is what SMS pumping
 *   looks like: messages are being bought, not read.
 */
export const SmsPrefixUsageSchema = z
  .object({
    prefix: z.string().regex(new RegExp(`^\\+[0-9]{1,${SMS_PREFIX_MAX_DIGITS}}$`)),
    sent: count,
    used: count,
    unused: count,
  })
  .meta({ ref: 'SmsPrefixUsage' })

/**
 * What `GET /v1/admin/sms/usage` returns: the codes an environment texted in a span of days,
 * by destination prefix.
 *
 * - `since`: the first day (UTC) the counts cover, as `YYYY-MM-DD`; they run to today.
 * - `days`: how many days that is, today included.
 * - `sent`, `used`, `unused`: the totals over **every** prefix of the span.
 * - `prefixes`: the prefixes with the most unused codes first, at most
 *   {@link SMS_USAGE_MAX_PREFIXES} of them.
 * - `truncated`: `true` when the span has more prefixes than are listed.
 *
 * Counts only. No phone number, and nothing about who asked.
 */
export const SmsUsageSchema = z
  .object({
    since: z.iso.date(),
    days: z.number().int().min(1).max(SMS_USAGE_MAX_DAYS),
    sent: count,
    used: count,
    unused: count,
    prefixes: z.array(SmsPrefixUsageSchema).max(SMS_USAGE_MAX_PREFIXES),
    truncated: z.boolean(),
  })
  .meta({ ref: 'SmsUsage' })

/** The codes texted to one destination prefix, and how many were used. */
export type SmsPrefixUsage = z.infer<typeof SmsPrefixUsageSchema>
/** An environment's texted codes over a span of days, by destination prefix. */
export type SmsUsage = z.infer<typeof SmsUsageSchema>
