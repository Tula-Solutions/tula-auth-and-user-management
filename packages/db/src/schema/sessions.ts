import { sql } from 'drizzle-orm'
import { check, index, inet, jsonb, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { primaryKey, timestamps } from '../mixins'
import {
  tenantColumns,
  tenantConstraints,
  tenantForeignKey,
  tenantParentKey,
} from '../tenant-columns'
import { tula } from './pg-schema'
import { users } from './users'

/** Client platforms a session was created from. */
export const SESSION_CLIENTS = ['web', 'ios', 'android', 'server'] as const

/** Why a session ended early. */
export const SESSION_REVOKE_REASONS = [
  'sign_out',
  'revoked_by_user',
  'revoked_by_admin',
  'password_changed',
  'reuse_detected',
  'user_banned',
  'mfa_changed',
  'session_limit',
] as const

/** How a session is held: `hybrid` (access + refresh tokens) or `stateful` (one cookie). */
export const SESSION_TYPES = ['hybrid', 'stateful'] as const

/**
 * A signed-in device. A session is also the refresh-token *family*: reuse detection revokes the
 * session, which invalidates every refresh token issued for it at once.
 */
export const sessions = tula.table(
  'sessions',
  {
    id: primaryKey(),
    ...tenantColumns(),
    userId: uuid('user_id').notNull(),
    /** Session profile name from config (`web`, `mobile`, …). */
    profile: text('profile').notNull(),
    /**
     * How the session is held, fixed when it is created (its profile's type at that moment).
     * A `stateful` session has exactly one token row, never rotated: the hash of its cookie.
     * Rows written before the column existed are `hybrid`, which is all there was.
     */
    type: text('type', { enum: SESSION_TYPES }).notNull().default('hybrid'),
    client: text('client', { enum: SESSION_CLIENTS }).notNull(),
    userAgent: text('user_agent'),
    ipAddress: inet('ip_address'),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }).notNull(),
    idleExpiresAt: timestamp('idle_expires_at', { withTimezone: true }).notNull(),
    /** `null` when the profile has no absolute cap. */
    absoluteExpiresAt: timestamp('absolute_expires_at', { withTimezone: true }),
    /**
     * When the user last actively proved a factor for this session: its sign-in, or the last
     * step-up. The access token's `auth_time`. `null` only on rows written before the column
     * existed, which are read as "at creation".
     */
    factorVerifiedAt: timestamp('factor_verified_at', { withTimezone: true }),
    /** Every method proven for this session so far: the access token's `amr`. */
    authMethods: text('auth_methods').array().notNull().default(sql`'{}'::text[]`),
    /**
     * The claims the environment's `before_token` hook last answered for this session (ADR
     * 0035): asked when the session is created and each time its user proves a factor again,
     * and issued from here at every refresh in between, so that a refresh asks nobody.
     * `null` when there are none: no hook, a hook that answered with none, or one that failed
     * and lets through on failure.
     *
     * The service holds the rules (key grammar, reserved names, the 1,024-byte cap) when it
     * writes and **again when it reads**; the check below is only the table's own bound, so
     * that no write of any kind makes a session row an unbounded document.
     */
    hookClaims: jsonb('hook_claims').$type<Record<string, unknown>>(),
    /**
     * The key the session is bound to (ADR 0043): the SHA-256 thumbprint (RFC 7638,
     * base64url) of the public key its client presented when the sign-in started. A refresh
     * of such a session needs a proof signed by that key. `null` for a session that is not
     * bound, which is every `stateful` one.
     *
     * Written when the session is created and never again: a session cannot be bound later,
     * moved to another key or unbound. The trigger `sessions_device_thumbprint_immutable`
     * (hand-written in the migration: Drizzle declares no triggers) holds that for every
     * statement, whoever sends it.
     */
    deviceThumbprint: text('device_thumbprint'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokeReason: text('revoke_reason', { enum: SESSION_REVOKE_REASONS }),
    ...timestamps(),
  },
  (t) => [
    index('sessions_user_id_idx').on(t.userId),
    check(
      'sessions_hook_claims_bounds',
      sql`${t.hookClaims} is null or (jsonb_typeof(${t.hookClaims}) = 'object' and octet_length(${t.hookClaims}::text) <= 4096)`
    ),
    check(
      'sessions_device_thumbprint_shape',
      sql`${t.deviceThumbprint} is null or (${t.type} = 'hybrid' and ${t.deviceThumbprint} ~ '^[A-Za-z0-9_-]{43}$')`
    ),
    tenantParentKey('sessions', t),
    tenantForeignKey('sessions_user_fk', t, t.userId, users),
    ...tenantConstraints('sessions', t),
  ]
)

/** A session row. */
export type Session = typeof sessions.$inferSelect
/** Insert shape for a session. */
export type NewSession = typeof sessions.$inferInsert
