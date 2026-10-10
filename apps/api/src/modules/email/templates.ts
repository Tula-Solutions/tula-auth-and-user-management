import {
  DEFAULT_APP_NAME,
  EMAIL_TEMPLATE_RULES,
  type EmailTemplate,
  type EmailTemplateKind,
  type EmailTemplatePlaceholder,
  type EmailTemplateToken,
  emailTemplateParagraphs,
  emailTemplateProblems,
  MAX_APP_NAME_LENGTH,
  type OAuthProvider,
  parseEmailTemplate,
  visibleEmailText,
  withoutHiddenCharacters,
} from '@tula/contract'
import type { MailMessage } from '~/ports/mailer'

/** Who an email is from, as far as the reader is concerned: the environment's `app` settings. */
export interface EmailBrand {
  /** The app's name. Operator input: it is cleaned before it is used anywhere. */
  name: string
  /** Where to ask for help, or `null` to leave the line out. */
  supportEmail: string | null
}

/** An emailed 6-digit code, and optionally a link that does the same. */
export interface CodeMessage {
  type: 'email_verification' | 'password_reset' | 'sign_in' | 'step_up'
  code: string
  /** Minutes until the code and link expire. */
  ttlMinutes: number
  /** Magic link, when the flow offers one. */
  linkUrl?: string
}

/** A notice that stands in for a code, so sign-up and reset answer alike for every address. */
export interface NoticeMessage {
  type: 'account_exists' | 'no_account' | 'no_account_sign_in'
}

/**
 * A security notice: the account's password was changed, or a first one was added.
 *
 * It carries no code and no link: nothing in it acts on the account (ADR 0023).
 */
export interface PasswordChangedMessage {
  type: 'password_changed'
  /**
   * How it was changed: by the signed-in user (`self`), by a completed password reset (`reset`)
   * or by an administrator (`admin`). `verification` is the one notice about a password that
   * was **removed**: the owner proved the address for the first time by signing in with an
   * emailed code or link, and the password the account was made with went with that (ADR 0024).
   */
  by: 'self' | 'reset' | 'admin' | 'verification'
  /** `true` when the account had no password before, so one was added rather than replaced. */
  added: boolean
  /** When the password was stored. */
  at: Date
}

/**
 * A security notice: the account was signed in to from a device family none of its earlier
 * sessions has. No code and no link.
 */
export interface NewSignInMessage {
  type: 'new_sign_in'
  /**
   * The device family, from `deviceFamily` in `~/lib/device`: one of its fixed names, never the
   * user agent itself, which is text the client chose.
   */
  device: string
  /** When the session began. */
  at: Date
  /** The address the sign-in came from, as stored with the session, or `null` to leave it out. */
  ipAddress: string | null
}

/**
 * Tells an account's owner that its two-step verification changed (ADR 0025). Never carries a
 * secret or a backup code.
 */
export interface MfaChangedMessage {
  type: 'mfa_changed'
  /**
   * What happened: it was turned on, turned off by someone signed in, reset by an
   * administrator, the backup codes were replaced, a backup code was used to sign in, or a
   * passkey was added or removed (ADR 0027).
   */
  change:
    | 'enabled'
    | 'disabled'
    | 'admin_reset'
    | 'backup_codes_regenerated'
    | 'backup_code_used'
    | 'passkey_added'
    | 'sms_enabled'
    | 'sms_removed'
    | 'passkey_removed'
  /** When it happened. */
  at: Date
  /** For `backup_code_used`: how many unused backup codes are left. */
  remaining?: number
}

/**
 * Tells an account's owner that a provider account (Google, GitHub, Apple, Microsoft, Discord, LinkedIn, X, Facebook) was connected to it
 * or disconnected from it (ADR 0026). Never carries anything of the provider account itself.
 */
export interface IdentityChangedMessage {
  type: 'identity_changed'
  /** Connected, or disconnected. */
  change: 'linked' | 'unlinked'
  /** Which provider. One of a fixed set of names, never text from the provider. */
  provider: OAuthProvider
  /** When it happened. */
  at: Date
}

