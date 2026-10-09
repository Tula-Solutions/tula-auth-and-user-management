import {
  EMAIL_TEMPLATE_KINDS,
  EMAIL_TEMPLATE_RULES,
  type EmailTemplateKind,
  emailTemplateProblems,
  MAX_EMAIL_BODY_LENGTH,
  MAX_EMAIL_SUBJECT_LENGTH,
  MAX_SMS_TEMPLATE_LENGTH,
  SMS_TEMPLATE_KINDS,
  SMS_TEMPLATE_RULES,
  type SmsTemplateKind,
  smsTemplateProblems,
} from '@tula/contract'
import type { MessagePreview, MessagePreviewRequest } from '~/api/generated/api.gen'
import type { SettingsDocument } from '~/features/settings/model'

// What the messages screen knows that is not a component: which kinds there are, what the
// operator is told about each, and how a draft of the settings document is changed. The
// kinds, their placeholders and every rule are the contract's (ADR 0039, ADR 0042); nothing
// here decides what a template may hold.

/** One message an environment sends: an email kind or a text message kind. */
export type MessageRef =
  | { channel: 'email'; kind: EmailTemplateKind }
  | { channel: 'sms'; kind: SmsTemplateKind }

/** A part of a template an operator writes. */
export type MessageField = 'subject' | 'body' | 'text'

/** A group of kinds in the screen's list. */
export interface MessageGroup {
  title: string
  messages: readonly MessageRef[]
}

const EMAIL_WORDS: Record<EmailTemplateKind, { label: string; when: string }> = {
  email_verification: {
    label: 'Email verification code',
    when: 'A sign-up, or a sign-in to an unverified address, needs the address proven.',
  },
  password_reset: {
    label: 'Password reset code',
    when: 'A password reset was asked for an address that has an account.',
  },
  sign_in: {
    label: 'Sign-in code and link',
    when: 'A sign-in by emailed code or link was asked for an address that has an account.',
  },
  step_up: {
    label: 'Confirmation code',
    when: 'A signed-in user without a second factor confirms it is them before a sensitive change.',
  },
  account_exists: {
    label: 'Sign-up for an existing account',
    when: 'Someone tried to sign up with an address that already has an account.',
  },
  no_account: {
    label: 'Password reset with no account',
    when: 'A password reset was asked for an address with no account.',
  },
  no_account_sign_in: {
    label: 'Sign-in with no account',
    when: 'A sign-in by email was asked for an address with no account.',
  },
  password_changed: { label: 'Password changed', when: 'The user changed their password.' },
  password_added: {
    label: 'Password added',
    when: 'The user set a password on an account that had none.',
  },
  password_reset_completed: {
    label: 'Password reset completed',
    when: 'A password reset replaced the password.',
  },
  password_added_by_reset: {
    label: 'Password added by a reset',
    when: 'A password reset gave a password to an account that had none.',
  },
  password_set_by_admin: {
    label: 'Password set by an administrator',
    when: 'An administrator replaced the password.',
  },
  password_added_by_admin: {
    label: 'Password added by an administrator',
    when: 'An administrator gave a password to an account that had none.',
  },
  password_removed: {
    label: 'Password removed',
    when: 'The address was proven for the first time by someone who had not proven the password, and the password was removed.',
  },
  new_sign_in: {
    label: 'Sign-in from a new device',
    when: 'The account was signed in to from a device not seen before.',
  },
  mfa_enabled: {
    label: 'Two-step verification turned on',
    when: 'Two-step verification was turned on.',
  },
  mfa_disabled: {
    label: 'Two-step verification turned off',
    when: 'Two-step verification was turned off.',
  },
  mfa_reset_by_admin: {
    label: 'Two-step verification reset',
    when: 'An administrator reset two-step verification.',
  },
  backup_codes_regenerated: {
    label: 'New backup codes',
    when: 'New backup codes replaced the old ones.',
  },
  backup_code_used: { label: 'Backup code used', when: 'A backup code was used to sign in.' },
  passkey_added: { label: 'Passkey added', when: 'A passkey was added.' },
  passkey_removed: { label: 'Passkey removed', when: 'A passkey was removed.' },
  identity_linked: {
    label: 'Provider account connected',
    when: 'A provider account was connected.',
  },
  identity_unlinked: {
    label: 'Provider account disconnected',
    when: 'A provider account was disconnected.',
  },
}

const SMS_WORDS: Record<SmsTemplateKind, { label: string; when: string }> = {
  phone_verification: {
    label: 'Phone number code',
    when: 'A signed-in user proves a phone number with a texted code.',
  },
  sign_in: {
    label: 'Texted sign-in code',
    when: 'A sign-in by texted code was asked for a number that signs in.',
  },
}

/** The three addresses' emails that say "nothing happened": notices, listed apart. */
const ABOUT_AN_ADDRESS: readonly EmailTemplateKind[] = [
  'account_exists',
  'no_account',
  'no_account_sign_in',
]

