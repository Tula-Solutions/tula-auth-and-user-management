import { z } from 'zod'
import {
  EMAIL_TEMPLATE_KINDS,
  type EmailTemplateKind,
  emailTemplateProblems,
  emailTemplatesBytes,
  MAX_EMAIL_BODY_LENGTH,
  MAX_EMAIL_SUBJECT_LENGTH,
  MAX_EMAIL_TEMPLATES_BYTES,
} from './email-template'

/**
 * An environment's wording for one kind of email (ADR 0039): a subject, a body, or both. The
 * part left out is the server's built-in copy.
 *
 * Both are **plain text with `{{name}}` placeholders and nothing else**: no HTML, no
 * Markdown, no expression. The server lays the body out (paragraphs are separated by a blank
 * line), escapes every character of it, and keeps the layout, the code's styling, the link's
 * button and the footer. A subject is at most {@link MAX_EMAIL_SUBJECT_LENGTH} characters on
 * one line, a body at most {@link MAX_EMAIL_BODY_LENGTH}.
 *
 * Which placeholders a kind has, and which its body must contain, is `EMAIL_TEMPLATE_RULES`.
 */
export const EmailTemplateSchema = z
  .strictObject({
    subject: z.string().max(MAX_EMAIL_SUBJECT_LENGTH).optional(),
    body: z.string().max(MAX_EMAIL_BODY_LENGTH).optional(),
  })
  .refine((template) => template.subject !== undefined || template.body !== undefined, {
    message: 'a template sets a subject, a body or both',
  })
  .meta({ ref: 'EmailTemplate' })

type Shape = { [Kind in EmailTemplateKind]: z.ZodOptional<typeof EmailTemplateSchema> }

const shape = Object.fromEntries(
  EMAIL_TEMPLATE_KINDS.map((kind) => [kind, EmailTemplateSchema.optional()])
) as Shape

/**
 * An environment's email templates, by kind (`EMAIL_TEMPLATE_KINDS`). A kind left out sends
 * the built-in copy; a kind the server does not know is refused.
 *
 * A template is refused, with the path of the field and the placeholder's name, when it
 * names a placeholder its kind does not have, lacks one its message needs (the code; for
 * `sign_in` the link too), has a brace that is not part of a `{{name}}`, or holds a control
 * character. A template of a notice is also refused when it holds anything that reads as a
 * link, an address or a domain name, or when its subject starts with a digit. Together the
 * templates take at most {@link MAX_EMAIL_TEMPLATES_BYTES} bytes as JSON.
 */
export const EmailTemplatesSchema = z
  .strictObject(shape)
  .superRefine((templates, context) => {
    for (const kind of EMAIL_TEMPLATE_KINDS) {
      const template = templates[kind]
      if (template === undefined) {
        continue
      }
      for (const problem of emailTemplateProblems(kind, template)) {
        context.addIssue({
          code: 'custom',
          path: [kind, problem.field],
          message: problem.message,
        })
      }
    }
    if (emailTemplatesBytes(templates) > MAX_EMAIL_TEMPLATES_BYTES) {
      context.addIssue({
        code: 'custom',
        path: [],
        message: `the templates together must take at most ${MAX_EMAIL_TEMPLATES_BYTES} bytes`,
      })
    }
  })
  .meta({ ref: 'EmailTemplates' })

/**
 * The `emails` section of an environment's settings: the wording of its emails.
 *
 * - `templates`: the environment's own subject and body for each kind of message. Empty by
 *   default: every message is the built-in copy.
 */
export const EmailSettingsSchema = z
  .strictObject({ templates: EmailTemplatesSchema.default({}) })
  .meta({ ref: 'EmailSettings' })

/** The `emails` section of an environment's settings. */
export type EmailSettings = z.infer<typeof EmailSettingsSchema>
