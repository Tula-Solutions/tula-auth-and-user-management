// Plain data and plain functions: this module imports nothing, Zod least of all, so that the
// dashboard's editor, the CLI and an SDK can read which messages exist and what each may say
// without loading a schema library. The schema that uses it is `./email-template-schema`.

/**
 * Every email whose wording an environment can change (ADR 0039): one kind per message the
 * server sends, so that a template never has to say two different things.
 *
 * - `email_verification`, `password_reset`, `sign_in`, `step_up`: the messages that carry a
 *   6-digit code (`sign_in` can carry a link as well).
 * - `account_exists`, `no_account`, `no_account_sign_in`: what is sent instead of a code, so
 *   that a sign-up, a reset and a sign-in answer alike for every address.
 * - the rest: security notices (ADR 0023), one per thing that can have happened.
 *
 * A closed list. Later servers may add kinds: additive.
 *
 * @example
 * ```ts
 * EMAIL_TEMPLATE_KINDS.includes('sign_in') // true
 * ```
 */
export const EMAIL_TEMPLATE_KINDS = [
  'email_verification',
  'password_reset',
  'sign_in',
  'step_up',
  'account_exists',
  'no_account',
  'no_account_sign_in',
  'password_changed',
  'password_added',
  'password_reset_completed',
  'password_added_by_reset',
  'password_set_by_admin',
  'password_added_by_admin',
  'password_removed',
  'new_sign_in',
  'mfa_enabled',
  'mfa_disabled',
  'mfa_reset_by_admin',
  'backup_codes_regenerated',
  'backup_code_used',
  'passkey_added',
  'passkey_removed',
  'identity_linked',
  'identity_unlinked',
] as const

/** One of {@link EMAIL_TEMPLATE_KINDS}. */
export type EmailTemplateKind = (typeof EMAIL_TEMPLATE_KINDS)[number]

/**
 * Every placeholder a template can name, as `{{name}}`.
 *
 * - `appName`: the environment's app name.
 * - `code`: the 6-digit code of a code message.
 * - `link`: the sign-in link. In a body only; the server draws it as its own button, and a
 *   paragraph that names it is left out of a message that has no link.
 * - `expiresInMinutes`: minutes until the code (and link) stop working. A number.
 * - `device`: the device family of a new sign-in (`Chrome on Windows`): one of the server's
 *   fixed names, never the user agent.
 * - `time`: when it happened, in UTC (`2026-10-03 14:05 UTC`).
 * - `provider`: the provider of a connected account, by its fixed name (`Google`).
 * - `backupCodesLeft`: how many unused backup codes are left. A number.
 *
 * Deliberately absent: any address (the recipient's included), an IP address, a user agent,
 * a token, and a URL of any kind other than the server's own `link`.
 *
 * @example
 * ```ts
 * EMAIL_TEMPLATE_PLACEHOLDERS.includes('code') // true
 * ```
 */
export const EMAIL_TEMPLATE_PLACEHOLDERS = [
  'appName',
  'code',
  'link',
  'expiresInMinutes',
  'device',
  'time',
  'provider',
  'backupCodesLeft',
] as const

/** One of {@link EMAIL_TEMPLATE_PLACEHOLDERS}. */
export type EmailTemplatePlaceholder = (typeof EMAIL_TEMPLATE_PLACEHOLDERS)[number]

/**
 * The placeholders whose value always starts with a digit: a code, a number of minutes, a
 * count, and a time (`2026-10-03 14:05 UTC`).
 *
 * A notice's subject must not start with a digit, so one that starts with any of these is
 * refused when it is saved: it would be replaced by the built-in subject at every send. A
 * new placeholder whose value is a number or a date is added here in the same change.
 *
 * @example
 * ```ts
 * EMAIL_TEMPLATE_DIGIT_PLACEHOLDERS.includes('time') // true
 * ```
 */
export const EMAIL_TEMPLATE_DIGIT_PLACEHOLDERS: readonly EmailTemplatePlaceholder[] = [
  'code',
  'expiresInMinutes',
  'time',
  'backupCodesLeft',
]

