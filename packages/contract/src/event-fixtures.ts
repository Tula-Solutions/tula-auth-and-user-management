import { type ActivityType, EVENT_SCHEMA_VERSION } from './event-types'
import type { EventOf } from './events'

// One example of every event, as plain data. The ids are made up (UUID v7, like the server's).
// This module imports no Zod at run time: the schemas are imported as types only.

const USER = '0199c2f4-7a10-7c3e-9b1a-5d2e8f4a6c01'
const SESSION = '0199c2f4-7a11-7d42-8e0b-1c9a3b7d5e02'
const API_KEY = '0199c2f4-7a12-7a55-b3c4-6f1e2d8a9b03'
const ENVIRONMENT = '0199c2f4-7a13-7b66-a4d5-7e2f3c9b0a04'
const PASSKEY = '0199c2f4-7a14-7c77-95e6-8f3a4d0c1b05'
const SIGNING_KEY = '0199c2f4-7a15-7d88-86f7-9a4b5e1d2c06'

const schemaVersion = EVENT_SCHEMA_VERSION
const occurredAt = '2026-10-08T09:30:00.000Z'

// A signed-in user acting on their own account; a secret key (the id is the API key's); and
// the server acting by itself.
const user = { type: 'user', id: USER } as const
const admin = { type: 'admin', id: API_KEY } as const
const system = { type: 'system', id: null } as const

const aboutUser = { type: 'user', id: USER } as const
const aboutSession = { type: 'session', id: SESSION } as const
const aboutApiKey = { type: 'api_key', id: API_KEY } as const
const aboutEnvironment = { type: 'environment', id: ENVIRONMENT } as const

/** The id of the `n`th example event. */
function eventId(n: number): string {
  return `0199c2f5-0000-7000-8000-${String(n).padStart(12, '0')}`
}

/**
 * A valid example of every event type, keyed by type: for documentation, for a receiver's
 * tests and for sending a test delivery. Every optional field is present, so an example shows
 * the whole shape. Typed so that a type without an example does not compile.
 *
 * Plain data: nothing here is a real id.
 *
 * @example
 * ```ts
 * test('handles a replayed refresh token', () => {
 *   handle(EVENT_FIXTURES['session.reuse_detected'])
 * })
 * ```
 */
