import {
  COUNTRY_CALLING_PREFIXES,
  SMS_COUNTRIES,
  SMS_USAGE_DEFAULT_DAYS,
  SMS_USAGE_MAX_DAYS,
  smsCostLimits,
  smsPrefixCountries,
} from '@tula/contract'
import type { SmsUsage } from '~/api/generated/api.gen'
import { printable } from '~/lib/printable'

// What the Text messages screen says, apart from how it is drawn. Which countries exist,
// which prefix a country has, which countries a prefix covers and what one daily limit allows
// in an hour are all the contract's: nothing here is a rule of the screen's own.

/** The id of the deployment check that says whether text messages can be sent (ADR 0031). */
export const SMS_SENDER_CHECK = 'sms_sender'

/**
 * The spans of days the usage can be read for: a day, the route's default, and the most it
 * reads. The route takes any whole number between; the screen offers these three.
 */
export const USAGE_DAYS: readonly number[] = [1, SMS_USAGE_DEFAULT_DAYS, SMS_USAGE_MAX_DAYS]

let names: Intl.DisplayNames | null | undefined

/**
 * A country's name in English, from the browser's own data.
 *
 * The contract's table holds codes and prefixes and no names, on purpose; the platform has
 * them. A code the browser has no name for is shown as the code.
 *
 * @param country - An ISO 3166-1 alpha-2 code from the contract's list.
 * @returns The name, or the code itself.
 * @example
 * countryName('DE') // 'Germany'
 */
export function countryName(country: string): string {
  if (names === undefined) {
    try {
      names = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'code' })
    } catch {
      names = null
    }
  }
  try {
    return names?.of(country) ?? country
  } catch {
    return country
  }
}

/**
 * The calling prefixes of a country's numbers, as the contract's table has them.
 *
 * @param country - A country code.
 * @returns Each prefix with its `+`; none for a code the table does not have.
 * @example
 * countryPrefixes('DE') // ['+49']
 */
export function countryPrefixes(country: string): string[] {
  const prefixes = Object.hasOwn(COUNTRY_CALLING_PREFIXES, country)
    ? (COUNTRY_CALLING_PREFIXES[country] ?? [])
    : []
  return prefixes.map((prefix) => `+${prefix}`)
}

/**
 * The other countries whose numbers cannot be told from this one's: those that share one of
 * its prefixes. Allowing one of them allows them all (the contract's `isPhoneNumberAllowed`).
 *
 * @param country - A country code.
 * @returns Their codes, each once, in alphabetical order.
 * @example
 * sharesPrefixWith('US') // ['CA']
 */
export function sharesPrefixWith(country: string): string[] {
  const others = new Set<string>()
  for (const prefix of countryPrefixes(country)) {
    for (const other of smsPrefixCountries(prefix)) {
      if (other !== country) {
        others.add(other)
      }
    }
  }
  return [...others].sort()
}

/** A country as the screen lists it. */
export interface CountryEntry {
  code: string
  name: string
  /** Its calling prefixes, joined: `+49`, or `+1809, +1829, +1849`. */
  prefixes: string
  /** The names of the countries its prefix also belongs to; empty for a prefix of its own. */
  sharedWith: string[]
}

/**
 * One country in the words the screen uses for it.
 *
 * @param country - A country code.
 * @returns Its name, prefixes and the countries it cannot be told from.
 */
export function countryEntry(country: string): CountryEntry {
  return {
    code: country,
    name: countryName(country),
    prefixes: countryPrefixes(country).join(', '),
    sharedWith: sharesPrefixWith(country).map(countryName),
  }
}

/**
 * The countries that can still be added to a list: the contract's, without those in it, by
 * name.
 *
 * @param chosen - The draft's `sms.allowedCountries`.
 * @returns The entries, in the order of their names.
 */
export function countryChoices(chosen: readonly string[]): CountryEntry[] {
  const has = new Set(chosen)
  return SMS_COUNTRIES.filter((country) => !has.has(country))
    .map(countryEntry)
    .sort((a, b) => a.name.localeCompare(b.name, 'en'))
}