/** What a kind of message is, which decides the rules its templates are held to. */
export type EmailTemplateCategory = 'code' | 'notice'

/** The rules of one kind's templates. */
export interface EmailTemplateRules {
  /**
   * `code`: the message exists to carry a code. `notice`: it carries none, its template can
   * name no code and no link, and its subject does not lead with a digit. No kind of either
   * category can hold something that reads as a link.
   */
  category: EmailTemplateCategory
  /** Placeholders a body must name: without them the message could not do its job. */
  required: readonly EmailTemplatePlaceholder[]
  /** Placeholders a subject or a body may name besides. */
  optional: readonly EmailTemplatePlaceholder[]
}

const CODE: EmailTemplateRules = {
  category: 'code',
  required: ['code'],
  optional: ['appName', 'expiresInMinutes'],
}
const DECOY: EmailTemplateRules = { category: 'notice', required: [], optional: ['appName'] }
const NOTICE: EmailTemplateRules = {
  category: 'notice',
  required: [],
  optional: ['appName', 'time'],
}

/**
 * What each kind's templates must and may name. Plain data: an editor draws its list of
 * placeholders from it, and the server validates against the same table.
 *
 * A subject may name everything its kind allows except `link`. No kind of the `notice`
 * category lists `code` or `link`, which is what keeps one out of a security notice.
 *
 * @example
 * ```ts
 * EMAIL_TEMPLATE_RULES.sign_in.required // ['code', 'link']
 * ```
 */
export const EMAIL_TEMPLATE_RULES: Readonly<Record<EmailTemplateKind, EmailTemplateRules>> = {
  email_verification: CODE,
  password_reset: CODE,
  // The link is bound to the browser that asked and the code is the way in from any other
  // device (ADR 0024): a sign-in template has to keep both.
  sign_in: { ...CODE, required: ['code', 'link'] },
  step_up: CODE,
  account_exists: DECOY,
  no_account: DECOY,
  no_account_sign_in: DECOY,
  password_changed: NOTICE,
  password_added: NOTICE,
  password_reset_completed: NOTICE,
  password_added_by_reset: NOTICE,
  password_set_by_admin: NOTICE,
  password_added_by_admin: NOTICE,
  password_removed: NOTICE,
  new_sign_in: { ...NOTICE, optional: ['appName', 'time', 'device'] },
  mfa_enabled: NOTICE,
  mfa_disabled: NOTICE,
  mfa_reset_by_admin: NOTICE,
  backup_codes_regenerated: NOTICE,
  backup_code_used: { ...NOTICE, optional: ['appName', 'time', 'backupCodesLeft'] },
  passkey_added: NOTICE,
  passkey_removed: NOTICE,
  identity_linked: { ...NOTICE, optional: ['appName', 'time', 'provider'] },
  identity_unlinked: { ...NOTICE, optional: ['appName', 'time', 'provider'] },
}

/** Longest subject of a template, in characters (UTF-16 code units). */
export const MAX_EMAIL_SUBJECT_LENGTH = 200

/** Longest body of a template, in characters (UTF-16 code units). */
export const MAX_EMAIL_BODY_LENGTH = 2000

/**
 * The most bytes an environment's templates may take together, as the UTF-8 of their JSON.
 *
 * The settings document is read on the request path, cached per instance and replaced whole
 * in one request, which the API caps at 64 KiB: this leaves the rest of the document its
 * room, and is the worst-case size of the section whatever script it is written in.
 *
 * The two caps count different bytes. This one is the UTF-8 of the section's compact JSON;
 * the request's is what arrived on the wire. A client that escapes characters outside
 * ASCII as `\uXXXX`, or indents the document, can be refused for the request's size (413)
 * with a section that is under this cap: send compact UTF-8.
 */
export const MAX_EMAIL_TEMPLATES_BYTES = 40 * 1024

/** One environment's template for one kind: a subject, a body, or both. */
export interface EmailTemplate {
  /** The subject line. Left out: the built-in subject. */
  subject?: string | undefined
  /** The body, as plain text: paragraphs separated by a blank line. Left out: the built-in body. */
  body?: string | undefined
}