/** An email that tells an account's owner about a change to who can get in. */
export type SecurityNoticeMessage =
  | PasswordChangedMessage
  | NewSignInMessage
  | MfaChangedMessage
  | IdentityChangedMessage

/** Every email Tula sends. Adding a message means adding its copy to this module, nowhere else. */
export type EmailMessage = CodeMessage | NoticeMessage | SecurityNoticeMessage

/** What a message says, before the layout is applied. `{app}` is replaced by the app's name. */
interface Copy {
  /** Subject after the code (for a code message) or the whole subject (for a notice). */
  subject: string
  /** Paragraphs before the code. */
  lead: string[]
  /** Label of the link button of a code message. */
  action?: string
  /** What introduces the link in the text part, when it needs more than "Or open this link". */
  linkLead?: string
  /** Facts shown between the lead and the closing, one `label: value` per line. */
  details?: [label: string, value: string][]
  /** Paragraphs after the code. */
  closing: string[]
}

const IGNORE = "If you didn't request this, you can safely ignore this email."

const COPY: Record<(CodeMessage | NoticeMessage)['type'], Copy> = {
  email_verification: {
    subject: 'is your {app} verification code',
    lead: ['Enter this code to verify your email address for {app}:'],
    action: 'Verify email',
    closing: [IGNORE],
  },
  password_reset: {
    subject: 'is your {app} password reset code',
    lead: ['Enter this code to reset your {app} password:'],
    action: 'Reset password',
    closing: [IGNORE],
  },
  sign_in: {
    subject: 'is your {app} sign-in code',
    lead: ['Enter this code to sign in to {app}:'],
    action: 'Sign in to {app}',
    // The link is bound to the browser that asked for it (ADR 0024), so the email says so
    // rather than let someone on another device wonder why it did nothing.
    linkLead:
      'Or, in the browser where you asked to sign in, open this link (on any other device, use the code)',
    closing: [
      "If you didn't ask to sign in, you can safely ignore this email. Nobody can sign in without what is in it.",
    ],
  },
  step_up: {
    subject: 'is your {app} confirmation code',
    lead: [
      'You are about to change how your {app} account is protected. Enter this code to confirm it is you:',
    ],
    closing: [
      "If you didn't ask for this, someone may be signed in to your account: open {app}, sign out of the devices you do not recognise and do not share this code.",
    ],
  },
  account_exists: {
    subject: 'Your {app} account already exists',
    lead: [
      'Someone tried to create a {app} account with this email address, but you already have one.',
      'If that was you, sign in instead. If you have forgotten your password, you can reset it from the sign-in screen.',
    ],
    closing: ["If it wasn't you, you can safely ignore this email. Your account has not changed."],
  },
  no_account: {
    subject: '{app} password reset requested',
    lead: [
      'Someone asked to reset the {app} password for this email address, but there is no account for it.',
      'If that was you, you may have signed up with a different address, or you can create an account.',
    ],
    closing: ["If it wasn't you, you can safely ignore this email."],
  },
  no_account_sign_in: {
    subject: '{app} sign-in requested',
    lead: [
      'Someone asked to sign in to {app} with this email address, but there is no account for it.',
      'If that was you, you may have signed up with a different address, or you can create an account.',
    ],
    closing: ["If it wasn't you, you can safely ignore this email."],
  },
}

const SIGNED_OUT = 'Every device that was signed in has been signed out.'
const RESET_NOW = 'open {app} and reset your password from the sign-in screen right away'

/**
 * A moment as text nobody can misread: `2026-10-03 14:05 UTC`. Always UTC, since the server
 * does not know where the reader is.
 */
function utc(at: Date): string {
  const iso = at.toISOString()
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
}

