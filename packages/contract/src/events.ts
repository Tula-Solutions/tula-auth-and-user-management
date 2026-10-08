import { z } from 'zod'
import { AUDIT_ACTOR_TYPES, type AuditActorType } from './audit'
import { CONFIG_TOOL_PATTERN } from './environment-settings'
import {
  ACTIVITY_TYPES,
  type ActivityType,
  EVENT_SCHEMA_VERSION,
  EVENT_TARGET_TYPES,
  type EventTargetType,
} from './event-types'
import { HOOK_FAILURE_MODES, HOOK_FIELDS, HOOK_POINTS } from './hook'
import { OAuthProviderSchema } from './oauth'
import { SessionClientSchema } from './session'
import { AUTHENTICATION_METHODS } from './tokens'

// The payload of every event the API records: what a webhook delivers. Each type has a `data`
// schema and an envelope around it, both published as OpenAPI components.
//
// A payload is an ALLOW-LIST. A field is here because someone decided a third party may see
// it; nothing reaches a payload by being passed along. So, for every `data` schema:
//
//   - no email address, name, IP address, user agent, token, code, hash or key material, ever;
//   - a value from a closed set is an enum, not a string;
//   - a string is an id the server made (a UUID), with two exceptions, both in
//     `environment.settings_updated`: the names of changed settings (`changed`) and the name
//     of the managing tool (`managedBy`). Their patterns make them bounded names, NOT
//     secret-proof: a token-shaped string fits either. What keeps a secret out is that each
//     has one producer: `changed` is built by the API's `changedKeys` from the keys of the
//     settings document, and `managedBy` is the `x-tula-managed-by` header, validated when
//     the request is read. A new string field needs the same argument, not only a pattern.
//
// Within `EVENT_SCHEMA_VERSION` a payload only grows (see `./event-types`).

/**
 * An id the server generated (a UUID): a user, a session, a key, a passkey. Never client
 * input, and never a string that could hold anything else.
 */
const id = () => z.uuid()

/**
 * A `data` schema and the description its event is published with.
 *
 * @param name - The event's name in the OpenAPI document, e.g. `UserCreated`.
 * @param description - One sentence: when the event is recorded.
 * @param shape - The fields. Exactly what the event carries, nothing optional "just in case".
 */
function data<Shape extends z.ZodRawShape>(name: string, description: string, shape: Shape) {
  return z.object(shape).meta({ ref: `${name}EventData`, description })
}

/** Which passkey removal carries which fields; see `user.passkey_removed`. */
function passkeyRemovalIsWhole(removal: {
  method: 'user' | 'admin_reset'
  passkeyId?: string
  canStillSignIn?: boolean
}): boolean {
  const named = removal.passkeyId !== undefined
  const outcome = removal.canStillSignIn !== undefined
  return removal.method === 'user' ? named && !outcome : outcome && !named
}

const provider = OAuthProviderSchema

/**
 * The fields of a webhook endpoint an update can change, as `webhook_endpoint.updated` names
 * them. `url` says the address changed, never what it is or was.
 *
 * @example
 * ```ts
 * const changed: (typeof WEBHOOK_ENDPOINT_FIELDS)[number][] = ['url', 'enabled']
 * ```
 */
export const WEBHOOK_ENDPOINT_FIELDS = ['url', 'eventTypes', 'enabled'] as const

/**
 * Why the server switched a webhook endpoint off by itself, as `webhook_endpoint.disabled`
 * says it: `failing` when every delivery to it has failed for days, `gone` when it answered
 * `410 Gone`.
 *
 * @example
 * ```ts
 * const reason: (typeof WEBHOOK_DISABLED_REASONS)[number] = 'failing'
 * ```
 */
export const WEBHOOK_DISABLED_REASONS = ['failing', 'gone'] as const

/**
 * Most names an `environment.settings_updated` event lists in `changed`. Above what the
 * settings document can hold; the API has a test that builds the largest one.
 *
 * @example
 * ```ts
 * names.slice(0, MAX_CHANGED_SETTINGS)
 * ```
 */
export const MAX_CHANGED_SETTINGS = 256

/**
 * Longest name of a changed setting, e.g. `sessions.profiles.<name>.refresh.reuseGracePeriod`.
 *
 * @example
 * ```ts
 * name.length <= MAX_SETTING_NAME_LENGTH
 * ```
 */
export const MAX_SETTING_NAME_LENGTH = 128