function emails(keep: (kind: EmailTemplateKind) => boolean): MessageRef[] {
  return EMAIL_TEMPLATE_KINDS.filter(keep).map((kind) => ({ channel: 'email', kind }))
}

/**
 * Every message kind of the contract, in the groups the screen lists them in. Built from the
 * contract's lists, so a kind added there is on the screen (and fails to compile here until
 * it has a label).
 */
export const MESSAGE_GROUPS: readonly MessageGroup[] = [
  {
    title: 'Emails with a code',
    messages: emails((kind) => EMAIL_TEMPLATE_RULES[kind].category === 'code'),
  },
  {
    title: 'Emails about an address',
    messages: emails((kind) => ABOUT_AN_ADDRESS.includes(kind)),
  },
  {
    title: 'Security notices',
    messages: emails(
      (kind) => EMAIL_TEMPLATE_RULES[kind].category === 'notice' && !ABOUT_AN_ADDRESS.includes(kind)
    ),
  },
  {
    title: 'Text messages',
    messages: SMS_TEMPLATE_KINDS.map((kind) => ({ channel: 'sms', kind })),
  },
]

/**
 * A message's name and when it is sent, in the operator's words.
 *
 * @param message - The message.
 * @returns Its label and the sentence of when it is sent.
 */
export function wordsOf(message: MessageRef): { label: string; when: string } {
  return message.channel === 'email' ? EMAIL_WORDS[message.kind] : SMS_WORDS[message.kind]
}

/**
 * A message as one string, for a React key and for comparing two messages.
 *
 * @param message - The message.
 * @returns `<channel>:<kind>`.
 */
export function messageId(message: MessageRef): string {
  return `${message.channel}:${message.kind}`
}

/**
 * Where a message's template is in the settings document, as the server names it in a field
 * error.
 *
 * @param message - The message.
 * @returns `emails.templates.<kind>` or `sms.templates.<kind>`.
 */
export function settingsPath(message: MessageRef): string {
  return `${message.channel === 'email' ? 'emails' : 'sms'}.templates.${message.kind}`
}

/**
 * The parts of a message an operator writes.
 *
 * @param message - The message.
 * @returns `subject` and `body` for an email, `text` for a text message.
 */
export function fieldsOf(message: MessageRef): readonly MessageField[] {
  return message.channel === 'email' ? ['subject', 'body'] : ['text']
}

/**
 * The longest a part may be, in characters.
 *
 * @param field - The part.
 * @returns The contract's cap for it.
 */
export function maxLengthOf(field: MessageField): number {
  if (field === 'subject') {
    return MAX_EMAIL_SUBJECT_LENGTH
  }
  return field === 'body' ? MAX_EMAIL_BODY_LENGTH : MAX_SMS_TEMPLATE_LENGTH
}

/** A placeholder a part may name, and whether the message cannot do without it. */
export interface PlaceholderChoice {
  name: string
  required: boolean
}

/**
 * The placeholders a part of a message may name, from the contract's rules.
 *
 * An email's subject may name everything its kind allows except `link`; what a kind requires
 * is required of its body (or of a text message's text).
 *
 * @param message - The message.
 * @param field - The part.
 * @returns The choices, the required ones first.
 */
export function placeholdersOf(message: MessageRef, field: MessageField): PlaceholderChoice[] {
  const rules =
    message.channel === 'email'
      ? EMAIL_TEMPLATE_RULES[message.kind]
      : SMS_TEMPLATE_RULES[message.kind]
  const required: readonly string[] = rules.required
  const optional: readonly string[] = rules.optional
  return [
    ...required.map((name) => ({ name, required: field !== 'subject' })),
    ...optional.map((name) => ({ name, required: false })),
  ].filter((choice) => field !== 'subject' || choice.name !== 'link')
}

/** The draft's own wording of a message: the parts it has, as text. */
export type DraftTemplate = Partial<Record<MessageField, string>>

/**
 * The environment's own wording of a message in a settings draft.
 *
 * @param draft - The settings as edited.
 * @param message - The message.
 * @returns Its parts; empty when the message is sent in the built-in text.
 */
export function templateOf(draft: SettingsDocument, message: MessageRef): DraftTemplate {
  if (message.channel === 'email') {
    return { ...draft.emails?.templates?.[message.kind] }
  }
  return { ...draft.sms?.templates?.[message.kind] }
}

/**
 * Whether a draft has wording of its own for a message.
 *
 * @param draft - The settings as edited.
 * @param message - The message.
 * @returns `true` when at least one part is the environment's.
 */
export function hasOwnWording(draft: SettingsDocument, message: MessageRef): boolean {
  return Object.keys(templateOf(draft, message)).length > 0
}

/**
 * Write one part of a message's wording into a settings draft.
 *
 * An empty part is no part: the key is left out, and a template with no part left is left
 * out too, so that the document says "built-in" the one way the server stores it.
 *
 * @param draft - The settings as edited.
 * @param message - The message.
 * @param field - The part.
 * @param value - Its text; empty to send the built-in text for that part.
 * @returns The changed draft.
 */