/** What a password notice says happened, by who did it and whether a password existed before. */
function passwordChange({ by, added }: PasswordChangedMessage): string[] {
  if (by === 'verification') {
    return [
      'You confirmed this email address by signing in to {app} with a code or link sent to it.',
      'Your account had a password that was set before the address was confirmed, so it was removed: nobody who knew it can sign in with it.',
      'To sign in with a password, choose a new one by resetting it from the sign-in screen.',
    ]
  }
  if (by === 'admin') {
    return [
      added
        ? 'An administrator of {app} added a password to your account.'
        : 'An administrator of {app} set a new password for your account.',
      SIGNED_OUT,
    ]
  }
  if (by === 'reset') {
    return [
      added
        ? 'A password was added to your {app} account, using a code sent to this email address.'
        : 'The password for your {app} account was reset, using a code sent to this email address.',
      SIGNED_OUT,
    ]
  }
  return [
    added
      ? 'A password was added to your {app} account by someone signed in to it.'
      : 'The password for your {app} account was changed by someone signed in to it.',
    'Every other device was signed out.',
  ]
}

/** Subject and first paragraph of each two-step verification notice. */
const MFA_COPY: Record<MfaChangedMessage['change'], [subject: string, lead: string]> = {
  enabled: [
    'Two-step verification was turned on for your {app} account',
    'Two-step verification was turned on for your {app} account. Signing in now needs a code from your authenticator app as well. Every other device was signed out.',
  ],
  disabled: [
    'Two-step verification was turned off for your {app} account',
    'Two-step verification was turned off for your {app} account by someone signed in to it. Signing in no longer asks for a code from an authenticator app.',
  ],
  admin_reset: [
    'Two-step verification was reset for your {app} account',
    'An administrator of {app} reset two-step verification for your account. Your authenticator app, backup codes and passkeys no longer work, and every device was signed out.',
  ],
  backup_codes_regenerated: [
    'New backup codes were created for your {app} account',
    'New backup codes were created for your {app} account by someone signed in to it. The earlier backup codes no longer work.',
  ],
  backup_code_used: [
    'A backup code was used to sign in to your {app} account',
    'A backup code was used instead of your authenticator app to sign in to your {app} account. That code cannot be used again.',
  ],
  passkey_added: [
    'A passkey was added to your {app} account',
    'A passkey was added to your {app} account by someone signed in to it. It can be used to sign in without a password.',
  ],
  passkey_removed: [
    'A passkey was removed from your {app} account',
    'A passkey was removed from your {app} account by someone signed in to it. It can no longer be used to sign in.',
  ],
  sms_enabled: [
    'Texted codes were turned on as the second step for your {app} account',
    'A code texted to the phone number on your {app} account is now the second step of signing in. Every other device was signed out.',
  ],
  sms_removed: [
    'Texted codes are no longer the second step for your {app} account',
    'A code texted to your phone is no longer the second step of signing in to your {app} account. This happens when it is turned off, or when the phone number on the account is changed or removed.',
  ],
}

/** The copy of a two-step verification notice. */
function mfaCopy(message: MfaChangedMessage): Copy {
  const [subject, lead] = MFA_COPY[message.change]
  return {
    subject,
    lead: [lead],
    details: [
      ['When', utc(message.at)],
      ...(message.remaining === undefined
        ? []
        : ([['Backup codes left', String(message.remaining)]] as [string, string][])),
    ],
    closing: [
      message.change === 'admin_reset'
        ? 'If you expected this, sign in and turn two-step verification on again.'
        : 'If this was you, there is nothing more to do.',
      `If it wasn't you, or you did not expect it, ${RESET_NOW}.`,
    ],
  }
}

/** How each provider is named in an email. Fixed names: nothing from a provider reaches one. */
const PROVIDER_NAMES: Record<IdentityChangedMessage['provider'], string> = {
  google: 'Google',
  github: 'GitHub',
  apple: 'Apple',
  microsoft: 'Microsoft',
  discord: 'Discord',
  linkedin: 'LinkedIn',
  x: 'X',
  facebook: 'Facebook',
}