/**
 * The `data` of each event type: the details beyond who (`actor`) and what (`target`).
 *
 * Typed so that a type in {@link ACTIVITY_TYPES} without an entry does not compile; the
 * contract's tests check the same at run time.
 *
 * @example
 * ```ts
 * EVENT_DATA_SCHEMAS['session.revoked'].parse({ userId: 'u_1', reason: 'sign_out' })
 * ```
 */
export const EVENT_DATA_SCHEMAS = {
  'user.created': data('UserCreated', 'A user account was created.', {
    /** How: by an admin, by a completed sign-up, or by a first sign-in with a provider. */
    method: z.enum(['admin', 'sign_up', 'oauth_google', 'oauth_github', 'oauth_apple']),
    /** Whether the account's email address was proven when it was created. */
    emailVerified: z.boolean(),
    /** `true` when the account was created without a password; absent otherwise. */
    passwordless: z.boolean().optional(),
    /**
     * `true` when the environment's `before_sign_up` hook could not be asked, or did not
     * answer as the contract says, and the account was created anyway because the hook's
     * failure mode is `allow`. Absent otherwise: when the hook allowed it, when there is no
     * hook, and for an account an administrator created (a hook is not asked about those).
     */
    hookBypassed: z.boolean().optional(),
  }),
  'user.email_verified': data('UserEmailVerified', 'A user proved their email address.', {}),
  'user.banned': data('UserBanned', 'A user was banned; their sessions end.', {}),
  'user.unbanned': data('UserUnbanned', 'A user’s ban was lifted.', {}),
  'user.deleted': data('UserDeleted', 'A user account was deleted.', {}),
  'user.password_changed': data(
    'UserPasswordChanged',
    'A user’s password was set, replaced or removed.',
    {
      /**
       * By whom: an admin (`admin_reset`), the signed-in user (`self`), a password reset
       * (`reset`), or the address being proven by someone who did not prove the password
       * (`email_verification`, always with `removed`).
       */
      method: z.enum(['admin_reset', 'self', 'reset', 'email_verification']),
      /** `true` when the account had no password before; absent otherwise. */
      created: z.boolean().optional(),
      /** `true` when the password was removed and none was set; absent otherwise. */
      removed: z.boolean().optional(),
    }
  ),
  'user.mfa_enabled': data('UserMfaEnabled', 'A user turned two-step verification on.', {
    /** The factor that was confirmed. */
    method: z.enum(['totp']),
  }),
  'user.mfa_disabled': data('UserMfaDisabled', 'A user’s two-step verification was removed.', {
    /**
     * By the user (`self`), by an admin (`admin_reset`), or by the server undoing an enrolment
     * that a sign-in could not finish (`enrolment_incomplete`).
     */
    method: z.enum(['self', 'admin_reset', 'enrolment_incomplete']),
  }),
  'user.backup_codes_regenerated': data(
    'UserBackupCodesRegenerated',
    'A user replaced their backup codes; the earlier set no longer works.',
    {}
  ),
  'user.backup_code_used': data(
    'UserBackupCodeUsed',
    'A user proved their second factor with a backup code.',
    {}
  ),
  'user.identity_linked': data(
    'UserIdentityLinked',
    'A provider account was connected to a user.',
    {
      provider,
      /** `auto`: at a sign-in, by a verified address; `profile`: by the signed-in user. */
      method: z.enum(['auto', 'profile']),
    }
  ),
  'user.identity_unlinked': data(
    'UserIdentityUnlinked',
    'A provider account was disconnected from a user.',
    { provider }
  ),
  'user.passkey_added': data('UserPasskeyAdded', 'A user registered a passkey.', {
    passkeyId: id(),
    /** Whether the authenticator reports the passkey as backed up (a synced passkey). */
    synced: z.boolean(),
  }),
  'user.passkey_renamed': data('UserPasskeyRenamed', 'A user renamed a passkey.', {
    passkeyId: id(),
  }),
  // One type, two shapes, told apart by `method`. The pairing is a check on the object (the
  // envelope's parse refuses a mixed one), not two types: a receiver handles one event.
  'user.passkey_removed': z
    .object({
      /**
       * Who removed what:
       *
       * - `user`: the owner removed one passkey. `passkeyId` is present, `canStillSignIn` is
       *   absent (the removal is refused when it would be the user's last way to sign in).
       * - `admin_reset`: an admin reset removed **every** passkey of the user. `passkeyId`
       *   is absent, `canStillSignIn` is present.
       */
      method: z.enum(['user', 'admin_reset']),
      /** With `method: 'user'` only: the passkey that was removed. */
      passkeyId: id().optional(),
      /** With `method: 'admin_reset'` only: whether the user still has a way to sign in. */
      canStillSignIn: z.boolean().optional(),
    })
    .refine(passkeyRemovalIsWhole, {
      message: '`passkeyId` goes with `user`, `canStillSignIn` with `admin_reset`',
    })
    .meta({
      ref: 'UserPasskeyRemovedEventData',
      description:
        'A passkey was removed by its owner (`method: user`, with `passkeyId`), or every passkey of a user by an admin reset (`method: admin_reset`, with `canStillSignIn`).',
    }),
  'user.passkey_counter_regressed': data(
    'UserPasskeyCounterRegressed',
    'A passkey’s signature counter did not grow: it may have been cloned. The sign-in was refused.',
    { passkeyId: id() }
  ),
  'session.created': data('SessionCreated', 'A user signed in.', {
    userId: id(),
    client: SessionClientSchema,
    /**
     * `true` when the environment's `before_session` hook could not be asked, or did not
     * answer as the contract says, and the session was created anyway because the hook's
     * failure mode is `allow`. Absent otherwise: when the hook allowed it and when there is
     * none.
     */
    hookBypassed: z.boolean().optional(),
    /**
     * `true` when the environment's `before_token` hook failed in the same way and the
     * session's tokens are issued **without** that hook's claims, because its failure mode is
     * `allow`. Absent otherwise. Named for the claims and not for the token, so that nothing
     * that flags a field by its name takes a boolean for a credential.
     */
    claimsHookBypassed: z.boolean().optional(),
  }),
  'session.revoked': data('SessionRevoked', 'A session was ended before it expired.', {
    userId: id(),
    reason: z.enum([
      'sign_out',
      'revoked_by_user',
      'revoked_by_admin',
      'password_changed',
      'user_banned',
      'mfa_changed',
      'session_limit',
    ]),
  }),
  'session.reuse_detected': data(
    'SessionReuseDetected',
    'A rotated refresh token was presented again: the session was ended as possibly stolen.',
    { userId: id(), reason: z.literal('reuse_detected') }
  ),
  'session.stepped_up': data(
    'SessionSteppedUp',
    'A signed-in user proved a factor again for a session.',
    {
      userId: id(),
      /** What was proven, as the access token’s `amr` names it. A set: order means nothing. */
      methods: z.array(z.enum(AUTHENTICATION_METHODS)).max(AUTHENTICATION_METHODS.length),
      /**
       * `true` when the environment's `before_token` hook failed at this step-up and the
       * session's tokens are issued without that hook's claims from now on, because its
       * failure mode is `allow`. Absent otherwise.
       */
      claimsHookBypassed: z.boolean().optional(),
    }
  ),
  'api_key.created': data('ApiKeyCreated', 'An API key was created.', {
    kind: z.enum(['publishable', 'secret']),
  }),
  'api_key.revoked': data('ApiKeyRevoked', 'An API key was revoked.', {}),
  'signing_key.rotated': data(
    'SigningKeyRotated',
    'An environment’s access-token signing keys were rotated. The target is the new active key.',
    { retiredKeyId: id(), nextKeyId: id() }
  ),
  'environment.settings_updated': data(
    'EnvironmentSettingsUpdated',
    'An environment’s settings were replaced.',
    {
      /** The settings’ revision after this change. */
      revision: z.number().int().positive(),
      /**
       * The dotted names of the settings that changed, e.g. `password.minLength`. Never a
       * value.
       *
       * **The set of names is open**: it follows the settings document, so a later server
       * lists settings this version does not know, and a name can hold what an operator
       * chose (a session profile's name: `sessions.profiles.back-office.idleTimeout`).
       * Treat each name as opaque text; do not switch on the whole list.
       *
       * Bounded (at most `MAX_CHANGED_SETTINGS` names of at most `MAX_SETTING_NAME_LENGTH`
       * characters), not secret-proof: see the note at the top of this module.
       */
      changed: z
        .array(
          z
            .string()
            .max(MAX_SETTING_NAME_LENGTH)
            .regex(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/)
        )
        .max(MAX_CHANGED_SETTINGS),
      /**
       * `true` when the change weakened a security setting or shortened what is kept (a
       * weaker password policy, a security notice switched off, a looser MFA policy, longer
       * sessions, an audit retention period set or shortened), by the definition of
       * `settingsWeakenings`; absent otherwise.
       */
      weakened: z.boolean().optional(),
      /**
       * The tool that applied a config file; `null` when its record was removed. The one
       * value in any payload that a client supplied (the `x-tula-managed-by` header): a
       * bounded name, not secret-proof.
       */
      managedBy: z.string().regex(CONFIG_TOOL_PATTERN).nullable().optional(),
      /** `true` when settings a config file manages were changed around it. */
      outsideConfig: z.boolean().optional(),
    }
  ),
  'oauth_provider.updated': data(
    'OAuthProviderUpdated',
    'An OAuth provider’s credentials were set or changed.',
    {
      provider,
      /** Which fields changed. Names only: `secret` says a secret changed, never what it is. */
      changed: z.array(z.enum(['clientId', 'secret', 'teamId', 'keyId', 'enabled'])).max(5),
      /** `true` when the provider was configured for the first time; absent otherwise. */
      created: z.boolean().optional(),
    }
  ),
  'oauth_provider.deleted': data(
    'OAuthProviderDeleted',
    'An OAuth provider’s credentials were removed.',
    { provider }
  ),
  'webhook_endpoint.created': data(
    'WebhookEndpointCreated',
    'A webhook endpoint was registered. Its address and signing secret are not in the event.',
    {
      /** How many event types the endpoint subscribed to. */
      eventTypes: z.number().int().min(1).max(ACTIVITY_TYPES.length),
      /** Whether the endpoint was registered switched on. */
      enabled: z.boolean(),
    }
  ),
  'webhook_endpoint.updated': data('WebhookEndpointUpdated', 'A webhook endpoint was changed.', {
    /** Which fields changed. Names only: `url` says the address changed, never what it is. */
    changed: z.array(z.enum(WEBHOOK_ENDPOINT_FIELDS)).min(1).max(WEBHOOK_ENDPOINT_FIELDS.length),
  }),
  'webhook_endpoint.deleted': data(
    'WebhookEndpointDeleted',
    'A webhook endpoint was removed; nothing more is delivered to it.',
    {}
  ),
  'webhook_endpoint.disabled': data(
    'WebhookEndpointDisabled',
    'The server switched a webhook endpoint off: its deliveries kept failing, or it answered 410 Gone. Nothing is delivered to it until it is switched on again.',
    {
      /** Why: one of {@link WEBHOOK_DISABLED_REASONS}. */
      reason: z.enum(WEBHOOK_DISABLED_REASONS),
    }
  ),
  'webhook_endpoint.secret_rotated': data(
    'WebhookEndpointSecretRotated',
    'A webhook endpoint’s signing secret was replaced. Deliveries carry a signature for the new secret and one for the previous secret until the time given; after it, for the new one only. Neither secret, nor any part of one, is in the event.',
    {
      /** When the previous secret stops signing, unless an administrator ends the overlap sooner. */
      rotationOverlapEndsAt: z.iso.datetime(),
    }
  ),
  'webhook_endpoint.previous_secret_revoked': data(
    'WebhookEndpointPreviousSecretRevoked',
    'An administrator ended the overlap of a secret rotation early: the endpoint’s previous signing secret stopped signing at once and was deleted. Deliveries carry a signature for the current secret only.',
    {}
  ),
  'hook.created': data(
    'HookCreated',
    'A hook was registered. Its address and signing secret are not in the event.',
    {
      /** When the server asks it. */
      point: z.enum(HOOK_POINTS),
      /** Whether it was registered switched on. */
      enabled: z.boolean(),
      /** What a failed call does: refuse (`deny`) or let through (`allow`). */
      failureMode: z.enum(HOOK_FAILURE_MODES),
      /** `true` when it was registered to let through on failure; absent otherwise. */
      weakened: z.boolean().optional(),
    }
  ),
  'hook.updated': data('HookUpdated', 'A hook was changed.', {
    point: z.enum(HOOK_POINTS),
    /** Which fields changed. Names only: `url` says the address changed, never what it is. */
    changed: z.array(z.enum(HOOK_FIELDS)).min(1).max(HOOK_FIELDS.length),
    /**
     * `true` when the change lets through what the hook used to stop: it was switched off,
     * or set to let through on failure. Absent otherwise.
     */
    weakened: z.boolean().optional(),
  }),
  'hook.deleted': data('HookDeleted', 'A hook was removed; it is not asked any more.', {
    point: z.enum(HOOK_POINTS),
    /** `true` when the hook was on when it was removed; absent otherwise. */
    weakened: z.boolean().optional(),
  }),
} as const satisfies Record<ActivityType, z.ZodObject>

