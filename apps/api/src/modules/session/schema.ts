import { z } from 'zod'

/** Session shapes are owned by the contract so every SDK agrees on them. */
export {
  AccessTokenClaimsSchema,
  RefreshTokenRequestSchema,
  RevokedSessionsSchema,
  SessionListSchema,
  SessionTokensSchema,
  StepUpEmailCodeSchema,
  StepUpRequestSchema,
  VerifySessionRequestSchema,
} from '@tula/contract'

/** Path parameter naming one of the user's sessions. */
export const SessionIdParamSchema = z.object({ sessionId: z.uuid() })

/** Path parameter naming the user an admin route acts on. */
export const UserIdParamSchema = z.object({ userId: z.uuid() })

/** A user id and one of their sessions' ids in the path. */
export const UserSessionParamSchema = z.object({ userId: z.uuid(), sessionId: z.uuid() })