/** The copy of a connected-account notice. */
function identityCopy(message: IdentityChangedMessage): Copy {
  const provider = PROVIDER_NAMES[message.provider]
  const linked = message.change === 'linked'
  return {
    subject: linked
      ? `A ${provider} account was connected to your {app} account`
      : `A ${provider} account was disconnected from your {app} account`,
    lead: [
      linked
        ? `A ${provider} account was connected to your {app} account. It can now be used to sign in.`
        : `A ${provider} account was disconnected from your {app} account. It can no longer be used to sign in.`,
    ],
    details: [['When', utc(message.at)]],
    closing: [
      'If this was you, there is nothing more to do.',
      `If it wasn't you, or you did not expect it, ${RESET_NOW}, then review the connected accounts in your profile.`,
    ],
  }
}

/** The copy of a security notice. Built per message: what it says depends on what happened. */
function securityCopy(message: SecurityNoticeMessage): Copy {
  if (message.type === 'mfa_changed') {
    return mfaCopy(message)
  }
  if (message.type === 'identity_changed') {
    return identityCopy(message)
  }
  if (message.type === 'new_sign_in') {
    return {
      subject: 'New sign-in to your {app} account',
      lead: [
        'Your {app} account was just signed in to from a device we have not seen it used on before.',
      ],
      details: [
        ['Device', message.device],
        ['When', utc(message.at)],
        ...(message.ipAddress ? ([['IP address', message.ipAddress]] as [string, string][]) : []),
      ],
      closing: [
        'If this was you, you can ignore this email.',
        `If it wasn't you, ${RESET_NOW}. Resetting the password signs every device out.`,
      ],
    }
  }
  if (message.by === 'verification') {
    return {
      subject: 'The password was removed from your {app} account',
      lead: [passwordChange(message).join(' ')],
      details: [['When', utc(message.at)]],
      closing: [
        'If this was you, there is nothing more to do.',
        `If you did not just sign in, ${RESET_NOW}.`,
      ],
    }
  }
  return {
    subject: message.added
      ? 'A password was added to your {app} account'
      : 'Your {app} password was changed',
    lead: [passwordChange(message).join(' ')],
    details: [['When', utc(message.at)]],
    closing: [
      message.by === 'admin'
        ? 'If you expected this, there is nothing more to do.'
        : 'If this was you, there is nothing more to do.',
      `If it wasn't you, or you did not expect it, ${RESET_NOW}.`,
    ],
  }
}

function isSecurityNotice(message: EmailMessage): message is SecurityNoticeMessage {
  return (
    message.type === 'password_changed' ||
    message.type === 'new_sign_in' ||
    message.type === 'mfa_changed' ||
    message.type === 'identity_changed'
  )
}

// Control characters and line or paragraph separators: anything that could end a header line.
const UNPRINTABLE = /[\p{Cc}\p{Zl}\p{Zp}]+/gu

/**
 * Make an app name safe to put in an email header.
 *
 * The settings API already refuses control characters, but the name is operator input that
 * reaches a mail header, so it is cleaned again here rather than trusted: a line break in a
 * subject is how a header is injected. What the settings refuse in a name since ADR 0039
 * (a text-direction control, a private-use or unassigned character, half a surrogate pair)
 * is taken out too, by the contract's own definition: a name stored before that rule is
 * still read, and must not reorder the subject it is put into.
 *
 * @param name - The configured name.
 * @returns The name on one line, at most {@link MAX_APP_NAME_LENGTH} characters, or the default
 *   name when nothing printable is left.
 */
export function displayName(name: string): string {
  const cleaned = withoutHiddenCharacters(name)
    .replace(UNPRINTABLE, ' ')
    .trim()
    .slice(0, MAX_APP_NAME_LENGTH)
    .trim()
  return cleaned || DEFAULT_APP_NAME
}

/**
 * Escape a value for HTML text and for a double-quoted attribute.
 *
 * @param value - Any string.
 * @returns The string with `& < > " '` replaced by entities.
 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

const BODY_STYLE =
  'margin:0;padding:24px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;color:#1a1a1a'
const CODE_STYLE = 'font-size:28px;font-weight:600;letter-spacing:4px'
const FOOTER_STYLE = 'margin-top:32px;font-size:13px;color:#666'

function paragraph(text: string): string {
  return `<p>${escapeHtml(text)}</p>`
}

function detailLine([label, value]: [string, string]): string {
  return `${label}: ${value}`
}

/**
 * Which template a message is sent with: the kind an environment's wording is saved under.
 *
 * One kind per thing a message can say, so a template never has to mean two things. The
 * `switch` is exhaustive: a message added to {@link EmailMessage} does not compile until it
 * has a kind here, and `wording.test.ts` holds the kinds to the contract's list.
 *
 * @param message - The message.
 * @returns Its kind.
 */