/** An environment's templates, by kind. A kind left out sends the built-in copy. */
export type EmailTemplates = { [Kind in EmailTemplateKind]?: EmailTemplate | undefined }

/** A piece of a parsed template: literal text, or a placeholder by name. */
export type EmailTemplateToken = { text: string } | { placeholder: string }

const PLACEHOLDER = /\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g

/**
 * Split a template's text into literal text and `{{name}}` placeholders.
 *
 * The grammar is `{{name}}` and nothing else: a name is ASCII letters and digits starting
 * with a letter, with no space inside the braces. There is no expression, no condition and
 * no escape, so a brace that is not part of a placeholder has no meaning and is refused
 * rather than passed through.
 *
 * @param text - A subject or a body.
 * @returns The tokens in order, or `null` when a `{` or `}` is left over.
 *
 * @example
 * ```ts
 * parseEmailTemplate('Hi {{appName}}') // [{ text: 'Hi ' }, { placeholder: 'appName' }]
 * parseEmailTemplate('Hi {{ appName }}') // null
 * ```
 */
export function parseEmailTemplate(text: string): EmailTemplateToken[] | null {
  const tokens: EmailTemplateToken[] = []
  let from = 0
  for (const match of text.matchAll(PLACEHOLDER)) {
    if (match.index > from) {
      tokens.push({ text: text.slice(from, match.index) })
    }
    tokens.push({ placeholder: match[1] as string })
    from = match.index + match[0].length
  }
  if (from < text.length) {
    tokens.push({ text: text.slice(from) })
  }
  const stray = tokens.some((token) => 'text' in token && /[{}]/.test(token.text))
  return stray ? null : tokens
}

/**
 * The paragraphs of a body: what blank lines separate, with the space around each removed.
 *
 * @param body - A template's body.
 * @returns The paragraphs that hold anything, in order.
 *
 * @example
 * ```ts
 * emailTemplateParagraphs('One.\n\n\nTwo,\nstill two.') // ['One.', 'Two,\nstill two.']
 * ```
 */
export function emailTemplateParagraphs(body: string): string[] {
  return body
    .split(/\n[^\S\n]*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== '')
}

/**
 * Why a template is refused, as a fixed word.
 *
 * - `empty`: nothing but white space and characters that draw nothing.
 * - `too_long`: over {@link MAX_EMAIL_SUBJECT_LENGTH} or {@link MAX_EMAIL_BODY_LENGTH}.
 * - `control_character`: a control character, or a line break in a subject. A body's lines
 *   end in `\n` only.
 * - `hidden_character`: a text-direction control (U+202A to U+202E, U+2066 to U+2069,
 *   U+200E, U+200F, U+061C), a private-use or unassigned code point, or a lone surrogate.
 *   The zero-width joiner and non-joiner and variation selectors are allowed.
 * - `malformed_braces`: a `{` or `}` that is not part of a `{{name}}`.
 * - `unknown_placeholder`: a name this kind does not have, or `link` in a subject.
 * - `missing_placeholder`: the body lacks one its message needs.
 * - `link_beside_code`: a paragraph names the link and the code. The paragraph of a link is
 *   left out of a message that has none, and the code would go with it.
 * - `reads_as_link`: it holds something a mail client would turn into a link (every kind).
 * - `leading_digit`: a notice's subject starts with a digit, or with a placeholder of
 *   {@link EMAIL_TEMPLATE_DIGIT_PLACEHOLDERS}, once what is invisible is set aside.
 */
export type EmailTemplateProblemCode =
  | 'empty'
  | 'too_long'
  | 'control_character'
  | 'hidden_character'
  | 'malformed_braces'
  | 'unknown_placeholder'
  | 'missing_placeholder'
  | 'link_beside_code'
  | 'reads_as_link'
  | 'leading_digit'

/** One reason a template is refused. */
export interface EmailTemplateProblem {
  /** Which part. */
  field: 'subject' | 'body'
  /** Why, as a fixed word. */
  code: EmailTemplateProblemCode
  /** The placeholder's name, for `unknown_placeholder` and `missing_placeholder`. */
  placeholder?: string
  /** The reason in words. It names a placeholder at most, never the template's text. */
  message: string
}

