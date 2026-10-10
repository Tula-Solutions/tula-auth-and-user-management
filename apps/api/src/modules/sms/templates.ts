import {
  DEFAULT_APP_NAME,
  parseEmailTemplate,
  type SmsTemplate,
  type SmsTemplateKind,
  smsTemplateProblems,
} from '@tula/contract'
import { displayName } from '~/modules/email/templates'

// The one place a text message is put together (as `~/modules/email/templates` is for
// email). A message is plain text: one sentence, which is the built-in one written here or
// the environment's own for the message's kind (`sms.templates`, ADR 0042), and, where the
// environment has a web origin, the origin-bound line that lets a phone offer the code only
// to that site. That last line is written here and nowhere else: it is in no template.

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

/**
 * The built-in sentence of every kind, in the grammar an environment's own template is
 * written in. Every kind says the same today; they are apart so that an environment can word
 * a sign-in, the proof of a number and a second step differently.
 *
 * Each passes `smsTemplateProblems` for its kind (a test holds that): the built-in text is
 * a template like any other, which is also what an editor shows before anything is saved.
 */
export const BUILT_IN_SMS_TEMPLATES: Readonly<Record<SmsTemplateKind, string>> = {
  phone_verification: 'Your {{appName}} verification code is {{code}}.',
  sign_in: 'Your {{appName}} verification code is {{code}}.',
  second_factor: 'Your {{appName}} verification code is {{code}}.',
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
  return withBoundLine(`Your ${smsAppName(sms.appName)} verification code is ${sms.code}.`, sms)
}

/** A sentence and, where the environment has an origin, the server's last line after it. */
function withBoundLine(sentence: string, sms: CodeSms): string {
  const host = boundHost(sms.allowedOrigins)
  return host === null ? sentence : `${sentence}\n\n@${host} #${sms.code}`
}

/** A run of exactly six digits that is not part of a longer number: how a code is read. */
const SIX_DIGITS = /(?<![0-9])[0-9]{6}(?![0-9])/g

/**
 * Why an environment's template was not used for a message, as a fixed word.
 *
 * - `invalid`: it does not pass the rules of its kind (`smsTemplateProblems`): stored by
 *   another version, or written past the API.
 * - `code_not_last`: once rendered, the last run of six digits in the message would not
 *   have been the code. A template's own text cannot do that; an app name that holds six
 *   digits, written after the code in an environment with no origin, can.
 */
export type SmsTemplateFallbackReason = 'invalid' | 'code_not_last'

/** A message's text, and why the environment's template was not used for it, if it was not. */
export interface RenderedCodeSms {
  text: string
  /** `null` when the template was used as written, or there was none. Never any of its text. */
  unused: SmsTemplateFallbackReason | null
}

/**
 * The text of a code message in an environment's own wording (ADR 0042).
 *
 * The template is **one sentence with `{{appName}}` and `{{code}}`**; the server's
 * origin-bound last line is put after it exactly as after the built-in sentence, so no
 * wording can move it, repeat it or name another host. Each value is put in once and never
 * read again as a template: an app name that holds `{{code}}` stays those characters.
 *
 * A template that cannot be used (see {@link SmsTemplateFallbackReason}) is replaced
 * **whole** by the built-in text and reported in `unused`: never a failed send. Whatever is
 * sent, the code is the last run of six digits in it.
 *
 * @param kind - The kind of message, which decides the template's rules.
 * @param sms - The app name, the allowed origins and the code.
 * @param template - The environment's template for this kind, if it has one.
 * @returns The message and whether the template was used.
 *
 * @example
 * ```ts
 * renderCodeText(
 *   'sign_in',
 *   { appName: 'Northline', allowedOrigins: [], code: '123456' },
 *   { text: 'Use {{code}} to sign in to {{appName}}.' }
 * ) // { text: 'Use 123456 to sign in to Northline.', unused: null }
 * ```
 */
export function renderCodeText(
  kind: SmsTemplateKind,
  sms: CodeSms,
  template: SmsTemplate | undefined
): RenderedCodeSms {
  const builtIn = codeText(sms)
  if (template === undefined) {
    return { text: builtIn, unused: null }
  }
  const tokens = typeof template.text === 'string' ? parseEmailTemplate(template.text) : null
  if (tokens === null || smsTemplateProblems(kind, template).length > 0) {
    return { text: builtIn, unused: 'invalid' }
  }
  const values: Record<string, string> = { appName: smsAppName(sms.appName), code: sms.code }
  const sentence = tokens
    .map((token) => ('text' in token ? token.text : (values[token.placeholder] ?? '')))
    .join('')
  const text = withBoundLine(sentence, sms)
  // The one thing a value can still break: the app's name is the operator's and may hold
  // six digits of its own.
  if (text.match(SIX_DIGITS)?.at(-1) !== sms.code) {
    return { text: builtIn, unused: 'code_not_last' }
  }
  return { text, unused: null }
}