export function templateKind(message: EmailMessage): EmailTemplateKind {
  switch (message.type) {
    case 'email_verification':
    case 'password_reset':
    case 'sign_in':
    case 'step_up':
    case 'account_exists':
    case 'no_account':
    case 'no_account_sign_in':
    case 'new_sign_in':
      return message.type
    case 'password_changed':
      if (message.by === 'verification') {
        return 'password_removed'
      }
      if (message.by === 'admin') {
        return message.added ? 'password_added_by_admin' : 'password_set_by_admin'
      }
      if (message.by === 'reset') {
        return message.added ? 'password_added_by_reset' : 'password_reset_completed'
      }
      return message.added ? 'password_added' : 'password_changed'
    case 'mfa_changed':
      return MFA_KINDS[message.change]
    case 'identity_changed':
      return message.change === 'linked' ? 'identity_linked' : 'identity_unlinked'
    default:
      return message satisfies never
  }
}

const MFA_KINDS: Record<MfaChangedMessage['change'], EmailTemplateKind> = {
  enabled: 'mfa_enabled',
  disabled: 'mfa_disabled',
  admin_reset: 'mfa_reset_by_admin',
  backup_codes_regenerated: 'backup_codes_regenerated',
  backup_code_used: 'backup_code_used',
  passkey_added: 'passkey_added',
  passkey_removed: 'passkey_removed',
  sms_enabled: 'sms_factor_enabled',
  sms_removed: 'sms_factor_removed',
}

/** Everything about a message that both the built-in copy and a template are laid out from. */
interface Parts {
  /** The cleaned app name. */
  app: string
  /** Whether the message is a security notice. */
  notice: boolean
  copy: Copy
  /** The message itself when it carries a code. */
  code: CodeMessage | null
  /** The footer's support line, or `null`. */
  support: string | null
  /** The facts of a notice, one `label: value` per line. */
  details: string[]
  /** What a notice says last when a support address is set. */
  supportLine: string | null
}

function partsOf(brand: EmailBrand, message: EmailMessage): Parts {
  const notice = isSecurityNotice(message)
  const copy = notice ? securityCopy(message) : COPY[message.type]
  return {
    app: displayName(brand.name),
    notice,
    copy,
    code: 'code' in message ? message : null,
    support: brand.supportEmail ? `Need help? Contact ${brand.supportEmail}` : null,
    details: (copy.details ?? []).map(detailLine),
    supportLine:
      notice && brand.supportEmail
        ? `If you cannot get back in to your account, contact ${brand.supportEmail}.`
        : null,
  }
}

/** The one layout: the paragraphs of a message between the document's frame and its footer. */
function layout(parts: Parts, text: string[], html: string[]): Pick<MailMessage, 'text' | 'html'> {
  const { app, support } = parts
  return {
    text: [...text, ['--', app, ...(support ? [support] : [])].join('\n')].join('\n\n'),
    html: [
      '<!doctype html>',
      `<html><body style="${BODY_STYLE}">`,
      ...html,
      `<p style="${FOOTER_STYLE}">${escapeHtml(app)}${
        support ? `<br>${escapeHtml(support)}` : ''
      }</p>`,
      '</body></html>',
    ].join('\n'),
  }
}

/**
 * Render an email: the one layout every message shares, as plain text and as HTML.
 *
 * - The subject and the body name the app; the footer gives the support address when one is set.
 * - A code leads the subject, so it can be read from a notification without opening the email
 *   (and so the conformance runner can find it).
 * - Every interpolated value is HTML-escaped in the HTML part, the app name included.
 * - A security notice (password changed, new sign-in) never leads its subject with digits and
 *   carries no code and no link; when a support address is set it says to write there if the
 *   reader cannot get back in.
 *
 * This is the **built-in copy**: what an environment that has saved no template sends, and
 * what {@link renderTemplate} falls back to.
 *
 * @param brand - The environment's app name and support address.
 * @param message - What to say.
 * @returns Subject, text and HTML, ready for the mailer.
 */
