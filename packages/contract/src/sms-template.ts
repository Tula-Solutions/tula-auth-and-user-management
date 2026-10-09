// Plain data and plain functions, like `./email-template`, whose grammar and whose
// definitions of "hidden", "invisible" and "reads as a link" this module uses: it imports no
// schema library, so the dashboard's editor and the CLI can read what a text message may say
// without one. The schema that uses it is `./sms-template-schema`.

import {
  hasHiddenCharacter,
  parseEmailTemplate,
  readsAsLink,
  withoutInvisibleCharacters,
} from './email-template'

/**
 * Every text message whose wording an environment can change (ADR 0042): one kind per
 * reason the server texts a code.
 *
 * - `phone_verification`: the code that proves a phone number being added to an account.
 * - `sign_in`: the code that signs someone in with a number their account has proven.
 * - `second_factor`: the code of a texted second step (ADR 0025): at its enrolment, after a
 *   sign-in's or a reset's first factor, and at a step-up. One kind for the three, because
 *   to the reader they are one message: "prove it is you, with the phone on your account".
 *
 * A closed list. Later servers may add kinds: additive.
 *
 * @example
 * ```ts
 * SMS_TEMPLATE_KINDS.includes('sign_in') // true
 * ```
 */
export const SMS_TEMPLATE_KINDS = ['phone_verification', 'sign_in', 'second_factor'] as const

/** One of {@link SMS_TEMPLATE_KINDS}. */
export type SmsTemplateKind = (typeof SMS_TEMPLATE_KINDS)[number]

/**
 * Every placeholder a text message's template can name, as `{{name}}`.
 *
 * - `appName`: the environment's app name, cleaned onto one line.
 * - `code`: the 6-digit code.
 *
 * Deliberately absent: a phone number, an address of any kind, a host (the origin-bound last
 * line is the server's to write) and anything a request said.
 *
 * @example
 * ```ts
 * SMS_TEMPLATE_PLACEHOLDERS.includes('code') // true
 * ```
 */
export const SMS_TEMPLATE_PLACEHOLDERS = ['appName', 'code'] as const

/** One of {@link SMS_TEMPLATE_PLACEHOLDERS}. */
export type SmsTemplatePlaceholder = (typeof SMS_TEMPLATE_PLACEHOLDERS)[number]

/** The rules of one kind's template. */
export interface SmsTemplateRules {
  /** Placeholders the text must name, exactly once. */
  required: readonly SmsTemplatePlaceholder[]
  /** Placeholders the text may name besides, at most once each. */
  optional: readonly SmsTemplatePlaceholder[]
}

const CODE: SmsTemplateRules = { required: ['code'], optional: ['appName'] }

/**
 * What each kind's template must and may name. Plain data: an editor draws its list of
 * placeholders from it, and the server validates against the same table.
 *
 * @example
 * ```ts
 * SMS_TEMPLATE_RULES.sign_in.required // ['code']
 * ```
 */
export const SMS_TEMPLATE_RULES: Readonly<Record<SmsTemplateKind, SmsTemplateRules>> = {
  phone_verification: CODE,
  sign_in: CODE,
  second_factor: CODE,
}

/**
 * Longest template of a text message, in characters (UTF-16 code units).
 *
 * A message is billed by the segment, so the cap is what bounds an environment's cost per
 * message. A template names the app at most once: with the longest name the settings accept
 * (64 characters, in place of the 11 of `{{appName}}`) the sentence is at most 193
 * characters, and the server's own last line adds 11 and the host of the environment's
 * first allowed origin (at most 253). So a message is **at most three segments** in the
 * GSM 7-bit alphabet whatever the host (457 of 459 characters), and at most two with a host
 * of up to 102 characters. One character outside that alphabet, in the template or in the
 * app's name, makes a carrier send the whole message as UCS-2, where a segment holds 67
 * characters instead of 153: the same worst case is then seven segments.
 * {@link smsSegments} counts them for a given text.
 */
export const MAX_SMS_TEMPLATE_LENGTH = 140

/** One environment's wording of one kind of text message. */
export interface SmsTemplate {
  /**
   * The sentence, on one line. The server puts its origin-bound last line (`@host #code`)
   * after it; a template never holds that line.
   */
  text: string
}

/** An environment's text message templates, by kind. A kind left out sends the built-in text. */
export type SmsTemplates = { [Kind in SmsTemplateKind]?: SmsTemplate | undefined }

