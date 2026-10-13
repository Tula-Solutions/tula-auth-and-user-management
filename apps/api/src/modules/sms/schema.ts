import { SMS_USAGE_DEFAULT_DAYS, SMS_USAGE_MAX_DAYS } from '@tula/contract'
import { z } from 'zod'

/** The usage shapes are owned by the contract so every client reads the same ones. */
export { SmsUsageSchema } from '@tula/contract'

/**
 * The query of `GET /v1/admin/sms/usage`: how many days back to read, today (UTC) included.
 * A whole number from 1 to {@link SMS_USAGE_MAX_DAYS}; {@link SMS_USAGE_DEFAULT_DAYS} when
 * left out. Nothing else is taken: there is no way to ask for a number.
 */
export const SmsUsageQuerySchema = z.strictObject({
  days: z.coerce.number().int().min(1).max(SMS_USAGE_MAX_DAYS).default(SMS_USAGE_DEFAULT_DAYS),
})

/** The query of the SMS usage route. */
export type SmsUsageQuery = z.infer<typeof SmsUsageQuerySchema>