export function render(brand: EmailBrand, message: EmailMessage): Omit<MailMessage, 'to'> {
  const parts = partsOf(brand, message)
  const { app, copy, code, details } = parts
  // A function, not a string: `$&` and friends in a replacement string are patterns, and the
  // name is operator input.
  const named = (text: string) => text.replaceAll('{app}', () => app)
  const lead = copy.lead.map(named)
  const closing = [
    ...(code ? [`This code expires in ${code.ttlMinutes} minutes.`] : []),
    ...copy.closing.map(named),
    // Appended after the name is filled in: an address may itself contain `{app}`.
    ...(parts.supportLine ? [parts.supportLine] : []),
  ]

  return {
    subject: code ? `${code.code} ${named(copy.subject)}` : named(copy.subject),
    ...layout(
      parts,
      [
        ...lead,
        ...(details.length > 0 ? [details.join('\n')] : []),
        ...(code ? [code.code] : []),
        ...(code?.linkUrl ? [`${copy.linkLead ?? 'Or open this link'}: ${code.linkUrl}`] : []),
        ...closing,
      ],
      [
        ...lead.map(paragraph),
        ...(details.length > 0 ? [`<p>${details.map(escapeHtml).join('<br>')}</p>`] : []),
        ...(code ? [`<p style="${CODE_STYLE}">${escapeHtml(code.code)}</p>`] : []),
        ...(code?.linkUrl
          ? [
              ...(copy.linkLead ? [paragraph(`${copy.linkLead}:`)] : []),
              `<p><a href="${escapeHtml(code.linkUrl)}">${escapeHtml(named(copy.action ?? 'Open'))}</a></p>`,
            ]
          : []),
        ...closing.map(paragraph),
      ]
    ),
  }
}

/**
 * Longest subject a template may render to, in characters. A template's own text is capped
 * when it is saved; this bounds what its placeholders can add (an app name, many times).
 */
export const MAX_RENDERED_SUBJECT_LENGTH = 255

/**
 * Why part of an environment's template was not used for a message, as a fixed word.
 *
 * - `invalid`: it does not pass the rules of its kind (`emailTemplateProblems`): stored by
 *   another version, or written past the API.
 * - `missing_value`: it names a placeholder this message has no value for.
 * - `leading_digit`: a notice's subject would have started with a digit once rendered (an
 *   app name can start with one).
 * - `empty`: nothing was left once it was rendered.
 * - `too_long`: the rendered subject is over {@link MAX_RENDERED_SUBJECT_LENGTH}.
 */
export type TemplateFallbackReason =
  | 'invalid'
  | 'missing_value'
  | 'leading_digit'
  | 'empty'
  | 'too_long'

/** One part of a template that was not used; the built-in copy took its place. */
export interface TemplateFallback {
  part: 'subject' | 'body'
  reason: TemplateFallbackReason
}

/** A rendered email, and which parts of the environment's template it could not use. */
export interface RenderedTemplate {
  message: Omit<MailMessage, 'to'>
  /** Empty when the template was used as written. Never holds any of its text. */
  unused: TemplateFallback[]
}

type Values = Partial<Record<EmailTemplatePlaceholder, string>>

/**
 * The value of each placeholder for one message. Things the server knows, and nothing a
 * request said: the device is a family from a fixed list, the provider a fixed name.
 */
function valuesOf(app: string, message: EmailMessage): Values {
  const values: Values = { appName: app }
  if ('code' in message) {
    values.code = message.code
    values.expiresInMinutes = String(message.ttlMinutes)
    if (message.linkUrl !== undefined) {
      values.link = message.linkUrl
    }
  }
  if ('at' in message) {
    values.time = utc(message.at)
  }
  if (message.type === 'new_sign_in') {
    values.device = message.device
  }
  if (message.type === 'identity_changed') {
    values.provider = PROVIDER_NAMES[message.provider]
  }
  if (message.type === 'mfa_changed' && message.remaining !== undefined) {
    values.backupCodesLeft = String(message.remaining)
  }
  return values
}