export const EVENT_FIXTURES: { readonly [T in ActivityType]: EventOf<T> } = {
  'user.created': {
    id: eventId(1),
    type: 'user.created',
    schemaVersion,
    occurredAt,
    actor: user,
    target: aboutUser,
    data: { method: 'sign_up', emailVerified: true, passwordless: true },
  },
  'user.email_verified': {
    id: eventId(2),
    type: 'user.email_verified',
    schemaVersion,
    occurredAt,
    actor: user,
    target: aboutUser,
    data: {},
  },
  'user.banned': {
    id: eventId(3),
    type: 'user.banned',
    schemaVersion,
    occurredAt,
    actor: admin,
    target: aboutUser,
    data: {},
  },
  'user.unbanned': {
    id: eventId(4),
    type: 'user.unbanned',
    schemaVersion,
    occurredAt,
    actor: admin,
    target: aboutUser,
    data: {},
  },
  'user.deleted': {
    id: eventId(5),
    type: 'user.deleted',
    schemaVersion,
    occurredAt,
    actor: admin,
    target: aboutUser,
    data: {},
  },
  'user.password_changed': {
    id: eventId(6),
    type: 'user.password_changed',
    schemaVersion,
    occurredAt,
    actor: user,
    target: aboutUser,
    data: { method: 'email_verification', created: false, removed: true },
  },
  'user.mfa_enabled': {
    id: eventId(7),
    type: 'user.mfa_enabled',
    schemaVersion,
    occurredAt,
    actor: user,
    target: aboutUser,
    data: { method: 'totp' },
  },
  'user.mfa_disabled': {
    id: eventId(8),
    type: 'user.mfa_disabled',
    schemaVersion,
    occurredAt,
    actor: admin,
    target: aboutUser,
    data: { method: 'admin_reset' },
  },
  'user.backup_codes_regenerated': {
    id: eventId(9),
    type: 'user.backup_codes_regenerated',
    schemaVersion,
    occurredAt,
    actor: user,
    target: aboutUser,
    data: {},
  },
  'user.backup_code_used': {
    id: eventId(10),
    type: 'user.backup_code_used',
    schemaVersion,
    occurredAt,
    actor: user,
    target: aboutUser,
    data: {},
  },
  'user.identity_linked': {
    id: eventId(11),
    type: 'user.identity_linked',
    schemaVersion,
    occurredAt,
    actor: user,
    target: aboutUser,
    data: { provider: 'google', method: 'auto' },
  },
  'user.identity_unlinked': {
    id: eventId(12),
    type: 'user.identity_unlinked',
    schemaVersion,
    occurredAt,
    actor: user,
    target: aboutUser,
    data: { provider: 'github' },
  },
  'user.passkey_added': {
    id: eventId(13),
    type: 'user.passkey_added',
    schemaVersion,
    occurredAt,
    actor: user,
    target: aboutUser,
    data: { passkeyId: PASSKEY, synced: true },
  },
  'user.passkey_renamed': {
    id: eventId(14),
    type: 'user.passkey_renamed',
    schemaVersion,
    occurredAt,
    actor: user,
    target: aboutUser,
    data: { passkeyId: PASSKEY },
  },
  'user.passkey_removed': {
    id: eventId(15),
    type: 'user.passkey_removed',
    schemaVersion,
    occurredAt,
    actor: user,
    target: aboutUser,
    data: { passkeyId: PASSKEY, method: 'user', canStillSignIn: true },
  },
  'user.passkey_counter_regressed': {
    id: eventId(16),
    type: 'user.passkey_counter_regressed',
    schemaVersion,
    occurredAt,
    actor: system,
    target: aboutUser,
    data: { passkeyId: PASSKEY },
  },
  'session.created': {
    id: eventId(17),
    type: 'session.created',
    schemaVersion,
    occurredAt,
    actor: user,
    target: aboutSession,
    data: { userId: USER, client: 'web' },
  },
  'session.revoked': {
    id: eventId(18),
    type: 'session.revoked',
    schemaVersion,
    occurredAt,
    actor: user,
    target: aboutSession,
    data: { userId: USER, reason: 'sign_out' },
  },
  'session.reuse_detected': {
    id: eventId(19),
    type: 'session.reuse_detected',
    schemaVersion,
    occurredAt,
    actor: system,
    target: aboutSession,
    data: { userId: USER, reason: 'reuse_detected' },
  },
  'session.stepped_up': {
    id: eventId(20),
    type: 'session.stepped_up',
    schemaVersion,
    occurredAt,
    actor: user,
    target: aboutSession,
    data: { userId: USER, methods: ['otp', 'mfa'] },
  },
  'api_key.created': {
    id: eventId(21),
    type: 'api_key.created',
    schemaVersion,
    occurredAt,
    actor: admin,
    target: aboutApiKey,
    data: { kind: 'secret' },
  },
  'api_key.revoked': {
    id: eventId(22),
    type: 'api_key.revoked',
    schemaVersion,
    occurredAt,
    actor: admin,
    target: aboutApiKey,
    data: {},
  },
  'signing_key.rotated': {
    id: eventId(23),
    type: 'signing_key.rotated',
    schemaVersion,
    occurredAt,
    actor: admin,
    target: { type: 'signing_key', id: SIGNING_KEY },
    data: {
      retiredKeyId: '0199c2f4-7a16-7e99-97a8-ab5c6f2e3d07',
      nextKeyId: '0199c2f4-7a17-7faa-88b9-bc6d7a3f4e08',
    },
  },
  'environment.settings_updated': {
    id: eventId(24),
    type: 'environment.settings_updated',
    schemaVersion,
    occurredAt,
    actor: admin,
    target: aboutEnvironment,
    data: {
      revision: 4,
      changed: ['password.minLength', 'urls.allowedOrigins'],
      weakened: true,
      managedBy: 'tula-apply',
      outsideConfig: false,
    },
  },
  'oauth_provider.updated': {
    id: eventId(25),
    type: 'oauth_provider.updated',
    schemaVersion,
    occurredAt,
    actor: admin,
    target: aboutEnvironment,
    data: { provider: 'google', changed: ['clientId', 'secret', 'enabled'], created: true },
  },
  'oauth_provider.deleted': {
    id: eventId(26),
    type: 'oauth_provider.deleted',
    schemaVersion,
    occurredAt,
    actor: admin,
    target: aboutEnvironment,
    data: { provider: 'apple' },
  },
}