/**
 * Why a text message's template is refused, as a fixed word.
 *
 * - `empty`: nothing but white space and characters that draw nothing.
 * - `too_long`: over {@link MAX_SMS_TEMPLATE_LENGTH}.
 * - `control_character`: a control character or a line break. A template is one line.
 * - `hidden_character`: what no email template may hold either (`hasHiddenCharacter`).
 * - `malformed_braces`: a `{` or `}` that is not part of a `{{name}}`.
 * - `unknown_placeholder`: a name this kind does not have.
 * - `missing_placeholder`: the text lacks `{{code}}`.
 * - `repeated_placeholder`: a placeholder is named twice.
 * - `placeholder_touches_text`: a letter, a digit, a combining mark or another placeholder
 *   directly before or after a placeholder, judged on the text without the characters that
 *   draw nothing. A code must stand alone to be read, by a person and by a phone.
 * - `digit_run`: four or more digits in a row, which could be read as the code.
 * - `imitates_code_line`: an `@` or a `#` at the start of a word, which is how the
 *   origin-bound line the server writes is recognised.
 * - `reads_as_link`: something a phone would turn into a link (`readsAsLink`).
 * - `leading_non_letter`: the text does not start with a letter of its own (a placeholder
 *   first would let a code, or an app name that starts with a digit, lead the message).
 */
export type SmsTemplateProblemCode =
  | 'empty'
  | 'too_long'
  | 'control_character'
  | 'hidden_character'
  | 'malformed_braces'
  | 'unknown_placeholder'
  | 'missing_placeholder'
  | 'repeated_placeholder'
  | 'placeholder_touches_text'
  | 'digit_run'
  | 'imitates_code_line'
  | 'reads_as_link'
  | 'leading_non_letter'

/** One reason a text message's template is refused. */
export interface SmsTemplateProblem {
  /** Which part: a template has one. */
  field: 'text'
  /** Why, as a fixed word. */
  code: SmsTemplateProblemCode
  /** The placeholder's name, where the reason is about one. */
  placeholder?: string
  /** The reason in words. It names a placeholder at most, never the template's text. */
  message: string
}

