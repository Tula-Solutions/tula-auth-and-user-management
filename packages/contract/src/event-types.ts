// The names of the events the API records, their schema version and what each is about. This
// module imports no Zod (types only), so a webhook receiver or an SDK can switch on an event's
// `type` without a schema library in its bundle: `@tula/contract/event-types`. The payload
// schemas themselves are in `./events`.

import type { AuditTargetType } from './audit'

/**
 * Everything the API records. Each entry is written to the event outbox (for webhooks) and to
 * the audit log, in the same database transaction as the change it describes.
 *
 * A session ends with exactly one of `session.revoked` (its `reason` says why) or
 * `session.reuse_detected` (a rotated refresh token was replayed, so the session was revoked as
 * possibly stolen).
 *
 * A new type needs three things, and a test fails for each one that is missing: its name here
 * (and in {@link EVENT_TARGET_TYPES}), a `data` schema in `EVENT_DATA_SCHEMAS` and an example
 * in `EVENT_FIXTURES`.
 *
 * @example
 * ```ts
 * import { ACTIVITY_TYPES, type ActivityType } from '@tula/contract/event-types'
 *
 * function isKnown(type: string): type is ActivityType {
 *   return (ACTIVITY_TYPES as readonly string[]).includes(type)
 * }
 * ```
 */
export const ACTIVITY_TYPES = [
  'user.created',
  'user.email_verified',
  'user.banned',
  'user.unbanned',
  'user.deleted',
  'user.password_changed',
  // Two-step verification: turned on (a confirmed authenticator), turned off (`method` says by
  // the user or by an admin reset), a new set of backup codes, and a backup code used to get in.
  'user.mfa_enabled',
  'user.mfa_disabled',
  'user.backup_codes_regenerated',
  'user.backup_code_used',
  // A provider account (Google, GitHub, Apple, Microsoft, Discord, LinkedIn) connected to or disconnected from a user;
  // `provider` says which, `method` how (`auto`, `profile`).
  'user.identity_linked',
  'user.identity_unlinked',
  'user.passkey_added',
  'user.passkey_renamed',
  'user.passkey_removed',
  'user.passkey_counter_regressed',
  // A phone number verified and stored on a user, or taken off again (ADR 0037). The number
  // itself, its country and its digits are never in an event.
  'user.phone_number_added',
  'user.phone_number_removed',
  'session.created',
  'session.revoked',
  'session.reuse_detected',
  // A signed-in user proved a factor again for a session (a step-up); `methods` says which.
  'session.stepped_up',
  'api_key.created',
  'api_key.revoked',
  'signing_key.rotated',
  'environment.settings_updated',
  // An OAuth provider's credentials set, changed or removed. `changed` lists keys, never values.
  'oauth_provider.updated',
  'oauth_provider.deleted',
  // A webhook endpoint registered, changed or removed. `changed` lists field names; neither
  // the endpoint's address nor its signing secret is ever in an event.
  'webhook_endpoint.created',
  'webhook_endpoint.updated',
  'webhook_endpoint.deleted',
  // The server switched an endpoint off by itself: its deliveries kept failing, or it answered
  // `410 Gone`. `reason` says which. Switching it back on is a `webhook_endpoint.updated`.
  'webhook_endpoint.disabled',
  // An endpoint's signing secret was replaced: the new one signs beside the previous one until
  // `rotationOverlapEndsAt`. Nothing of either secret is ever in the event.
  'webhook_endpoint.secret_rotated',
  // An administrator ended that overlap early: the previous secret stopped signing at once.
  'webhook_endpoint.previous_secret_revoked',
  // A hook registered, changed or removed (ADR 0035). `changed` lists field names; neither
  // the hook's address nor its signing secret is ever in an event. `weakened` says the change
  // lets through what the hook used to stop.
  'hook.created',
  'hook.updated',
  'hook.deleted',
] as const

/** A recorded action type: one of {@link ACTIVITY_TYPES}. */
export type ActivityType = (typeof ACTIVITY_TYPES)[number]

/**
 * The version of the event payloads: the `schemaVersion` of every event.
 *
 * Within a version a payload only grows: a later server may add an event type, a field or an
 * enum value, so a receiver ignores what it does not know. Removing or renaming a field, or
 * changing what one means, is a new version.
 *
 * @example
 * ```ts
 * if (event.schemaVersion !== EVENT_SCHEMA_VERSION) {
 *   // Written by a server with a newer payload format than this code was built for.
 * }
 * ```
 */
export const EVENT_SCHEMA_VERSION = 1

/**
 * What each event is about: the `target.type` of its payload. `target.id` is that thing's id.
 *
 * An event about a user's credentials targets the `user` (the passkey or session concerned
 * is named in `data`); an OAuth provider's credentials belong to the `environment`. A webhook
 * endpoint has an id of its own, as an API key does, so it is its own kind of target, and so
 * is a hook.
 *
 * @example
 * ```ts
 * EVENT_TARGET_TYPES['session.revoked'] // 'session'
 * ```
 */
export const EVENT_TARGET_TYPES = {
  'user.created': 'user',
  'user.email_verified': 'user',
  'user.banned': 'user',
  'user.unbanned': 'user',
  'user.deleted': 'user',
  'user.password_changed': 'user',
  'user.mfa_enabled': 'user',
  'user.mfa_disabled': 'user',
  'user.backup_codes_regenerated': 'user',
  'user.backup_code_used': 'user',
  'user.identity_linked': 'user',
  'user.identity_unlinked': 'user',
  'user.passkey_added': 'user',
  'user.passkey_renamed': 'user',
  'user.passkey_removed': 'user',
  'user.passkey_counter_regressed': 'user',
  'user.phone_number_added': 'user',
  'user.phone_number_removed': 'user',
  'session.created': 'session',
  'session.revoked': 'session',
  'session.reuse_detected': 'session',
  'session.stepped_up': 'session',
  'api_key.created': 'api_key',
  'api_key.revoked': 'api_key',
  'signing_key.rotated': 'signing_key',
  'environment.settings_updated': 'environment',
  'oauth_provider.updated': 'environment',
  'oauth_provider.deleted': 'environment',
  'webhook_endpoint.created': 'webhook_endpoint',
  'webhook_endpoint.updated': 'webhook_endpoint',
  'webhook_endpoint.deleted': 'webhook_endpoint',
  'webhook_endpoint.disabled': 'webhook_endpoint',
  'webhook_endpoint.secret_rotated': 'webhook_endpoint',
  'webhook_endpoint.previous_secret_revoked': 'webhook_endpoint',
  'hook.created': 'hook',
  'hook.updated': 'hook',
  'hook.deleted': 'hook',
} as const satisfies Record<ActivityType, AuditTargetType>

/** What an event of type `T` is about. */
export type EventTargetType<T extends ActivityType = ActivityType> = (typeof EVENT_TARGET_TYPES)[T]
