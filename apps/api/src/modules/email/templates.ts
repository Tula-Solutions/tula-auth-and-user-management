import { DEFAULT_APP_NAME, MAX_APP_NAME_LENGTH, type OAuthProvider } from '@tula/contract'
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

function detailLine([label, value]: [string, string]): string {
  return `${label}: ${value}`
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
 * @param brand - The environment's app name and support address.
 * @param message - What to say.
 * @returns Subject, text and HTML, ready for the mailer.
 */
export function render(brand: EmailBrand, message: EmailMessage): Omit<MailMessage, 'to'> {
  const app = displayName(brand.name)
  const notice = isSecurityNotice(message)
  const copy = notice ? securityCopy(message) : COPY[message.type]
  // A function, not a string: `$&` and friends in a replacement string are patterns, and the
  // name is operator input.
  const named = (text: string) => text.replaceAll('{app}', () => app)
  const code = 'code' in message ? message : null
  const lead = copy.lead.map(named)
  const details = (copy.details ?? []).map(detailLine)
  const closing = [
    ...(code ? [`This code expires in ${code.ttlMinutes} minutes.`] : []),
    ...copy.closing.map(named),
    // Appended after the name is filled in: an address may itself contain `{app}`.
    ...(notice && brand.supportEmail
      ? [`If you cannot get back in to your account, contact ${brand.supportEmail}.`]
      : []),
  ]
  const support = brand.supportEmail ? `Need help? Contact ${brand.supportEmail}` : null

  return {
    subject: code ? `${code.code} ${named(copy.subject)}` : named(copy.subject),
    text: [
      ...lead,
      ...(details.length > 0 ? [details.join('\n')] : []),
      ...(code ? [code.code] : []),
      ...(code?.linkUrl ? [`${copy.linkLead ?? 'Or open this link'}: ${code.linkUrl}`] : []),
      ...closing,
      ['--', app, ...(support ? [support] : [])].join('\n'),
    ].join('\n\n'),
    html: [
      '<!doctype html>',
      `<html><body style="${BODY_STYLE}">`,
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
      `<p style="${FOOTER_STYLE}">${escapeHtml(app)}${
        support ? `<br>${escapeHtml(support)}` : ''
      }</p>`,
      '</body></html>',
    ].join('\n'),
  }
}