// Control characters and line or paragraph separators: a subject is one header line.
const SUBJECT_UNPRINTABLE = /[\p{Cc}\p{Zl}\p{Zp}]/u
// The same for a body, where `\n` alone separates lines.
const BODY_UNPRINTABLE = /[^\P{Cc}\n]|[\p{Zl}\p{Zp}]/u

/**
 * Characters a template may not hold at all: what changes the order text is shown in
 * without being seen (the bidirectional embeddings, overrides and isolates, the two
 * direction marks and the Arabic letter mark), and code points that are nobody's
 * (private-use, unassigned, half a surrogate pair).
 *
 * Refused, never stripped: the message sent is the template saved. The zero-width joiner and
 * non-joiner and the variation selectors are not here, on purpose: Persian, Arabic and Indic
 * text and emoji are written with them. One character class, so the match is linear.
 */
const HIDDEN = /[\u{202A}-\u{202E}\u{2066}-\u{2069}\u{200E}\u{200F}\u{061C}\p{Co}\p{Cn}\p{Cs}]/u

/**
 * Whether text holds a character no template, and no app name, may hold: a text-direction
 * control (U+202A to U+202E, U+2066 to U+2069, U+200E, U+200F, U+061C), a private-use or
 * unassigned code point, or half a surrogate pair.
 *
 * The zero-width joiner and non-joiner and the variation selectors are not among them:
 * Persian, Arabic and Indic text and emoji are written with them.
 *
 * @param text - Any text.
 * @returns `true` when it holds one.
 *
 * @example
 * ```ts
 * hasHiddenCharacter('abc\u{202E}def') // true
 * hasHiddenCharacter('می\u{200C}خواهم') // false
 * ```
 */
export function hasHiddenCharacter(text: string): boolean {
  return HIDDEN.test(text)
}

// What a reader cannot see and a mail client ignores when it looks for an address: every
// format character (the joiners among them), every variation selector, and everything else
// Unicode says is ignorable by default (the combining grapheme joiner, the Khmer inherent
// vowels, the Hangul fillers: marks and letters by class, drawn as nothing).
const INVISIBLE = /[\p{Cf}\p{Variation_Selector}\p{Default_Ignorable_Code_Point}]/gu

/**
 * Text as a reader sees it, for the checks that are about what is seen: without the
 * characters that draw nothing (format characters, variation selectors, and whatever else is
 * ignorable by default) and without white space at its ends.
 *
 * Only ever for a check. What is stored and sent keeps every character it was given.
 *
 * @param text - Any text.
 * @returns The text without what is invisible.
 *
 * @example
 * ```ts
 * visibleEmailText('\u{200D}123 ') // '123'
 * ```
 */
export function visibleEmailText(text: string): string {
  return text.replace(INVISIBLE, '').trim()
}

/**
 * The schemes that need no `//` and that a mail client, or the application it hands off to,
 * acts on: an address to write to, a number to call, an account to message, a document to
 * run. A closed list, matched as a word followed by a colon and something that is not a
 * space, so that `Note: your code`, `Tel: 555 0100` and `10:30` are sentences. Every scheme
 * written with `://` is refused whatever its name.
 *
 * @example
 * ```ts
 * EMAIL_LINK_SCHEMES.includes('mailto') // true
 * ```
 */
export const EMAIL_LINK_SCHEMES = [
  'mailto',
  'tel',
  'sms',
  'smsto',
  'mms',
  'xmpp',
  'sip',
  'sips',
  'facetime',
  'facetime-audio',
  'skype',
  'callto',
  'whatsapp',
  'tg',
  'viber',
  'signal',
  'msteams',
  'geo',
  'maps',
  'data',
  'javascript',
  'vbscript',
  'file',
  'blob',
  'intent',
] as const