/**
 * The `data` of an event of type `T`; without `T`, of any event.
 *
 * @example
 * ```ts
 * const data: EventData<'session.created'> = { userId: 'u_1', client: 'ios' }
 * ```
 */
export type EventData<T extends ActivityType = ActivityType> = z.infer<
  (typeof EVENT_DATA_SCHEMAS)[T]
>

/**
 * Who did it. `id` is a user's id, an API key's (`admin`), a dashboard session's
 * (`instance_admin`), or `null`: the server itself, or the instance admin token.
 */
export const EventActorSchema = z
  .object({ type: z.enum(AUDIT_ACTOR_TYPES), id: z.string().min(1).max(128).nullable() })
  .meta({ ref: 'EventActor' })

/**
 * An event of type `T`, as a webhook delivers it.
 *
 * - `id`: the event's id, the same as its audit log entry's. A delivery that is repeated
 *   carries the same id: use it to drop duplicates.
 * - `schemaVersion`: {@link EVENT_SCHEMA_VERSION}.
 * - `occurredAt`: ISO 8601, UTC.
 * - `actor`, `target`: who did it and what it was done to, by id.
 * - `data`: the details, per type.
 * - `test`: `true` on a test event (one an administrator asked the server to send, built from
 *   an example: nothing it describes happened), and absent on every real event. Signed with
 *   the rest of the body. Check it before acting on an event.
 *
 * There is no IP address and no user agent: those stay in the audit log.
 */
