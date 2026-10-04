import { z } from 'zod'

/** Session shapes are owned by the contract so every SDK agrees on them. */
export {
  RefreshTokenRequestSchema,
  RevokedSessionsSchema,
  SessionListSchema,
  SessionTokensSchema,
  StepUpRequestSchema,
} from '@tula/contract'

/** Path parameter naming one of the user's sessions. */
export const SessionIdParamSchema = z.object({ sessionId: z.uuid() })
