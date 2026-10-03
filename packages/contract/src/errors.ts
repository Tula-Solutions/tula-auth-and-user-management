import { z } from 'zod'
import { ERROR_CODES } from './error-codes'

// The codes themselves are plain data in `./error-codes` (importable without Zod as
// `@tula/contract/error-codes`); this module adds the schemas built on them.
export * from './error-codes'

/** Zod schema for an error code. */
export const ErrorCodeSchema = z.enum(ERROR_CODES).meta({ ref: 'ErrorCode' })

/** Parameters that give an error its specifics, e.g. `{ min: 10 }` for `password.too_short`. */
export const ErrorParamsSchema = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
  .meta({ ref: 'ErrorParams' })

/** One field-level problem inside a `validation.failed` (or password) error. */
export const FieldErrorSchema = z
  .object({
    field: z.string(),
    code: ErrorCodeSchema,
    message: z.string(),
    params: ErrorParamsSchema.optional(),
  })
  .meta({ ref: 'FieldError' })

/**
 * The body of every non-2xx API response.
 *
 * Extends payhub's `{ status, code, detail }` with typed `params` and per-field `errors` so every
 * SDK can render precise, localized messages without parsing English text.
 */
export const ErrorEnvelopeSchema = z
  .object({
    status: z.number().int(),
    code: ErrorCodeSchema,
    detail: z.string(),
    params: ErrorParamsSchema.optional(),
    errors: z.array(FieldErrorSchema).optional(),
  })
  .meta({ ref: 'ErrorEnvelope' })

/** Parameters attached to an error. */
export type ErrorParams = z.infer<typeof ErrorParamsSchema>
/** A field-level error. */
export type FieldError = z.infer<typeof FieldErrorSchema>
/** The API error response body. */
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>
