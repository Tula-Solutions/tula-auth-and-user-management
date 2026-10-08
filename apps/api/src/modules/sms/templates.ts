import { DEFAULT_APP_NAME } from '@tula/contract'
import { displayName } from '~/modules/email/templates'

// The one place a text message's words are written (as `~/modules/email/templates` is for
// email). A message is plain text, one line of copy and, where the environment has a web
// origin, the origin-bound line that lets a phone offer the code only to that site.

/**
 * What a reader cannot see: format characters (zero-width spaces, direction overrides),
 * private-use and unassigned code points, and lone surrogates. `displayName` has already taken
 * out control characters and line breaks; these are what could still hide in a name.
 */
const INVISIBLE = /[\p{Cf}\p{Co}\p{Cn}\p{Cs}]+/gu

/**
 * Make an app name safe to put in a text message.
 *
 * The name is operator input that reaches a subscriber's phone, so it is cleaned here rather
 * than trusted: on one line, nothing unprintable or invisible, at most the settings' own
 * length limit.
 *
 * @param name - The configured name.
 * @returns The cleaned name, or the default name when nothing printable is left.
 */
export function smsAppName(name: string): string {
  const cleaned = displayName(name.replace(INVISIBLE, '')).replace(/\s+/g, ' ')
  // `displayName` falls back to the default for an empty name; cleaned again so that a name
  // made only of invisible characters ends there too.
  return cleaned.trim() || DEFAULT_APP_NAME
}

/**
 * The host a code is bound to: that of the environment's **first** allowed origin, without
 * its port. Never anything a request said.
 *
 * @param allowedOrigins - The environment's `urls.allowedOrigins`.
 * @returns The host, or `null` when the environment allows no origin (or the first entry is
 *   not a URL, which the settings schema does not let through).
 */
export function boundHost(allowedOrigins: readonly string[]): string | null {
  const first = allowedOrigins[0]
  if (first === undefined) {
    return null
  }
  try {
    return new URL(first).hostname || null
  } catch {
    return null
  }
}

/** What a code message is written from. */
export interface CodeSms {
  /** The environment's `app.name`, as configured. */
  appName: string
  /** The environment's `urls.allowedOrigins`. */
  allowedOrigins: readonly string[]
  /** The code. */
  code: string
}

/**
 * The text of a message that carries a verification code.
 *
 * ```text
 * Your Northline verification code is 123456.
 *
 * @app.northline.app #123456
 * ```
 *
 * - It starts with a word, never with digits: a reader (and a test) can tell the code from
 *   whatever an app is called.
 * - The last line is the origin-bound one-time-code format (`@host #code`): a browser or an
 *   operating system that knows it offers the code only on that site. It is left out when
 *   the environment allows no origin; a `#code` line without a host is not that format.
 * - With the longest app name the settings accept (64 characters) and a host of up to 51, it
 *   is one GSM-7 segment (160 characters). A name with characters outside GSM-7 makes the
 *   carrier send it in a wider encoding and more segments; that is the operator's choice of
 *   name, not something to strip.
 *
 * @param sms - The app name, the allowed origins and the code.
 * @returns The message.
 *
 * @example
 * ```ts
 * codeText({ appName: 'Northline', allowedOrigins: [], code: '123456' })
 * // 'Your Northline verification code is 123456.'
 * ```
 */
export function codeText(sms: CodeSms): string {
  const line = `Your ${smsAppName(sms.appName)} verification code is ${sms.code}.`
  const host = boundHost(sms.allowedOrigins)
  return host === null ? line : `${line}\n\n@${host} #${sms.code}`
}