// Longest first inside the alternation is not needed: each name is followed by the colon.
const SCHEME = new RegExp(
  `://|(?<![\\p{L}\\p{N}_-])(?:${EMAIL_LINK_SCHEMES.join('|')}):(?=\\S)`,
  'iu'
)
const WWW = /(?:^|[^\p{L}\p{N}])www[.。]/iu
// A label, a dot and two or more letters: `example.com`, `help@example.co`, and also a
// sentence with no space after its full stop, which a mail client links just the same.
const DOMAIN = /[\p{L}\p{N}][.。]\p{L}{2,}/u
// Four groups of one to three digits joined by dots: an IPv4 address, which is a host with
// no letter in it. Bounded repetitions of one class each, so the match is linear.
const IPV4 = /\p{Nd}{1,3}(?:[.。]\p{Nd}{1,3}){3}/u

/**
 * Whether text holds something a mail client would turn into a link, or that tells a reader
 * where to go: a scheme (anything with `://`, or one of {@link EMAIL_LINK_SCHEMES} and a
 * colon), `www.`, a bare domain name, or an IPv4 address.
 *
 * It errs towards refusing. The domain rule is "a letter or digit, a dot, two or more
 * letters", after compatibility forms are folded (`ｅｘａｍｐｌｅ．ｃｏｍ`) and invisible characters
 * removed, so it also catches an email address and a sentence with no space after its full
 * stop (`changed.If`): mail clients link those too. Abbreviations with single letters
 * (`e.g.`), numbers (`3.5`, `1.2.3`), a time (`10:30`) and a label (`Note: …`) pass.
 *
 * What it does not catch, on purpose: a name spelled so that no mail client links it
 * (`example . com`, `example dot com`, a name broken across a line).
 *
 * @param text - Text with its placeholders already replaced by a letter.
 * @returns `true` when it reads as a link.
 *
 * @example
 * ```ts
 * readsAsLink('Visit example.com') // true
 * readsAsLink('It was changed. If this was you, relax.') // false
 * ```
 */
export function readsAsLink(text: string): boolean {
  const seen = text.normalize('NFKC').replace(INVISIBLE, '')
  return SCHEME.test(seen) || WWW.test(seen) || DOMAIN.test(seen) || IPV4.test(seen)
}

/** How much of an unknown placeholder's name a problem repeats. */
const MAX_REPORTED_NAME_LENGTH = 40

function placeholdersOf(tokens: readonly EmailTemplateToken[]): string[] {
  return tokens.flatMap((token) => ('placeholder' in token ? [token.placeholder] : []))
}

/** The text with every placeholder standing as one letter: what is around it still counts. */
function withStandIns(tokens: readonly EmailTemplateToken[]): string {
  return tokens.map((token) => ('text' in token ? token.text : 'x')).join('')
}

/**
 * The text as its first visible character will be: a placeholder whose value always starts
 * with a digit stands as one, every other as a letter.
 */
function withLeadingStandIns(tokens: readonly EmailTemplateToken[]): string {
  const digits: readonly string[] = EMAIL_TEMPLATE_DIGIT_PLACEHOLDERS
  return tokens
    .map((token) => ('text' in token ? token.text : digits.includes(token.placeholder) ? '1' : 'x'))
    .join('')
}