export function withField(
  draft: SettingsDocument,
  message: MessageRef,
  field: MessageField,
  value: string
): SettingsDocument {
  const template: DraftTemplate = templateOf(draft, message)
  if (value === '') {
    delete template[field]
  } else {
    template[field] = value
  }
  return withTemplate(draft, message, Object.keys(template).length === 0 ? null : template)
}

/**
 * Take a message's own wording out of a settings draft: the built-in text is sent again.
 *
 * @param draft - The settings as edited.
 * @param message - The message.
 * @returns The changed draft.
 */
export function withoutWording(draft: SettingsDocument, message: MessageRef): SettingsDocument {
  return withTemplate(draft, message, null)
}

function withTemplate(
  draft: SettingsDocument,
  message: MessageRef,
  template: DraftTemplate | null
): SettingsDocument {
  if (message.channel === 'email') {
    const { [message.kind]: _replaced, ...others } = draft.emails?.templates ?? {}
    return {
      ...draft,
      emails: {
        ...draft.emails,
        templates: template === null ? others : { ...others, [message.kind]: template },
      },
    }
  }
  // Every settings document the server answers with has the `sms` section; a draft without
  // one has nowhere to keep a text message's wording.
  if (!draft.sms) {
    return draft
  }
  const { [message.kind]: _replaced, ...others } = draft.sms.templates ?? {}
  return {
    ...draft,
    sms: {
      ...draft.sms,
      templates:
        template === null ? others : { ...others, [message.kind]: { text: template.text ?? '' } },
    },
  }
}

/**
 * Why a draft's wording of a message would be refused when saved, by part: the contract's
 * own validators, the ones the server runs.
 *
 * @param message - The message.
 * @param template - The draft's wording.
 * @returns The reasons in the contract's words, by part; no key for a part that passes.
 */
export function problemsOf(
  message: MessageRef,
  template: DraftTemplate
): Partial<Record<MessageField, string[]>> {
  if (Object.keys(template).length === 0) {
    return {}
  }
  const problems =
    message.channel === 'email'
      ? emailTemplateProblems(message.kind, template)
      : smsTemplateProblems(message.kind, { text: template.text ?? '' })
  const byField: Partial<Record<MessageField, string[]>> = {}
  for (const problem of problems) {
    const reasons = byField[problem.field] ?? []
    reasons.push(problem.message)
    byField[problem.field] = reasons
  }
  return byField
}

/**
 * What to ask the preview route for a message in a draft.
 *
 * @param message - The message.
 * @param template - The draft's wording; empty for the built-in text.
 * @returns The request's body.
 */
export function previewRequest(
  message: MessageRef,
  template: DraftTemplate
): MessagePreviewRequest {
  if (message.channel === 'email') {
    const { subject, body } = template
    const own = { ...(subject !== undefined && { subject }), ...(body !== undefined && { body }) }
    return {
      channel: 'email',
      kind: message.kind,
      ...(Object.keys(own).length > 0 && { template: own }),
    }
  }
  return {
    channel: 'sms',
    kind: message.kind,
    ...(template.text !== undefined && { template: { text: template.text } }),
  }
}

type Unused = MessagePreview['unused'][number]

const PART_WORDS: Record<Unused['part'], { the: string; builtIn: string }> = {
  subject: { the: 'The subject', builtIn: 'the built-in subject' },
  body: { the: 'The body', builtIn: 'the built-in body' },
  text: { the: 'The text', builtIn: 'the built-in text' },
}

const UNUSED_REASONS: Record<Unused['reason'], string> = {
  invalid: 'does not pass the rules for this message',
  missing_value: 'names a value this message does not have',
  leading_digit: 'would start with a digit once its values are filled in',
  empty: 'would be empty once its values are filled in',
  too_long: 'would be too long once its values are filled in',
  code_not_last:
    'would not end with the code as the last six digits of the message (the app name holds six digits of its own)',
}

/**
 * Why the server would not use a part of the wording, and what it sends in its place.
 *
 * @param unused - One entry of the preview's `unused`.
 * @returns The sentence.
 */
export function unusedSentence(unused: Unused): string {
  const part = PART_WORDS[unused.part]
  return `${part.the} ${UNUSED_REASONS[unused.reason]}, so ${part.builtIn} is sent instead.`
}

/**
 * How many text messages a text is sent as, in words.
 *
 * @param segments - The preview's `segments`.
 * @returns The sentence; `null` for an email.
 */
export function segmentsSentence(segments: MessagePreview['segments']): string | null {
  if (segments === null) {
    return null
  }
  const parts = segments.segments === 1 ? '1 text message' : `${segments.segments} text messages`
  const unit =
    segments.encoding === 'gsm7'
      ? `${segments.units} characters of the GSM alphabet`
      : `${segments.units} characters as Unicode, which fits fewer in a message`
  return `Sent as ${parts}: ${unit}.`
}
