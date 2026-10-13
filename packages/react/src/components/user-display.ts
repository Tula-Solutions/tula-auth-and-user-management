import type { Session, User } from '@tula/core'
import { formatText, type TulaLocalization } from '../localization'

/**
 * @param user - The user.
 * @returns Their full name, or `null` when they have none.
 */
export function fullName(user: User): string | null {
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim()
  return name === '' ? null : name
}

/**
 * @param user - The user.
 * @returns One or two capital letters for an avatar: from the name, else from the email, else
 *   a question mark (an account made through X or Facebook has no address, and may have no
 *   name either).
 */
export function initials(user: User): string {
  const letters = [user.firstName, user.lastName]
    .map((part) => [...(part ?? '').trim()][0])
    .filter((letter): letter is string => letter !== undefined)
  const chosen = letters.length > 0 ? letters : [[...(user.email ?? '')][0] ?? '?']
  return chosen.join('').toUpperCase()
}

const BROWSERS: [RegExp, string][] = [
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
  [/\bOPR\/|\bOpera\b/, 'Opera'],
  [/\bFirefox\/|\bFxiOS\//, 'Firefox'],
  [/(?:\b|Headless)Chrome\/|\bCriOS\//, 'Chrome'],
  [/\bSafari\//, 'Safari'],
]

const SYSTEMS: [RegExp, string][] = [
  [/\biPhone\b/, 'iPhone'],
  [/\biPad\b/, 'iPad'],
  [/\bAndroid\b/, 'Android'],
  [/\bWindows\b/, 'Windows'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS'],
  [/\bLinux\b/, 'Linux'],
]

function firstMatch(table: [RegExp, string][], text: string): string | null {
  return table.find(([pattern]) => pattern.test(text))?.[1] ?? null
}

/**
 * A short name for a session's device, e.g. "Chrome on macOS", from its user agent.
 *
 * The user agent is text the device sent; it is only ever matched against fixed patterns and
 * the result is one of the fixed names above, so nothing a device sends reaches the page.
 *
 * @param session - The session.
 * @param t - The strings.
 * @returns The name, or the "unknown device" string.
 */
export function deviceName(session: Pick<Session, 'userAgent'>, t: TulaLocalization): string {
  const agent = session.userAgent ?? ''
  const browser = firstMatch(BROWSERS, agent)
  const os = firstMatch(SYSTEMS, agent)
  if (browser && os) {
    return formatText(t.userProfile.deviceOn, { browser, os })
  }
  return browser ?? os ?? t.userProfile.unknownDevice
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
]

/**
 * A relative time such as "2 days ago".
 *
 * @param iso - The moment (ISO 8601).
 * @param now - The current time (`Date.now()` scale).
 * @param locale - A BCP 47 tag.
 * @returns The text; the raw value when it is not a date or the locale is not supported.
 */
export function relativeTime(iso: string, now: number, locale: string): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) {
    return iso
  }
  const seconds = Math.round((then - now) / 1000)
  const [unit, size] = UNITS.find(([, length]) => Math.abs(seconds) >= length) ?? ['minute', 60]
  try {
    return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(
      Math.trunc(seconds / size),
      unit
    )
  } catch {
    return new Date(then).toISOString().slice(0, 10)
  }
}
