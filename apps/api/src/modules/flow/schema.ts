import { SessionClientSchema } from '@tula/contract'
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

/** Header naming the kind of client, which decides how the refresh token is delivered. */
export const CLIENT_HEADER = 'x-tula-client'

/** Path parameter naming a sign-in, sign-up or password-reset attempt. */
export const AttemptIdParamSchema = z.object({ attemptId: z.uuid() })

/**
 * Request headers the flow routes read. `x-tula-client` defaults to `web`, the safer delivery:
 * the refresh token then goes into an httpOnly cookie instead of the response body.
 */
export const ClientHeaderSchema = z.object({ [CLIENT_HEADER]: SessionClientSchema.optional() })
