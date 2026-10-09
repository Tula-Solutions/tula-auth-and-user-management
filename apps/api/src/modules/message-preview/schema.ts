import {
  EMAIL_TEMPLATE_KINDS,
  emailTemplateProblems,
  MAX_EMAIL_BODY_LENGTH,
  MAX_EMAIL_SUBJECT_LENGTH,
  SMS_TEMPLATE_KINDS,
  SmsTemplateSchema,
  smsTemplateProblems,
} from '@tula/contract'
import { z } from 'zod'

// A draft is held to exactly the rules a saved template is (`emailTemplateProblems`,
// `smsTemplateProblems`): what cannot be saved cannot be previewed, and is refused with the
// same words under `template.<field>`.

const EmailDraft = z.strictObject({
  subject: z.string().max(MAX_EMAIL_SUBJECT_LENGTH).optional(),
  body: z.string().max(MAX_EMAIL_BODY_LENGTH).optional(),
})

const EmailPreviewRequest = z
  .strictObject({
    channel: z.literal('email'),
    kind: z.enum(EMAIL_TEMPLATE_KINDS),
    template: EmailDraft.optional(),
  })
  .superRefine((request, context) => {
    for (const problem of emailTemplateProblems(request.kind, request.template ?? {})) {
      context.addIssue({
        code: 'custom',
        path: ['template', problem.field],
        message: problem.message,
      })
    }
  })

const SmsPreviewRequest = z
  .strictObject({
    channel: z.literal('sms'),
    kind: z.enum(SMS_TEMPLATE_KINDS),
    template: SmsTemplateSchema.optional(),
  })
  .superRefine((request, context) => {
    if (request.template === undefined) {
      return
    }
    for (const problem of smsTemplateProblems(request.kind, request.template)) {
      context.addIssue({
        code: 'custom',
        path: ['template', problem.field],
        message: problem.message,
      })
    }
  })

/**
 * The body of `POST /v1/admin/message-preview`: which message, and the wording to draw it
 * in. `template` left out (or, for an email, with neither part) draws the built-in copy. For
 * an email a subject alone or a body alone is a draft: the other part is the built-in one.
 */
export const MessagePreviewRequestSchema = z
  .discriminatedUnion('channel', [EmailPreviewRequest, SmsPreviewRequest])
  .meta({ ref: 'MessagePreviewRequest' })

/** The body of the message preview route. */
export type MessagePreviewRequest = z.infer<typeof MessagePreviewRequestSchema>

/**
 * A message as the server would word it, from fixed sample values: text, and nothing that is
 * markup. An email's HTML part is deliberately not here.
 *
 * - `subject`: the email's subject; `null` for a text message.
 * - `text`: the email's plain-text part, with the server's own facts, last sentence and
 *   footer where the message has them; or the whole text message, the server's
 *   origin-bound last line included where the environment has an allowed origin.
 * - `unused`: the parts of the draft the server would **not** use for this message, each
 *   with a fixed word for why; that part is drawn as the built-in copy. Empty when the
 *   draft was used as written.
 * - `segments`: for a text message, how a carrier would encode and split it (an estimate);
 *   `null` for an email.
 */
export const MessagePreviewSchema = z
  .strictObject({
    channel: z.enum(['email', 'sms']),
    kind: z.string(),
    subject: z.string().nullable(),
    text: z.string(),
    unused: z.array(
      z.strictObject({
        part: z.enum(['subject', 'body', 'text']),
        reason: z.enum([
          'invalid',
          'missing_value',
          'leading_digit',
          'empty',
          'too_long',
          'code_not_last',
        ]),
      })
    ),
    segments: z
      .strictObject({
        encoding: z.enum(['gsm7', 'ucs2']),
        units: z.number().int(),
        segments: z.number().int(),
      })
      .nullable(),
  })
  .meta({ ref: 'MessagePreview' })

/** The answer of the message preview route. */
export type MessagePreview = z.infer<typeof MessagePreviewSchema>
