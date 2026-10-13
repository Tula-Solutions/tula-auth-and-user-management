import { z } from 'zod'
import {
  MAX_SMS_TEMPLATE_LENGTH,
  SMS_TEMPLATE_KINDS,
  type SmsTemplateKind,
  smsTemplateProblems,
} from './sms-template'

/**
 * An environment's wording for one kind of text message (ADR 0042): the sentence that
 * carries the code.
 *
 * **Plain text on one line, with `{{name}}` placeholders and nothing else**, at most
 * {@link MAX_SMS_TEMPLATE_LENGTH} characters. The origin-bound last line (`@host #code`) is
 * the server's: it is added after the sentence and is never part of a template.
 */
export const SmsTemplateSchema = z
  .strictObject({ text: z.string().max(MAX_SMS_TEMPLATE_LENGTH) })
  .meta({ ref: 'SmsTemplate' })

type Shape = { [Kind in SmsTemplateKind]: z.ZodOptional<typeof SmsTemplateSchema> }

const shape = Object.fromEntries(
  SMS_TEMPLATE_KINDS.map((kind) => [kind, SmsTemplateSchema.optional()])
) as Shape

/**
 * An environment's text message templates, by kind (`SMS_TEMPLATE_KINDS`). A kind left out
 * sends the built-in text; a kind the server does not know is refused.
 *
 * A template is refused, with the path of its text, when it lacks `{{code}}` or names it
 * (or the app) twice, names a placeholder its kind does not have, has a brace that is not
 * part of a `{{name}}`, lets a letter, a digit or another placeholder touch a placeholder,
 * holds four or more digits in a row, starts a word with `@` or `#`, does not start with a
 * letter of its own, or holds a line break, a control character, a hidden character,
 * nothing a reader can see, or anything that reads as a link, an address or a domain name.
 */
export const SmsTemplatesSchema = z
  .strictObject(shape)
  .superRefine((templates, context) => {
    for (const kind of SMS_TEMPLATE_KINDS) {
      const template = templates[kind]
      if (template === undefined) {
        continue
      }
      for (const problem of smsTemplateProblems(kind, template)) {
        context.addIssue({
          code: 'custom',
          path: [kind, problem.field],
          message: problem.message,
        })
      }
    }
  })
  .meta({ ref: 'SmsTemplates' })
