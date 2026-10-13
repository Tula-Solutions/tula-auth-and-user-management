/** The codes texted to the numbers of one destination prefix, and how many were used. */
export interface SmsPrefixCount {
  /** The destination prefix (`+1`, `+1242`): the contract's `phoneNumberPrefix`, never a number. */
  prefix: string
  /** Codes texted. */
  sent: number
  /** Of those, the ones that were then entered correctly. Never more than `sent`. */
  used: number
}

/** An environment's texted codes over a span of days. */
export interface SmsUsageSummary {
  /** Codes texted in the span, over every prefix. */
  sent: number
  /** Codes used in the span, over every prefix. */
  used: number
  /**
   * The prefixes with the most unused codes first (then the most sent, then by prefix), at
   * most as many as were asked for.
   */
  prefixes: SmsPrefixCount[]
  /** Whether the span has more prefixes than `prefixes` lists. */
  truncated: boolean
}

/** The environment a count belongs to. */
export interface SmsUsageScope {
  projectId: string
  environmentId: string
}

/**
 * Counts of codes texted and used, per environment, UTC day and destination prefix
 * (ADR 0037): what an operator reads to spot SMS pumping, and what the environment's daily
 * limit is counted on.
 *
 * **Nothing here holds a phone number**, and nothing says who asked: a caller passes the
 * prefix (`phoneNumberPrefix`), and an adapter refuses anything that is not one. The counts
 * are not a record of who can do what, so no method takes an `Activity` (ADR 0012).
 *
 * A day is a `YYYY-MM-DD` string in UTC.
 */
export interface SmsUsageStore {
  /**
   * Take one message of the environment's `day`: count one code texted to a number of
   * `prefix`, unless the environment has already counted `limit` codes on that day over
   * every prefix. **The one way a code is counted as sent.**
   *
   * Reading the day and adding to it are one step: of several takes at once for the day's
   * last message exactly one is granted, on one instance or many. A take that is refused
   * changes nothing. An adapter does it without holding anything while it waits for
   * something else of its own (in Postgres: one transaction on one connection), so no
   * number of takes at once can leave them waiting on each other.
   *
   * @param scope - The environment.
   * @param day - The UTC day the message is sent on.
   * @param prefix - The number's destination prefix.
   * @param limit - The most codes the environment counts on one day.
   * @param at - Now.
   * @returns Whether the message was counted: `false` when the day is spent.
   * @throws When `prefix` is not a destination prefix (a `+` and one to four digits),
   *   whether or not the day is spent.
   */
  takeFromDay(
    scope: SmsUsageScope,
    day: string,
    prefix: string,
    limit: number,
    at: Date
  ): Promise<boolean>
  /**
   * Take back one code counted for `prefix` on `day` whose message was then not sent. Does
   * nothing when every code of that day and prefix has been used, or none was counted: `sent`
   * never goes below `used`.
   *
   * @param environmentId - The environment.
   * @param day - The UTC day the code was counted on.
   * @param prefix - The number's destination prefix.
   * @param at - Now.
   */
  recordNotSent(environmentId: string, day: string, prefix: string, at: Date): Promise<void>
  /**
   * How many codes the environment has counted as sent on `day`, over every prefix: what the
   * daily limit is held against.
   *
   * @param environmentId - The environment.
   * @param day - The UTC day.
   * @returns The count; zero for a day with none.
   */
  sentOn(environmentId: string, day: string): Promise<number>
  /**
   * Count one of the codes texted to `prefix` on `day` as used. Does nothing when no code of
   * that day and prefix is still uncounted: `used` never passes `sent`.
   *
   * @param environmentId - The environment.
   * @param day - The UTC day the code was **sent**, so that it pairs with its own send.
   * @param prefix - The number's destination prefix.
   * @param at - Now.
   */
  recordUsed(environmentId: string, day: string, prefix: string, at: Date): Promise<void>
  /**
   * The environment's counts from `since` on, by prefix.
   *
   * @param environmentId - The environment.
   * @param since - The first UTC day to count.
   * @param limit - The most prefixes to list.
   * @returns The totals over every prefix, and the prefixes with the most unused codes.
   */
  summary(environmentId: string, since: string, limit: number): Promise<SmsUsageSummary>
  /**
   * Delete one batch of the environment's counts of days before `day`. For the retention job.
   *
   * The database keeps the last `SMS_COUNT_RETENTION_FLOOR_DAYS` days (`@tula/db`) whatever `day`
   * says (`sms_code_counts_retention_floor`): the day the daily limit is held against cannot
   * be deleted by anything that runs as the API.
   *
   * @param environmentId - The environment.
   * @param day - The first UTC day to keep.
   * @param limit - The most rows to delete.
   * @returns How many rows were deleted.
   */
  deleteBefore(environmentId: string, day: string, limit: number): Promise<number>
}

/** What a destination prefix looks like: a `+` and one to four digits. Never a whole number. */
export const SMS_PREFIX_PATTERN = /^\+[0-9]{1,4}$/