/**
 * Add a country to a list that is a set: a country already in it, and a value that is not a
 * country of the contract's list, change nothing.
 *
 * @param chosen - The draft's list.
 * @param country - The value of the select.
 * @returns The list to store.
 */
export function withCountry(chosen: readonly string[], country: string): string[] {
  return chosen.includes(country) || !SMS_COUNTRIES.includes(country)
    ? [...chosen]
    : [...chosen, country]
}

/**
 * A destination prefix from the server and the countries it covers, for one row of the usage.
 *
 * The prefix is the server's text and is written out with `printable()`. A prefix covers
 * every country that has it (`+1`: Canada and the United States); all are named, none is
 * picked.
 *
 * @param prefix - `prefix` of one entry of the usage.
 * @returns The prefix as shown, and the names of its countries (none for a prefix this
 *   version's table does not have).
 * @example
 * destination('+1') // { prefix: '+1', countries: ['Canada', 'United States'] }
 */
export function destination(prefix: string): { prefix: string; countries: string[] } {
  return {
    prefix: printable(prefix),
    countries: smsPrefixCountries(prefix)
      .map(countryName)
      .sort((a, b) => a.localeCompare(b, 'en')),
  }
}

/**
 * The countries of a destination, in words.
 *
 * @param countries - The names from {@link destination}.
 * @returns One phrase that says when there are several, or that none is known.
 */
export function destinationWords(countries: readonly string[]): string {
  if (countries.length === 0) {
    return 'A prefix this version of the dashboard does not know'
  }
  if (countries.length === 1) {
    return countries[0] ?? ''
  }
  return `${countries.join(', ')} (${countries.length} countries share this prefix and are counted together)`
}

function count(value: number, one: string, many: string): string {
  return `${value.toLocaleString('en')} ${value === 1 ? one : many}`
}

/**
 * The span of a usage answer, in words: the server's own first day and number of days.
 *
 * @param usage - The answer.
 * @returns E.g. "The last 7 days, in UTC: 2026-10-03 to today."
 */
export function spanSentence(usage: Pick<SmsUsage, 'since' | 'days'>): string {
  return usage.days === 1
    ? `Today, in UTC (${printable(usage.since)}).`
    : `The last ${usage.days} days, in UTC: ${printable(usage.since)} to today.`
}

/**
 * The totals of a usage answer, in words. Counts as the server gave them: no rate is worked
 * out here.
 *
 * @param usage - The answer.
 * @returns E.g. "12 codes sent, 3 used, 9 never used."
 */
export function totalsSentence(usage: Pick<SmsUsage, 'sent' | 'used' | 'unused'>): string {
  return `${count(usage.sent, 'code sent', 'codes sent')}, ${usage.used.toLocaleString('en')} used, ${usage.unused.toLocaleString('en')} never used.`
}

/**
 * What one daily limit allows in an hour, in words: the contract's `smsCostLimits`, which is
 * what the server holds.
 *
 * @param dailyMessageLimit - The draft's limit, or `undefined` for an empty field.
 * @param max - The most the contract lets the limit be.
 * @returns The sentence, or `null` for a value the server would refuse (nothing is claimed
 *   about a limit that will not be saved).
 */
export function hourlySentence(dailyMessageLimit: number | undefined, max: number): string | null {
  if (
    dailyMessageLimit === undefined ||
    !Number.isInteger(dailyMessageLimit) ||
    dailyMessageLimit < 1 ||
    dailyMessageLimit > max
  ) {
    return null
  }
  const limits = smsCostLimits(dailyMessageLimit)
  return `With ${count(limits.perDay, 'message', 'messages')} a day: at most ${limits.environmentPerHour.toLocaleString('en')} in one hour in all, and at most ${limits.prefixPerHour.toLocaleString('en')} in one hour to one destination prefix.`
}
