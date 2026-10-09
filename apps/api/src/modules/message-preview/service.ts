import { type EmailTemplateKind, smsSegments } from '@tula/contract'
import type { Deps, Tenant } from '~/dependencies'
import { type EmailMessage, renderTemplate } from '~/modules/email/templates'
import * as Settings from '~/modules/settings/service'
import { renderCodeText } from '~/modules/sms/templates'
import type { MessagePreview, MessagePreviewRequest } from './schema'

// What an operator sees before saving a wording (ADR 0042): the message as the functions
// that send it would write it, from sample values that are constants of this file. Nothing
// is sent, stored, counted or recorded, and nothing of a request reaches a message except
// the draft itself.

/** The code every sample message carries. Six digits, and plainly not a real one. */
export const SAMPLE_CODE = '123456'

/** A second code a text message's draft is tried with; never shown. */
const OTHER_CODE = '908172'

/** When every sample notice says it happened. */
const SAMPLE_TIME = new Date('2026-01-15T14:05:00.000Z')

/** Minutes a sample code is said to last. */
const SAMPLE_TTL_MINUTES = 10

/**
 * The link of the sample sign-in email. An address of a reserved example domain: a preview
 * shows where the server's own link goes in the text, never a link that works.
 */
const SAMPLE_LINK = 'https://app.example/sign-in#sample-link'

const notice = { at: SAMPLE_TIME } as const
const code = { code: SAMPLE_CODE, ttlMinutes: SAMPLE_TTL_MINUTES } as const

/**
 * One sample message per kind of email. A `Record` over the contract's kinds: a new kind
 * does not compile until it has a sample, and a test holds each sample to its kind.
 */
export const SAMPLE_EMAILS: Readonly<Record<EmailTemplateKind, EmailMessage>> = {
  email_verification: { type: 'email_verification', ...code },
  password_reset: { type: 'password_reset', ...code },
  sign_in: { type: 'sign_in', ...code, linkUrl: SAMPLE_LINK },
  step_up: { type: 'step_up', ...code },
  account_exists: { type: 'account_exists' },
  no_account: { type: 'no_account' },
  no_account_sign_in: { type: 'no_account_sign_in' },
  password_changed: { type: 'password_changed', by: 'self', added: false, ...notice },
  password_added: { type: 'password_changed', by: 'self', added: true, ...notice },
  password_reset_completed: { type: 'password_changed', by: 'reset', added: false, ...notice },
  password_added_by_reset: { type: 'password_changed', by: 'reset', added: true, ...notice },
  password_set_by_admin: { type: 'password_changed', by: 'admin', added: false, ...notice },
  password_added_by_admin: { type: 'password_changed', by: 'admin', added: true, ...notice },
  password_removed: { type: 'password_changed', by: 'verification', added: false, ...notice },
  new_sign_in: {
    type: 'new_sign_in',
    device: 'Chrome on Windows',
    // An address of a range reserved for documentation.
    ipAddress: '203.0.113.7',
    ...notice,
  },
  mfa_enabled: { type: 'mfa_changed', change: 'enabled', ...notice },
  mfa_disabled: { type: 'mfa_changed', change: 'disabled', ...notice },
  mfa_reset_by_admin: { type: 'mfa_changed', change: 'admin_reset', ...notice },
  backup_codes_regenerated: { type: 'mfa_changed', change: 'backup_codes_regenerated', ...notice },
  backup_code_used: { type: 'mfa_changed', change: 'backup_code_used', remaining: 7, ...notice },
  passkey_added: { type: 'mfa_changed', change: 'passkey_added', ...notice },
  passkey_removed: { type: 'mfa_changed', change: 'passkey_removed', ...notice },
  identity_linked: { type: 'identity_changed', change: 'linked', provider: 'google', ...notice },
  identity_unlinked: {
    type: 'identity_changed',
    change: 'unlinked',
    provider: 'google',
    ...notice,
  },
}

/**
 * Draw one message in a draft wording, with sample values.
 *
 * The app's name, the support address and the host of the bound line are the environment's
 * own, as saved: a preview shows what its users would read. Everything else is a constant.
 * The rendering is the sending code's own (`renderTemplate`, `renderCodeText`), so a part
 * the server would replace by the built-in copy is replaced here too and named in `unused`.
 *
 * It sends nothing, reads no user, writes nothing and records nothing; the draft is in no
 * log line.
 *
 * @param deps - The settings store and the config.
 * @param tenant - The environment.
 * @param request - The message's channel and kind, and the draft, already validated.
 * @returns The subject (an email's) and the text.
 */
export async function preview(
  deps: Pick<Deps, 'environmentSettings' | 'config'>,
  tenant: Pick<Tenant, 'environmentId'>,
  request: MessagePreviewRequest
): Promise<MessagePreview> {
  const { app, urls } = await Settings.current(deps, tenant)
  if (request.channel === 'sms') {
    const sample = { appName: app.name, allowedOrigins: urls.allowedOrigins, code: SAMPLE_CODE }
    const drawn = renderCodeText(request.kind, sample, request.template)
    // Whether a draft is used can depend on the code (an app name that holds six digits):
    // a second code that is no real one either keeps the sample code from being the one
    // code such a name happens to agree with.
    const other = renderCodeText(request.kind, { ...sample, code: OTHER_CODE }, request.template)
    const { text, unused } =
      drawn.unused === null && other.unused !== null
        ? { text: renderCodeText(request.kind, sample, undefined).text, unused: other.unused }
        : drawn
    return {
      channel: 'sms',
      kind: request.kind,
      subject: null,
      text,
      unused: unused === null ? [] : [{ part: 'text', reason: unused }],
      segments: smsSegments(text),
    }
  }
  const { message, unused } = renderTemplate(app, SAMPLE_EMAILS[request.kind], request.template)
  return {
    channel: 'email',
    kind: request.kind,
    subject: message.subject,
    text: message.text,
    unused,
    segments: null,
  }
}