function fieldProblems(
  kind: EmailTemplateKind,
  field: 'subject' | 'body',
  text: string
): EmailTemplateProblem[] {
  const rules = EMAIL_TEMPLATE_RULES[kind]
  const problem = (
    code: EmailTemplateProblemCode,
    message: string,
    placeholder?: string
  ): EmailTemplateProblem => ({
    field,
    code,
    message,
    ...(placeholder !== undefined && { placeholder }),
  })
  const max = field === 'subject' ? MAX_EMAIL_SUBJECT_LENGTH : MAX_EMAIL_BODY_LENGTH
  if (text.length > max) {
    return [problem('too_long', `must be at most ${max} characters`)]
  }
  // Judged as a reader sees it: a subject of zero-width characters is an empty subject.
  if (visibleEmailText(text) === '') {
    return [problem('empty', 'must not be empty')]
  }
  if ((field === 'subject' ? SUBJECT_UNPRINTABLE : BODY_UNPRINTABLE).test(text)) {
    return [
      problem(
        'control_character',
        field === 'subject'
          ? 'must not contain control characters or line breaks'
          : 'must not contain control characters (lines end in \\n)'
      ),
    ]
  }
  if (hasHiddenCharacter(text)) {
    return [
      problem(
        'hidden_character',
        'must not contain text-direction controls, private-use or unassigned characters, or half a surrogate pair'
      ),
    ]
  }
  const tokens = parseEmailTemplate(text)
  if (tokens === null) {
    return [
      problem(
        'malformed_braces',
        'a brace must be part of a placeholder written as {{name}}, with no space inside'
      ),
    ]
  }
  const problems: EmailTemplateProblem[] = []
  const allowed = new Set<string>([...rules.required, ...rules.optional])
  if (field === 'subject') {
    allowed.delete('link')
  }
  const named = new Set(placeholdersOf(tokens))
  for (const written of named) {
    if (!allowed.has(written)) {
      // The name is the operator's own text: said back so that it can be found, but bounded.
      const name =
        written.length > MAX_REPORTED_NAME_LENGTH
          ? `${written.slice(0, MAX_REPORTED_NAME_LENGTH)}…`
          : written
      problems.push(
        problem(
          'unknown_placeholder',
          `{{${name}}} is not a placeholder of this ${field === 'subject' ? 'subject' : 'message'}`,
          name
        )
      )
    }
  }
  if (field === 'body') {
    for (const name of rules.required) {
      if (!named.has(name)) {
        problems.push(problem('missing_placeholder', `the body must contain {{${name}}}`, name))
      }
    }
    const together = emailTemplateParagraphs(text).some((paragraph) => {
      const inside = new Set(placeholdersOf(parseEmailTemplate(paragraph) ?? []))
      return inside.has('link') && inside.has('code')
    })
    if (together) {
      problems.push(
        problem(
          'link_beside_code',
          '{{link}} and {{code}} must be in different paragraphs: the paragraph of a link is left out of a message that has none'
        )
      )
    }
  }
  // Every kind: the only link in any email is the server's own, drawn for `{{link}}`.
  if (readsAsLink(withStandIns(tokens))) {
    problems.push(
      problem(
        'reads_as_link',
        'must not contain a link, an address or a domain name (put a space after a full stop)'
      )
    )
  }
  if (
    rules.category === 'notice' &&
    field === 'subject' &&
    /^\p{Nd}/u.test(visibleEmailText(withLeadingStandIns(tokens)))
  ) {
    problems.push(
      problem(
        'leading_digit',
        'the subject of a notice must not start with a digit, or with a placeholder that is always a number or a time'
      )
    )
  }
  return problems
}

/**
 * Everything that makes a template unusable for its kind. Empty means it can be saved and
 * sent.
 *
 * The one definition: the settings schema refuses a document with a problem, and the server
 * asks again before every send, so a template stored by another version is never sent
 * half-understood.
 *
 * @param kind - The kind of message.
 * @param template - The subject and body as written.
 * @returns The problems, subject first. Their messages name a placeholder at most.
 *
 * @example
 * ```ts
 * emailTemplateProblems('sign_in', { body: 'Your code is {{code}}.' })
 * // [{ field: 'body', code: 'missing_placeholder', placeholder: 'link', message: … }]
 * ```
 */
export function emailTemplateProblems(
  kind: EmailTemplateKind,
  template: EmailTemplate
): EmailTemplateProblem[] {
  return [
    ...(template.subject === undefined ? [] : fieldProblems(kind, 'subject', template.subject)),
    ...(template.body === undefined ? [] : fieldProblems(kind, 'body', template.body)),
  ]
}

/**
 * Whether a string is one of {@link EMAIL_TEMPLATE_KINDS}.
 *
 * @param value - The candidate.
 * @returns `true` for a kind this version knows.
 *
 * @example
 * ```ts
 * isEmailTemplateKind('sign_in') // true
 * isEmailTemplateKind('constructor') // false
 * ```
 */
