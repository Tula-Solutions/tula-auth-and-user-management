import { FLOW_ATTEMPT_HEADER, SessionClientSchema } from '@tula/contract'
import { z } from 'zod'

/** Flow shapes are owned by the contract so every SDK renders the same steps. */
export {
  FlowAttemptSchema,
  PasswordAttemptRequestSchema,
  PasswordResetRequestSchema,
  PasswordResetStartRequestSchema,
  SignInStartRequestSchema,
  SignUpRequestSchema,
  VerifyEmailRequestSchema,
} from '@tula/contract'

/** Header carrying an attempt's secret; defined by the contract so every SDK sends the same one. */
export { FLOW_ATTEMPT_HEADER }

/** Longest attempt secret the API reads. A real one is 51 characters. */
export const MAX_ATTEMPT_SECRET_LENGTH = 256

/** Header naming the kind of client, which decides how the refresh token is delivered. */
export const CLIENT_HEADER = 'x-tula-client'

/** Path parameter naming a sign-in, sign-up or password-reset attempt. */
export const AttemptIdParamSchema = z.object({ attemptId: z.uuid() })

/**
 * Request headers the flow routes read. `x-tula-client` defaults to `web`, the safer delivery:
 * the refresh token then goes into an httpOnly cookie instead of the response body.
 */
export const ClientHeaderSchema = z.object({ [CLIENT_HEADER]: SessionClientSchema.optional() })

/**
 * The header every call after an attempt's start carries. Optional in the schema on purpose: a
 * missing secret must answer the same `flow.not_found` as a wrong one, not a validation error
 * that would tell an attempt id apart from a made-up one.
 */
export const AttemptHeaderSchema = z.object({
  [FLOW_ATTEMPT_HEADER]: z
    .string()
    .max(MAX_ATTEMPT_SECRET_LENGTH)
    .optional()
    .meta({
      description:
        'The `attemptSecret` returned when the attempt was started. Without it, or with any ' +
        'other value, the attempt answers `flow.not_found`.',
    }),
})