// Control characters and line or paragraph separators: the template is one line, and the
// only line break of a message is the server's, before its own last line.
const UNPRINTABLE = /[\p{Cc}\p{Zl}\p{Zp}]/u
// Four digits of any script in a row. One class with one bounded count: linear.
const DIGIT_RUN = /\p{Nd}{4}/u
// `@` or `#` where a word starts. One optional character before one class: linear.
const CODE_LINE_MARK = /(?:^|[^\p{L}\p{N}])[@#]/u
// What may not stand directly beside a placeholder: a letter, a digit, or a combining mark
// (which draws on the character before it, so after `{{code}}` it is an accent on the
// code's last digit). One class: linear.
const WORD_CHARACTER = /[\p{L}\p{N}\p{M}]/u
const LETTER = /^\p{L}/u

/** How much of an unknown placeholder's name a problem repeats. */
const MAX_REPORTED_NAME_LENGTH = 40

/**
 * Everything that makes a template unusable for its kind. Empty means it can be saved and
 * sent.
 *
 * The one definition: the settings schema refuses a document with a problem, the tolerant
 * read leaves such a template out, and the server asks again before every send.
 *
 * The checks that are about what is read (the digits, the first letter, what touches a
 * placeholder) are made on the text without the characters that draw nothing, so that a
 * zero-width joiner cannot split a run of digits or stand in front of the first letter.
 *
 * @param kind - The kind of message.
 * @param template - The text as written.
 * @returns The problems. Their messages name a placeholder at most.
 *
 * @example
 * ```ts
 * smsTemplateProblems('sign_in', { text: 'Your sign-in code.' })
 * // [{ field: 'text', code: 'missing_placeholder', placeholder: 'code', message: … }]
 * ```
 */
export function smsTemplateProblems(
  kind: SmsTemplateKind,
  template: SmsTemplate
): SmsTemplateProblem[] {
  const { text } = template
  const rules = SMS_TEMPLATE_RULES[kind]
  const problem = (
    code: SmsTemplateProblemCode,
    message: string,
    placeholder?: string
  ): SmsTemplateProblem => ({
    field: 'text',
    code,
    message,
    ...(placeholder !== undefined && { placeholder }),
  })
  if (text.length > MAX_SMS_TEMPLATE_LENGTH) {
    return [problem('too_long', `must be at most ${MAX_SMS_TEMPLATE_LENGTH} characters`)]
  }
  const seen = withoutInvisibleCharacters(text)
  if (seen.trim() === '') {
    return [problem('empty', 'must not be empty')]
  }
  if (UNPRINTABLE.test(text)) {
    return [problem('control_character', 'must be one line, with no control characters')]
  }
  if (hasHiddenCharacter(text)) {
    return [
      problem(
        'hidden_character',
        'must not contain text-direction controls, private-use or unassigned characters, or half a surrogate pair'
      ),
    ]
  }
  // Both are parsed: a brace the grammar refuses is refused as written, and what touches a
  // placeholder is judged as it is seen.
  const tokens = parseEmailTemplate(seen)
  if (parseEmailTemplate(text) === null || tokens === null) {
    return [
      problem(
        'malformed_braces',
        'a brace must be part of a placeholder written as {{name}}, with no space inside'
      ),
    ]
  }
  const problems: SmsTemplateProblem[] = []
  const allowed = new Set<string>([...rules.required, ...rules.optional])
  const counts = new Map<string, number>()
  for (const token of tokens) {
    if ('placeholder' in token) {
      counts.set(token.placeholder, (counts.get(token.placeholder) ?? 0) + 1)
    }
  }
  for (const [written, count] of counts) {
    if (!allowed.has(written)) {
      // The name is the operator's own text: said back so that it can be found, but bounded.
      const name =
        written.length > MAX_REPORTED_NAME_LENGTH
          ? `${written.slice(0, MAX_REPORTED_NAME_LENGTH)}…`
          : written
      problems.push(
        problem('unknown_placeholder', `{{${name}}} is not a placeholder of this message`, name)
      )
    } else if (count > 1) {
      problems.push(
        problem('repeated_placeholder', `{{${written}}} must be written only once`, written)
      )
    }
  }
  for (const name of rules.required) {
    if (!counts.has(name)) {
      problems.push(problem('missing_placeholder', `the text must contain {{${name}}}`, name))
    }
  }
  const touches = tokens.some((token, index) => {
    if (!('placeholder' in token)) {
      return false
    }
    const [before, after] = [tokens[index - 1], tokens[index + 1]]
    return (
      (before !== undefined && (!('text' in before) || WORD_CHARACTER.test(lastOf(before.text)))) ||
      (after !== undefined && (!('text' in after) || WORD_CHARACTER.test(firstOf(after.text))))
    )
  })
  if (touches) {
    problems.push(
      problem(
        'placeholder_touches_text',
        'a placeholder must stand alone: no letter, digit, combining mark or other placeholder directly before or after it'
      )
    )
  }
  // Every placeholder stands as one letter: what is around it still counts, and a value is
  // never taken for the operator's own digits.
  const standIns = tokens.map((token) => ('text' in token ? token.text : 'x')).join('')
  if (DIGIT_RUN.test(standIns)) {
    problems.push(
      problem('digit_run', 'must not contain four or more digits in a row: only the code may')
    )
  }
  // Folded first, so that a full-width `＠` is the character it is read as.
  if (CODE_LINE_MARK.test(standIns.normalize('NFKC'))) {
    problems.push(
      problem(
        'imitates_code_line',
        'a word must not start with @ or #: that is how the line the server adds is recognised'
      )
    )
  }
  if (readsAsLink(standIns)) {
    problems.push(
      problem(
        'reads_as_link',
        'must not contain a link, an address or a domain name (put a space after a full stop)'
      )
    )
  }
  const [first] = tokens
  if (first === undefined || !('text' in first) || !LETTER.test(first.text)) {
    problems.push(
      problem('leading_non_letter', 'must start with a letter of its own, not with a placeholder')
    )
  }
  return problems
}

function firstOf(text: string): string {
  return String.fromCodePoint(text.codePointAt(0) ?? 0x20)
}

function lastOf(text: string): string {
  return [...text.slice(-2)].at(-1) ?? ' '
}

/**
 * Whether a string is one of {@link SMS_TEMPLATE_KINDS}.
 *
 * @param value - The candidate.
 * @returns `true` for a kind this version knows.
 *
 * @example
 * ```ts
 * isSmsTemplateKind('sign_in') // true
 * isSmsTemplateKind('constructor') // false
 * ```
 */
export function isSmsTemplateKind(value: string): value is SmsTemplateKind {
  return (SMS_TEMPLATE_KINDS as readonly string[]).includes(value)
}

/** Stored text message templates as read back. */
export interface StoredSmsTemplatesRead {
  /** The templates this version can send. */
  templates: SmsTemplates
  /** The known kinds whose stored template was left out: it no longer passes. */
  dropped: SmsTemplateKind[]
  /** How many entries were under a kind this version does not know. */
  unknown: number
}

/**
 * Read stored text message templates, leaving out what this version would not accept.
 *
 * Settings are read on the request path, so a stored document must never fail a read, and a
 * template must never fail a send: a kind this version does not know is dropped, and one
 * that no longer passes {@link smsTemplateProblems} is dropped whole, so its message is the
 * built-in text. What is left out here is absent from every read, the admin API's included,
 * so the next save of the settings removes it for good.
 *
 * @param stored - The stored `sms.templates` value.
 * @returns The usable templates and what was left out.
 *
 * @example
 * ```ts
 * readStoredSmsTemplates({ sign_in: { text: 'No code here.' } })
 * // { templates: {}, dropped: ['sign_in'], unknown: 0 }
 * ```
 */
export function readStoredSmsTemplates(stored: unknown): StoredSmsTemplatesRead {
  const templates: SmsTemplates = {}
  const dropped: SmsTemplateKind[] = []
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) {
    return { templates, dropped, unknown: stored === undefined || stored === null ? 0 : 1 }
  }
  const unknown = Object.keys(stored).filter((key) => !isSmsTemplateKind(key)).length
  // In the list's order, not the stored one.
  for (const kind of SMS_TEMPLATE_KINDS) {
    if (!Object.hasOwn(stored, kind)) {
      continue
    }
    const written = (stored as Record<string, unknown>)[kind]
    const text =
      typeof written === 'object' && written !== null && !Array.isArray(written)
        ? (written as { text?: unknown }).text
        : undefined
    if (typeof text === 'string' && smsTemplateProblems(kind, { text }).length === 0) {
      templates[kind] = { text }
    } else {
      dropped.push(kind)
    }
  }
  return { templates, dropped, unknown }
}