export function isEmailTemplateKind(value: string): value is EmailTemplateKind {
  return (EMAIL_TEMPLATE_KINDS as readonly string[]).includes(value)
}

/**
 * The bytes an environment's templates take: the UTF-8 of their JSON.
 *
 * @param templates - The templates, by kind.
 * @returns The byte count; `2` for none.
 *
 * @example
 * ```ts
 * emailTemplatesBytes({}) // 2
 * ```
 */
export function emailTemplatesBytes(templates: EmailTemplates): number {
  return new TextEncoder().encode(JSON.stringify(templates)).length
}

/** Stored templates as read back. */
export interface StoredEmailTemplatesRead {
  /** The templates this version can send: of each, the parts that pass. */
  templates: EmailTemplates
  /** The known kinds with a stored subject or body that was left out: it no longer passes. */
  dropped: EmailTemplateKind[]
  /** How many entries were under a kind this version does not know. */
  unknown: number
}

/**
 * One stored template, part by part: the subject and the body are judged apart, as they are
 * at a send, so that one which still passes is not lost with one that does not.
 */
function storedTemplate(
  kind: EmailTemplateKind,
  stored: unknown
): { template: EmailTemplate | null; whole: boolean } {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) {
    return { template: null, whole: false }
  }
  const written = stored as { subject?: unknown; body?: unknown }
  const template: EmailTemplate = {}
  let whole = written.subject !== undefined || written.body !== undefined
  for (const field of ['subject', 'body'] as const) {
    const value = written[field]
    if (value === undefined) {
      continue
    }
    if (typeof value === 'string' && emailTemplateProblems(kind, { [field]: value }).length === 0) {
      template[field] = value
    } else {
      whole = false
    }
  }
  const kept = template.subject !== undefined || template.body !== undefined
  return { template: kept ? template : null, whole }
}

/**
 * Read stored templates, leaving out what this version would not accept.
 *
 * Settings are read on the request path, so a stored document must never fail a read. A kind
 * this version does not know (a newer server wrote it before a rollback) is dropped. A
 * subject or a body that no longer passes {@link emailTemplateProblems} (a placeholder since
 * removed) is dropped **whole and alone**: that part goes out as the built-in copy, never
 * half-filled, and the other part of the same template, if it passes, is kept. Templates
 * that together are over {@link MAX_EMAIL_TEMPLATES_BYTES} are all dropped: cutting the set
 * down would choose which survive.
 *
 * What is left out here is absent from every read, the admin API's included, so the next
 * save of the settings, which replaces the whole document, removes it for good.
 *
 * @param stored - The stored `emails.templates` value.
 * @returns The usable templates and what was left out.
 *
 * @example
 * ```ts
 * readStoredEmailTemplates({ step_up: { body: 'No code here.' } })
 * // { templates: {}, dropped: ['step_up'], unknown: 0 }
 * ```
 */
export function readStoredEmailTemplates(stored: unknown): StoredEmailTemplatesRead {
  const templates: EmailTemplates = {}
  const dropped: EmailTemplateKind[] = []
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) {
    return { templates, dropped, unknown: stored === undefined || stored === null ? 0 : 1 }
  }
  const unknown = Object.keys(stored).filter((key) => !isEmailTemplateKind(key)).length
  // In the list's order, not the stored one: what is reported must not depend on how a
  // database orders the keys of a document.
  for (const key of EMAIL_TEMPLATE_KINDS) {
    if (!Object.hasOwn(stored, key)) {
      continue
    }
    const { template, whole } = storedTemplate(key, (stored as Record<string, unknown>)[key])
    if (!whole) {
      dropped.push(key)
    }
    if (template !== null) {
      templates[key] = template
    }
  }
  if (emailTemplatesBytes(templates) > MAX_EMAIL_TEMPLATES_BYTES) {
    return { templates: {}, dropped: [...dropped, ...kindsOf(templates)], unknown }
  }
  return { templates, dropped, unknown }
}

function kindsOf(templates: EmailTemplates): EmailTemplateKind[] {
  return EMAIL_TEMPLATE_KINDS.filter((kind) => Object.hasOwn(templates, kind))
}
