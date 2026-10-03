import { DEFAULT_APP_NAME, MAX_APP_NAME_LENGTH } from '@tula/contract'
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
  type: 'email_verification' | 'password_reset'
  code: string
  /** Minutes until the code and link expire. */
  ttlMinutes: number
  /** Magic link, when the flow offers one. */
  linkUrl?: string
}

/** A notice that stands in for a code, so sign-up and reset answer alike for every address. */
export interface NoticeMessage {
  type: 'account_exists' | 'no_account'
}

/** Every email Tula sends. Adding a message means adding its copy to this module, nowhere else. */
export type EmailMessage = CodeMessage | NoticeMessage

/** What a message says, before the layout is applied. `{app}` is replaced by the app's name. */
interface Copy {
  /** Subject after the code (for a code message) or the whole subject (for a notice). */
  subject: string
  /** Paragraphs before the code. */
  lead: string[]
  /** Label of the link button of a code message. */
  action?: string
  /** Paragraphs after the code. */
  closing: string[]
}

const IGNORE = "If you didn't request this, you can safely ignore this email."

const COPY: Record<EmailMessage['type'], Copy> = {
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
}

// Control characters and line or paragraph separators: anything that could end a header line.
const UNPRINTABLE = /[\p{Cc}\p{Zl}\p{Zp}]+/gu

/**
 * Make an app name safe to put in an email header.
 *
 * The settings API already refuses control characters, but the name is operator input that
 * reaches a mail header, so it is cleaned again here rather than trusted: a line break in a
 * subject is how a header is injected.
 *
 * @param name - The configured name.
 * @returns The name on one line, at most {@link MAX_APP_NAME_LENGTH} characters, or the default
 *   name when nothing printable is left.
 */
export function displayName(name: string): string {
  const cleaned = name.replace(UNPRINTABLE, ' ').trim().slice(0, MAX_APP_NAME_LENGTH).trim()
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

/**
 * Render an email: the one layout every message shares, as plain text and as HTML.
 *
 * - The subject and the body name the app; the footer gives the support address when one is set.
 * - A code leads the subject, so it can be read from a notification without opening the email
 *   (and so the conformance runner can find it).
 * - Every interpolated value is HTML-escaped in the HTML part, the app name included.
 *
 * @param brand - The environment's app name and support address.
 * @param message - What to say.
 * @returns Subject, text and HTML, ready for the mailer.
 */
export function render(brand: EmailBrand, message: EmailMessage): Omit<MailMessage, 'to'> {
  const app = displayName(brand.name)
  const copy = COPY[message.type]
  // A function, not a string: `$&` and friends in a replacement string are patterns, and the
  // name is operator input.
  const named = (text: string) => text.replaceAll('{app}', () => app)
  const code = 'code' in message ? message : null
  const lead = copy.lead.map(named)
  const closing = [
    ...(code ? [`This code expires in ${code.ttlMinutes} minutes.`] : []),
    ...copy.closing.map(named),
  ]
  const support = brand.supportEmail ? `Need help? Contact ${brand.supportEmail}` : null

  return {
    subject: code ? `${code.code} ${named(copy.subject)}` : named(copy.subject),
    text: [
      ...lead,
      ...(code ? [code.code] : []),
      ...(code?.linkUrl ? [`Or open this link: ${code.linkUrl}`] : []),
      ...closing,
      ['--', app, ...(support ? [support] : [])].join('\n'),
    ].join('\n\n'),
    html: [
      '<!doctype html>',
      `<html><body style="${BODY_STYLE}">`,
      ...lead.map(paragraph),
      ...(code ? [`<p style="${CODE_STYLE}">${escapeHtml(code.code)}</p>`] : []),
      ...(code?.linkUrl
        ? [`<p><a href="${escapeHtml(code.linkUrl)}">${escapeHtml(copy.action ?? 'Open')}</a></p>`]
        : []),
      ...closing.map(paragraph),
      `<p style="${FOOTER_STYLE}">${escapeHtml(app)}${
        support ? `<br>${escapeHtml(support)}` : ''
      }</p>`,
      '</body></html>',
    ].join('\n'),
  }
}