// The GSM 03.38 default alphabet, and the characters of its extension table, which take two
// septets each.
const GSM7_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ ÆæßÉ!"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà'
const GSM7_EXTENDED = '\f^{}\\[~]|€'

/** How a carrier would encode and split a text message. */
export interface SmsSegments {
  /** `gsm7` when every character is in the GSM 7-bit alphabet, else `ucs2`. */
  encoding: 'gsm7' | 'ucs2'
  /** Septets (`gsm7`) or UTF-16 code units (`ucs2`) the text takes. */
  units: number
  /** How many segments it is sent, and billed, as. */
  segments: number
}

/**
 * How many segments a text takes: an estimate of what a carrier bills.
 *
 * One segment holds 160 characters of the GSM 7-bit alphabet (its extension characters
 * count two), and 153 each once the text is split. A single character outside that alphabet
 * makes the whole text UCS-2: 70 UTF-16 code units in one segment, 67 each once split. A
 * provider may count differently at the edges (it does not split a two-septet character or
 * a surrogate pair across segments), so this can be one short for a text at a boundary.
 *
 * @param text - The whole message.
 * @returns The encoding, the units and the segments.
 *
 * @example
 * ```ts
 * smsSegments('Your Acme verification code is 123456.') // { encoding: 'gsm7', units: 38, segments: 1 }
 * ```
 */
export function smsSegments(text: string): SmsSegments {
  let septets = 0
  let gsm = true
  for (const character of text) {
    if (GSM7_BASIC.includes(character)) {
      septets += 1
    } else if (GSM7_EXTENDED.includes(character)) {
      septets += 2
    } else {
      gsm = false
      break
    }
  }
  if (gsm) {
    return {
      encoding: 'gsm7',
      units: septets,
      segments: septets <= 160 ? 1 : Math.ceil(septets / 153),
    }
  }
  const units = text.length
  return { encoding: 'ucs2', units, segments: units <= 70 ? 1 : Math.ceil(units / 67) }
}