export interface EventOf<T extends ActivityType> {
  id: string
  type: T
  schemaVersion: typeof EVENT_SCHEMA_VERSION
  occurredAt: string
  actor: { type: AuditActorType; id: string | null }
  target: { type: EventTargetType<T>; id: string }
  data: EventData<T>
  test?: true
}

/**
 * Any event: a union discriminated by `type`.
 *
 * @example
 * ```ts
 * function handle(event: TulaEvent) {
 *   if (event.type === 'session.reuse_detected') {
 *     alertSecurity(event.data.userId)
 *   }
 * }
 * ```
 */
export type TulaEvent = { [T in ActivityType]: EventOf<T> }[ActivityType]

function envelope<T extends ActivityType>(type: T) {
  const details = EVENT_DATA_SCHEMAS[type]
  const { ref, description } = z.globalRegistry.get(details) ?? {}
  return z
    .object({
      id: id(),
      type: z.literal(type),
      schemaVersion: z.literal(EVENT_SCHEMA_VERSION),
      occurredAt: z.iso.datetime(),
      actor: EventActorSchema,
      target: z.object({ type: z.literal(EVENT_TARGET_TYPES[type]), id: id() }),
      data: details,
      // Only ever `true`, and only on a test event: a real event has no such key.
      test: z.literal(true).optional(),
    })
    .meta({ ref: String(ref).replace(/Data$/, ''), description })
}

const envelopes = ACTIVITY_TYPES.map((type) => [type, envelope(type)] as const)

/**
 * The schema of each event type: the envelope around its {@link EVENT_DATA_SCHEMAS} entry.
 *
 * Parsing strips every key a schema does not name, at each level.
 *
 * @example
 * ```ts
 * const event = EVENT_SCHEMAS['user.created'].parse(JSON.parse(body))
 * ```
 */
export const EVENT_SCHEMAS = Object.fromEntries(envelopes) as unknown as {
  readonly [T in ActivityType]: z.ZodType<EventOf<T>>
}

/**
 * Any event, told apart by `type`: what a webhook receiver parses a delivery with.
 *
 * @example
 * ```ts
 * const event = TulaEventSchema.parse(JSON.parse(body))
 * ```
 */
export const TulaEventSchema = z
  .discriminatedUnion(
    'type',
    // Never empty: there is an envelope per activity type. The casts say what the mapped
    // list cannot: its members are the object schemas of `EVENT_SCHEMAS`, one per type.
    envelopes.map(([, schema]) => schema) as unknown as [z.ZodObject, ...z.ZodObject[]]
  )
  .meta({ ref: 'TulaEvent' }) as unknown as z.ZodType<TulaEvent>
