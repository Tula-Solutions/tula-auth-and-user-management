import type { SessionClient } from '@tula/contract'

/** The family of a device that sent nothing recognisable. */
export const UNKNOWN_DEVICE = 'Unknown device'

/**
 * How much of a user agent is looked at. Longer values are cut first, so matching costs the
 * same whatever a client sends (`MAX_USER_AGENT_LENGTH` already bounds what is stored).
 */
const MAX_MATCHED_LENGTH = 512

// Order matters: Edge and Opera also say "Chrome", and every Chromium browser also says "Safari".
// The names are the ones `<UserProfile>` shows in the device list (`deviceName` in @tula/react).
const BROWSERS: readonly (readonly [RegExp, string])[] = [
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
  [/\bOPR\/|\bOpera\b/, 'Opera'],
  [/\bFirefox\/|\bFxiOS\//, 'Firefox'],
  [/(?:\b|Headless)Chrome\/|\bCriOS\//, 'Chrome'],
  [/\bSafari\//, 'Safari'],
]

// Order matters here too: an iPhone says "like Mac OS X", and Android says "Linux".
const SYSTEMS: readonly (readonly [RegExp, string])[] = [
  [/\biPhone\b/, 'iPhone'],
  [/\biPad\b/, 'iPad'],
  [/\bAndroid\b/, 'Android'],
  [/\bWindows\b/, 'Windows'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS'],
  [/\bLinux\b/, 'Linux'],
]

/** What a native SDK's session is called: its platform, which the client kind already states. */
const NATIVE: Partial<Record<SessionClient, string>> = {
  ios: 'iOS app',
  android: 'Android app',
}

function firstMatch(table: readonly (readonly [RegExp, string])[], text: string): string | null {
  return table.find(([pattern]) => pattern.test(text))?.[1] ?? null
}

/**
 * Reduce what a session was created from to a stable family name: "Chrome on Windows",
 * "Safari on iPhone", "iOS app".
 *
 * The one place the server names a device. It is what the "new sign-in" notice compares between
 * a user's sessions and what the email shows (ADR 0023).
 *
 * - A native session (`ios`, `android`) is named by its platform; its user agent is an HTTP
 *   library's and says nothing about the device.
 * - Anything else is named by the browser and operating system its user agent mentions, with no
 *   version numbers, so a browser update is not a new device.
 * - A missing or unrecognised user agent is {@link UNKNOWN_DEVICE}.
 *
 * **The result is always built from the fixed names in this file.** The user agent is text the
 * client chose; it is only ever matched against fixed patterns, so nothing a client sends (HTML,
 * line breaks, a very long value) can reach an email through here.
 *
 * A family is not a device identity: two laptops running the same browser are one family, and
 * anyone can send any user agent.
 *
 * @param client - The session's client kind.
 * @param userAgent - The `User-Agent` the client sent, if any.
 * @returns The family name.
 *
 * @example
 * ```ts
 * deviceFamily('web', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) … Chrome/140.0 Safari/537.36')
 * // 'Chrome on Windows'
 * ```
 */
export function deviceFamily(client: SessionClient, userAgent: string | null): string {
  const native = NATIVE[client]
  if (native) {
    return native
  }
  const agent = (userAgent ?? '').slice(0, MAX_MATCHED_LENGTH)
  const browser = firstMatch(BROWSERS, agent)
  const system = firstMatch(SYSTEMS, agent)
  if (browser && system) {
    return `${browser} on ${system}`
  }
  return browser ?? system ?? UNKNOWN_DEVICE
}
