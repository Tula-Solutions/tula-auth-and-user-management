import { z } from 'zod'

/** Prefix of refresh tokens, so secret scanners and humans can recognise one. */
export const REFRESH_TOKEN_PREFIX = 'tula_rt_'

/** The kind of client a session was created from. Decides how the refresh token is delivered. */
export const SessionClientSchema = z
  .enum(['web', 'ios', 'android', 'server'])
  .meta({ ref: 'SessionClient' })

/**
 * A signed-in device, as shown in the account's device list.
 *
 * Never contains token material. `current` marks the session making the request.
 */
export const SessionSchema = z
  .object({
    id: z.string(),
    client: SessionClientSchema,
    userAgent: z.string().nullable(),
    ipAddress: z.string().nullable(),
    createdAt: z.iso.datetime(),
    lastActiveAt: z.iso.datetime(),
    /** When the session ends if it stays idle (or hits its absolute limit, if sooner). */
    expiresAt: z.iso.datetime(),
    current: z.boolean(),
  })
  .meta({ ref: 'Session' })

/** The signed-in user's active sessions, most recently active first. */
export const SessionListSchema = z
  .object({ data: z.array(SessionSchema) })
  .meta({ ref: 'SessionList' })

/**
 * Body of refresh and sign-out requests.
 *
 * Native and server clients send `refreshToken`. Browsers send an empty body: their refresh
 * token travels in an httpOnly cookie that JavaScript cannot read.
 */
export const RefreshTokenRequestSchema = z
  .object({ refreshToken: z.string().max(512).optional() })
  .meta({ ref: 'RefreshTokenRequest' })

/** Result of revoking the user's other sessions. */
export const RevokedSessionsSchema = z
  .object({ revoked: z.number().int().min(0) })
  .meta({ ref: 'RevokedSessions' })

/** Session client kind. */
export type SessionClient = z.infer<typeof SessionClientSchema>
/** A signed-in device. */
export type Session = z.infer<typeof SessionSchema>
/** List of sessions. */
export type SessionList = z.infer<typeof SessionListSchema>
/** Refresh / sign-out request body. */
export type RefreshTokenRequest = z.infer<typeof RefreshTokenRequestSchema>
/** Count of revoked sessions. */
export type RevokedSessions = z.infer<typeof RevokedSessionsSchema>