class Unusable extends Error {
  constructor(readonly reason: TemplateFallbackReason) {
    super(reason)
  }
}

function valueFor(values: Values, name: string): string {
  const value = Object.hasOwn(values, name) ? values[name as EmailTemplatePlaceholder] : undefined
  if (value === undefined) {
    throw new Unusable('missing_value')
  }
  return value
}

function tokensOf(text: string): EmailTemplateToken[] {
  const tokens = parseEmailTemplate(text)
  if (tokens === null) {
    throw new Unusable('invalid')
  }
  return tokens
}

/**
 * A template's subject for one message, on one line.
 *
 * Every value is put in once and never read again as a template, so a name that holds
 * `{{code}}` stays those characters. The result is cleaned like the app name before it
 * reaches a header (a control character or a line break becomes a space).
 */
function subjectOf(subject: string, values: Values, category: 'code' | 'notice'): string {
  const rendered = tokensOf(subject)
    .map((token) => ('text' in token ? token.text : valueFor(values, token.placeholder)))
    .join('')
    .replace(UNPRINTABLE, ' ')
    .trim()
  // As a reader sees it: a value (the app's name) can bring characters that draw nothing.
  const seen = visibleEmailText(rendered)
  if (seen === '') {
    throw new Unusable('empty')
  }
  if (rendered.length > MAX_RENDERED_SUBJECT_LENGTH) {
    throw new Unusable('too_long')
  }
  // The text was checked when it was saved; the app name is a value and may start with one.
  if (category === 'notice' && /^\p{Nd}/u.test(seen)) {
    throw new Unusable('leading_digit')
  }
  return rendered
}

function names(tokens: readonly EmailTemplateToken[], name: string): boolean {
  return tokens.some((token) => 'placeholder' in token && token.placeholder === name)
}

/** One paragraph of a template's body as HTML: the server's markup around escaped text. */
function htmlParagraph(tokens: readonly EmailTemplateToken[], values: Values, label: string) {
  const link = (url: string) => `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`
  const [only] = tokens
  if (tokens.length === 1 && only && 'placeholder' in only) {
    // Alone in its paragraph, the code and the link are drawn as the built-in copy draws them.
    if (only.placeholder === 'code') {
      return `<p style="${CODE_STYLE}">${escapeHtml(valueFor(values, 'code'))}</p>`
    }
    if (only.placeholder === 'link') {
      return `<p>${link(valueFor(values, 'link'))}</p>`
    }
  }
  const inner = tokens.map((token) => {
    if ('text' in token) {
      return escapeHtml(token.text).replaceAll('\n', '<br>')
    }
    const value = valueFor(values, token.placeholder)
    if (token.placeholder === 'link') {
      return link(value)
    }
    return token.placeholder === 'code'
      ? `<strong>${escapeHtml(value)}</strong>`
      : escapeHtml(value)
  })
  return `<p>${inner.join('')}</p>`
}

/**
 * A template's body for one message, as the paragraphs of both parts.
 *
 * Paragraphs are what blank lines separate. A paragraph that names the link is left out of a
 * message that has none. Operator text is escaped character by character in the HTML part
 * and is never turned into a link: the only anchor is the server's own, for `{{link}}`.
 */
function bodyOf(body: string, values: Values, label: string): { text: string[]; html: string[] } {
  const text: string[] = []
  const html: string[] = []
  for (const written of emailTemplateParagraphs(body)) {
    const tokens = tokensOf(written)
    if (names(tokens, 'link') && values.link === undefined) {
      continue
    }
    text.push(
      tokens
        .map((token) => ('text' in token ? token.text : valueFor(values, token.placeholder)))
        .join('')
    )
    html.push(htmlParagraph(tokens, values, label))
  }
  if (text.every((paragraph) => visibleEmailText(paragraph) === '')) {
    throw new Unusable('empty')
  }
  return { text, html }
}

