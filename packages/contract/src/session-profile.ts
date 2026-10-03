import { z } from 'zod'
import { DurationSchema } from './duration'

/** Session types from business plan §5.3. Phase 0 implements `hybrid` only. */
export const SessionTypeSchema = z
  .enum(['hybrid', 'stateful', 'stateless', 'long-lived', 'kiosk'])
  .meta({ ref: 'SessionType' })

/**
 * Session types the server can issue today.
 *
 * Phase 0 issues only {@link DEFAULT_WEB_SESSION_PROFILE}: no configuration path selects another
 * profile yet, so the other types and the `refresh.rotate`, `refresh.reuseDetection`,
 * `multiSession` and `maxConcurrent` fields are not read by the server until named profiles land.
 */
export const IMPLEMENTED_SESSION_TYPES: ReadonlySet<SessionType> = new Set(['hybrid'])

/**
 * A named session profile: which session type to issue and how long it lives.
 *
 * Idle timeout signs a user out after inactivity (measured at refresh time, so precision equals
 * the access-token TTL). Absolute timeout caps session age regardless of activity.
 */
export const SessionProfileSchema = z
  .object({
    type: SessionTypeSchema,
    accessTokenTtl: DurationSchema,
    refresh: z.object({
      rotate: z.boolean(),
      reuseDetection: z.boolean(),
      /**
       * Concurrent-refresh grace window. If a refresh token that was rotated less than this long
       * ago is presented again, the server returns the **same child refresh token** it already
       * issued (derived from the parent, never stored) plus a freshly signed access token: an
       * idempotent retry for racing tabs/requests instead of treating it as theft. Any reuse
       * after the window, or reuse of a token whose child was itself rotated, revokes the whole
       * family. This is the only exception to reuse detection.
       */
      reuseGracePeriod: DurationSchema,
    }),
    idleTimeout: DurationSchema,
    /** `null` = no hard cap (e.g. mobile "stay signed in"). */
    absoluteTimeout: DurationSchema.nullable(),
    multiSession: z.boolean(),
    maxConcurrent: z.number().int().min(1).nullable(),
  })
  .meta({ ref: 'SessionProfile' })

/** Session type. */
export type SessionType = z.infer<typeof SessionTypeSchema>
/** Session profile. */
export type SessionProfile = z.infer<typeof SessionProfileSchema>

/** Default `web` profile: hybrid, 60s access tokens, 7 days idle, 30 days absolute (§5.3). */
export const DEFAULT_WEB_SESSION_PROFILE: SessionProfile = {
  type: 'hybrid',
  accessTokenTtl: '60s',
  refresh: { rotate: true, reuseDetection: true, reuseGracePeriod: '10s' },
  idleTimeout: '7d',
  absoluteTimeout: '30d',
  multiSession: true,
  maxConcurrent: null,
}