function attempt<T>(part: TemplateFallback['part'], unused: TemplateFallback[], make: () => T) {
  try {
    return make()
  } catch (error) {
    if (error instanceof Unusable) {
      unused.push({ part, reason: error.reason })
      return null
    }
    throw error
  }
}

/**
 * Render an email with an environment's own wording (ADR 0039), in the server's layout.
 *
 * The template is **text with `{{name}}` placeholders**; the layout, the code's styling, the
 * link's button and the footer stay the server's:
 *
 * - every character an operator wrote, and every value, is HTML-escaped in the HTML part and
 *   literal in the text part. An address typed into a template stays text;
 * - `{{link}}` becomes the server's button (the URL in the text part), and a paragraph that
 *   names it is left out of a message that has no link;
 * - a subject is cleaned onto one line before it reaches a header;
 * - a **notice keeps its facts and its last words**. After the operator's paragraphs come,
 *   in this order: the server's own "when, which device, from where" block (a security
 *   notice's); the server's own sentence of what to do when the reader did not do this
 *   (the last paragraph of the built-in closing, for every kind of the `notice` category);
 *   and, when a support address is set, where to write (a security notice's). A template
 *   changes how a notice is worded, never what it reports or what it tells the reader to do.
 *
 * A part that cannot be used (see {@link TemplateFallbackReason}) is replaced **whole** by
 * the built-in copy and reported in `unused`: never a half-rendered message, never an error.
 * The subject and the body fall back independently.
 *
 * @param brand - The environment's app name and support address.
 * @param message - What to say.
 * @param template - The environment's template for this message's kind, if it has one.
 * @returns The email, and which parts of the template were not used.
 */
export function renderTemplate(
  brand: EmailBrand,
  message: EmailMessage,
  template: EmailTemplate | undefined
): RenderedTemplate {
  const builtIn = render(brand, message)
  if (template === undefined || (template.subject === undefined && template.body === undefined)) {
    return { message: builtIn, unused: [] }
  }
  const kind = templateKind(message)
  const unused: TemplateFallback[] = []
  const problems = emailTemplateProblems(kind, template)
  const usable = (part: TemplateFallback['part']): string | undefined => {
    if (template[part] !== undefined && problems.some((problem) => problem.field === part)) {
      unused.push({ part, reason: 'invalid' })
      return undefined
    }
    return template[part]
  }
  const [writtenSubject, writtenBody] = [usable('subject'), usable('body')]
  const parts = partsOf(brand, message)
  const values = valuesOf(parts.app, message)
  const { category } = EMAIL_TEMPLATE_RULES[kind]

  const subject =
    writtenSubject === undefined
      ? null
      : attempt('subject', unused, () => subjectOf(writtenSubject, values, category))
  const label = (parts.copy.action ?? 'Open').replaceAll('{app}', () => parts.app)
  const body =
    writtenBody === undefined
      ? null
      : attempt('body', unused, () => bodyOf(writtenBody, values, label))

  const { details, supportLine } = parts
  // The sentence that says what to do when the reader did not do this: the last paragraph
  // of the built-in closing of every kind of the notice category. The server's, like the
  // facts, so that no wording of a notice can leave it out.
  const lastWord = category === 'notice' ? parts.copy.closing.at(-1) : undefined
  const ownSentence = lastWord === undefined ? [] : [lastWord.replaceAll('{app}', () => parts.app)]
  return {
    message: {
      subject: subject ?? builtIn.subject,
      ...(body === null
        ? { text: builtIn.text, html: builtIn.html }
        : layout(
            parts,
            [
              ...body.text,
              ...(details.length > 0 ? [details.join('\n')] : []),
              ...ownSentence,
              ...(supportLine ? [supportLine] : []),
            ],
            [
              ...body.html,
              ...(details.length > 0 ? [`<p>${details.map(escapeHtml).join('<br>')}</p>`] : []),
              ...ownSentence.map(paragraph),
              ...(supportLine ? [paragraph(supportLine)] : []),
            ]
          )),
    },
    unused,
  }
}
