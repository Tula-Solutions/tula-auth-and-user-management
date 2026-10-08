import { z } from 'zod'
import { MAX_JWT_TEMPLATES } from './custom-claims'
import { type Duration, DurationSchema, durationToMs } from './duration'
import {
  type JwtTemplate,
  JwtTemplateSchema,
  jwtTemplateOfProfile,
  readStoredJwtTemplate,
} from './jwt-template'
import type { SessionClient } from './session'

/**
 * How a session is held (business plan §5.3, ADR 0028).
 *
 * - `hybrid`: a short-lived access token (a JWT any service verifies offline) plus a rotating
 *   refresh token. The default.
 * - `stateful`: the browser holds one opaque, httpOnly session cookie that is checked against
 *   the session store on every request. No token reaches JavaScript and a revocation takes
 *   effect on the very next request. Browsers only.
 *
 * The other types of the business plan (`stateless`, `long-lived`, `kiosk`) are not offered yet.
 */
export const SessionTypeSchema = z.enum(['hybrid', 'stateful']).meta({ ref: 'SessionType' })

/** Session type. */
export type SessionType = z.infer<typeof SessionTypeSchema>

/** Shortest access-token lifetime a profile may set. */
export const MIN_ACCESS_TOKEN_TTL: Duration = '30s'
/**
 * Longest access-token lifetime a profile may set. Also how long a revoked session stays on the
 * denylist and (twice it) how long a retired signing key is kept: whatever a profile says, or
 * said when a token was signed, no access token outlives this.
 */
export const MAX_ACCESS_TOKEN_TTL: Duration = '15m'
/** Shortest idle timeout a profile may set. */
export const MIN_IDLE_TIMEOUT: Duration = '1m'
/** Longest idle or absolute timeout a profile may set. */
export const MAX_SESSION_TIMEOUT: Duration = '365d'
/**
 * Shortest refresh grace window a profile may set, other than none (`null`).
 *
 * An SDK gives one refresh request up to 8 seconds (`REFRESH_TIMEOUT_MS` in `@tula/core`) and
 * then retries with the same token. A window shorter than that would turn a slow network into
 * `session.reuse_detected`, so nothing between "none" and this floor is accepted. `null` is the
 * deliberate choice of strict rotation: any replay ends the session, including an honest retry.
 */
export const MIN_REUSE_GRACE_PERIOD: Duration = '10s'
/** Longest refresh grace window a profile may set. */
export const MAX_REUSE_GRACE_PERIOD: Duration = '60s'
/** Shortest `stepUpAfter` a profile may set. */
export const MIN_STEP_UP_AFTER: Duration = '1m'
/** Longest `stepUpAfter` a profile may set. */
export const MAX_STEP_UP_AFTER: Duration = '24h'
/**
 * How recent a session's last proof must be on a route that requires recent authentication,
 * for a profile that sets no `stepUpAfter` (ADR 0025).
 */
export const DEFAULT_STEP_UP_AFTER: Duration = '10m'
/** Most profiles an environment may define besides the built-in `web` and `mobile`. */
export const MAX_CUSTOM_SESSION_PROFILES = 10
/** Longest profile name, in characters. */
export const MAX_SESSION_PROFILE_NAME_LENGTH = 32
/** Most sessions `sessions.maxPerUser` may allow one user. */
export const MAX_SESSIONS_PER_USER = 100

/** The profiles every environment has: `web` for browsers, `mobile` for every other client. */
export const BUILT_IN_SESSION_PROFILES = ['web', 'mobile'] as const

/** The name of a built-in profile. */
export type BuiltInSessionProfile = (typeof BUILT_IN_SESSION_PROFILES)[number]

const PROFILE_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/**
 * Whether a value is a valid name for a session profile, which is also the grammar of a JWT
 * template's name: lowercase letters, digits and single hyphens, starting with a letter, at
 * most {@link MAX_SESSION_PROFILE_NAME_LENGTH} characters.
 *
 * The one rule: {@link SessionProfileNameSchema} and the settings schema use it, and so does
 * a form that asks for a name, so that nothing accepts a name a save then refuses.
 *
 * @param name - The candidate.
 * @returns Whether it is a valid name.
 *
 * @example
 * ```ts
 * isSessionProfileName('back-office') // true
 * isSessionProfileName('back_office') // false
 * ```
 */
export function isSessionProfileName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length <= MAX_SESSION_PROFILE_NAME_LENGTH &&
    PROFILE_NAME.test(name)
  )
}

/**
 * A session profile's name: lowercase letters, digits and single hyphens, starting with a
 * letter, at most {@link MAX_SESSION_PROFILE_NAME_LENGTH} characters (`web`, `admin`,
 * `back-office`). Also the shape of the `x-tula-session-profile` header.
 */
export const SessionProfileNameSchema = z
  .string()
  .max(MAX_SESSION_PROFILE_NAME_LENGTH)
  .regex(PROFILE_NAME)
  .meta({ ref: 'SessionProfileName' })

// A malformed duration is reported by `DurationSchema` itself; here it is simply "not within".
function ms(value: string): number {
  return DurationSchema.safeParse(value).success ? durationToMs(value) : Number.NaN
}

function within(value: Duration, min: Duration, max: Duration): boolean {
  return ms(value) >= durationToMs(min) && ms(value) <= durationToMs(max)
}

function bounded(min: Duration, max: Duration) {
  return DurationSchema.refine((value) => within(value, min, max), {
    message: `must be between ${min} and ${max}`,
  })
}

const profileFields = {
  /** How the session is held. See {@link SessionTypeSchema}. */
  type: SessionTypeSchema.default('hybrid'),
  /**
   * `hybrid`: how long an access token is valid ({@link MIN_ACCESS_TOKEN_TTL} to
   * {@link MAX_ACCESS_TOKEN_TTL}). `stateful`: how often a session's activity is written down;
   * the idle timeout is measured to this precision. Never longer than `idleTimeout`.
   */
  accessTokenTtl: bounded(MIN_ACCESS_TOKEN_TTL, MAX_ACCESS_TOKEN_TTL).default('60s'),
  /**
   * The session ends after this long without activity ({@link MIN_IDLE_TIMEOUT} to
   * {@link MAX_SESSION_TIMEOUT}). Activity is a refresh (`hybrid`) or a request (`stateful`).
   */
  idleTimeout: bounded(MIN_IDLE_TIMEOUT, MAX_SESSION_TIMEOUT).default('7d'),
  /**
   * The session ends this long after sign-in whatever the activity; never shorter than
   * `idleTimeout`. `null` = no hard cap ("stay signed in").
   */
  absoluteTimeout: bounded(MIN_IDLE_TIMEOUT, MAX_SESSION_TIMEOUT).nullable().default('30d'),
  /**
   * Re-authentication ("step-up") is asked for on routes that require a recent
   * proof once the last one is older than this ({@link MIN_STEP_UP_AFTER} to
   * {@link MAX_STEP_UP_AFTER}). `null` = {@link DEFAULT_STEP_UP_AFTER}. It tunes the window of
   * routes that already require recent authentication; it never makes an ordinary route ask.
   */
  stepUpAfter: bounded(MIN_STEP_UP_AFTER, MAX_STEP_UP_AFTER).nullable().default(null),
  /**
   * Whether a client may ask for this profile by name (the `x-tula-session-profile` header).
   * Off by default: a profile is otherwise chosen by the server alone, so a client can never
   * give itself a longer-lived session than the operator offered. Ignored on the built-ins,
   * which are chosen by client kind.
   */
  clientSelectable: z.boolean().default(false),
  /**
   * The JWT template whose custom claims this profile's sessions carry (a key of
   * `sessions.jwtTemplates`), or `null` (the default) for none: such a session's token is
   * exactly what it was before templates existed (ADR 0036). A name with no template is
   * refused when the settings are saved.
   */
  jwtTemplate: SessionProfileNameSchema.nullable().default(null),
}

const refreshFields = {
  /**
   * `hybrid` only. Concurrent-refresh grace window. If a refresh token that was rotated less
   * than this long ago is presented again, the server returns the **same child refresh token**
   * it already issued (derived from the parent, never stored) plus a freshly signed access
   * token: an idempotent retry for racing tabs/requests instead of treating it as theft. Any
   * reuse after the window, or reuse of a token whose child was itself rotated, revokes the
   * whole family. This is the only exception to reuse detection.
   *
   * {@link MIN_REUSE_GRACE_PERIOD} to {@link MAX_REUSE_GRACE_PERIOD}, or `null` for no window
   * at all (strict rotation).
   */
  reuseGracePeriod: bounded(MIN_REUSE_GRACE_PERIOD, MAX_REUSE_GRACE_PERIOD)
    .nullable()
    .default('10s'),
}

const idleWithinAbsolute = {
  message: 'must not be shorter than idleTimeout',
  path: ['absoluteTimeout'],
}

function idleFits(profile: { idleTimeout: Duration; absoluteTimeout: Duration | null }): boolean {
  return (
    profile.absoluteTimeout === null ||
    // Not "idle <= absolute": a malformed value (NaN) is reported once, by its own field.
    !(ms(profile.idleTimeout) > ms(profile.absoluteTimeout))
  )
}

const accessWithinIdle = {
  message: 'must not be longer than idleTimeout',
  path: ['accessTokenTtl'],
}

/**
 * Whether activity is noticed at least once per idle timeout.
 *
 * A `stateful` session's activity is written down once per `accessTokenTtl`, and a `hybrid`
 * session is only active when it refreshes, which a client does once per `accessTokenTtl`. A
 * profile whose `accessTokenTtl` is longer than its `idleTimeout` would therefore time an
 * active user out (`stateful`), or leave an access token valid after its session went idle
 * (`hybrid`).
 */
function accessFits(profile: { accessTokenTtl: Duration; idleTimeout: Duration }): boolean {
  // As in `idleFits`: a malformed value (NaN) is reported once, by its own field.
  return !(ms(profile.accessTokenTtl) > ms(profile.idleTimeout))
}

/**
 * A named session profile: how a session is held and how long it lives.
 *
 * Every field has a default, and the defaults are what every session got before profiles
 * existed: `hybrid`, 60-second access tokens, 7 days idle, 30 days absolute, a 10-second
 * refresh grace window. Unknown keys are refused, and so is an `accessTokenTtl` longer than
 * the `idleTimeout` or an `idleTimeout` longer than the `absoluteTimeout`.
 *
 * The limits are read **as currently configured** whenever a session is used: tightening a
 * profile's timeouts ends an over-age session at its next refresh (or request, for `stateful`).
 * Loosening never extends a session past the absolute limit it was created with.
 */
export const SessionProfileSchema = z
  .strictObject({ ...profileFields, refresh: z.strictObject(refreshFields).prefault({}) })
  .refine(idleFits, idleWithinAbsolute)
  .refine(accessFits, accessWithinIdle)
  .meta({ ref: 'SessionProfile' })

/** Session profile. */
export type SessionProfile = z.infer<typeof SessionProfileSchema>

// The same profile, but unknown keys are dropped instead of refused: for stored documents.
//
// `accessFits` is deliberately not applied here. Documents were stored before that rule
// existed, and a stored document this schema refuses cannot be read at all: one odd profile
// would fail every request of its environment. Such a profile is read as stored, and the
// session service does not depend on the rule (`Sessions.authenticate` writes activity
// whenever less idle time is left than its write interval).
const StoredProfile = z
  .object({ ...profileFields, refresh: z.object(refreshFields).prefault({}) })
  .refine(idleFits, idleWithinAbsolute)

/** The built-in `web` profile until an environment changes it (§5.3). */
export const DEFAULT_WEB_SESSION_PROFILE: SessionProfile = SessionProfileSchema.parse({})

/**
 * The built-in `mobile` profile until an environment changes it. The same values as `web`:
 * before profiles existed every client got that one profile, and an environment that saved
 * nothing must behave exactly as it did.
 */
export const DEFAULT_MOBILE_SESSION_PROFILE: SessionProfile = SessionProfileSchema.parse({})

/** What happens to a sign-in that would take a user past `sessions.maxPerUser`. */
export const SessionLimitActionSchema = z
  .enum(['end_oldest', 'refuse_newest'])
  .meta({ ref: 'SessionLimitAction' })

/** What happens to a sign-in that would take a user past `sessions.maxPerUser`. */
export type SessionLimitAction = z.infer<typeof SessionLimitActionSchema>

function isBuiltIn(name: string): name is BuiltInSessionProfile {
  return (BUILT_IN_SESSION_PROFILES as readonly string[]).includes(name)
}

function customNames(profiles: object): string[] {
  return Object.keys(profiles).filter((name) => !isBuiltIn(name))
}

type ProfileSchema = typeof SessionProfileSchema | typeof StoredProfile

function profilesOf(profile: ProfileSchema) {
  return z
    .object({ web: profile.prefault({}), mobile: profile.prefault({}) })
    .catchall(profile)
    .refine((profiles) => customNames(profiles).every(isSessionProfileName), {
      message: `a profile name is lowercase letters, digits and single hyphens, starting with a letter, at most ${MAX_SESSION_PROFILE_NAME_LENGTH} characters`,
    })
    .refine((profiles) => customNames(profiles).length <= MAX_CUSTOM_SESSION_PROFILES, {
      message: `at most ${MAX_CUSTOM_SESSION_PROFILES} profiles besides web and mobile`,
    })
    .refine((profiles) => profiles.mobile.type === 'hybrid', {
      message: 'the mobile profile must be hybrid: a stateful session is a browser cookie',
      path: ['mobile', 'type'],
    })
}

const TEMPLATE_NAME_RULE = `a template name is lowercase letters, digits and single hyphens, starting with a letter, at most ${MAX_SESSION_PROFILE_NAME_LENGTH} characters`

/**
 * The environment's JWT templates by name (the grammar of a profile name), at most
 * {@link MAX_JWT_TEMPLATES}. See `JwtTemplate`.
 */
const JwtTemplates = z
  .record(
    z.string().refine(isSessionProfileName, { message: TEMPLATE_NAME_RULE }),
    JwtTemplateSchema
  )
  .refine((templates) => Object.keys(templates).length <= MAX_JWT_TEMPLATES, {
    message: `at most ${MAX_JWT_TEMPLATES} templates`,
  })
  .default({})

// For stored documents: whatever this version would not accept is left out, never a failed
// read (see `readStoredJwtTemplate`). Leaving a template out only ever removes claims.
const StoredJwtTemplates = z
  .unknown()
  .optional()
  .transform((stored): Record<string, JwtTemplate> => {
    const templates: Record<string, JwtTemplate> = {}
    if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) {
      return templates
    }
    for (const name of Object.keys(stored)) {
      const template = readStoredJwtTemplate((stored as Record<string, unknown>)[name])
      if (
        template &&
        isSessionProfileName(name) &&
        Object.keys(templates).length < MAX_JWT_TEMPLATES
      ) {
        templates[name] = template
      }
    }
    return templates
  })

/**
 * Report every profile that names a template the document does not have: on the profile, so
 * the message lands on the field that has to change.
 */
function templatesExist(
  settings: { profiles: Record<string, unknown>; jwtTemplates: Record<string, JwtTemplate> },
  context: z.RefinementCtx
): void {
  for (const [name, profile] of Object.entries(settings.profiles)) {
    const { jwtTemplate } = profile as { jwtTemplate: string | null }
    if (jwtTemplate !== null && !jwtTemplateOfProfile(settings, { jwtTemplate })) {
      context.addIssue({
        code: 'custom',
        message: 'names a JWT template that does not exist',
        path: ['profiles', name, 'jwtTemplate'],
      })
    }
  }
}

const limitFields = {
  /**
   * The most live sessions one user may have; `null` (the default) = no limit. Only sessions
   * that can still be used count: not expired, timed-out or revoked ones.
   */
  maxPerUser: z.number().int().min(1).max(MAX_SESSIONS_PER_USER).nullable().default(null),
  /**
   * What a sign-in at the limit does. `end_oldest` (the default): the user's oldest sessions
   * are signed out to make room. `refuse_newest`: the sign-in is refused with
   * `session.limit_reached` and no session is created; the user frees a place by signing out
   * elsewhere, or everywhere by resetting their password.
   */
  onLimit: SessionLimitActionSchema.default('end_oldest'),
}

/**
 * The `sessions` section of an environment's settings, as `PUT /v1/admin/settings` accepts it.
 *
 * - `profiles`: named session profiles. `web` and `mobile` are always present (left out, they
 *   take the defaults); up to {@link MAX_CUSTOM_SESSION_PROFILES} more may be added under
 *   kebab-case names.
 * - `maxPerUser` and `onLimit`: the concurrent-session rule.
 * - `jwtTemplates`: named sets of custom claims (ADR 0036), at most
 *   {@link MAX_JWT_TEMPLATES}; a profile uses one by naming it in its `jwtTemplate`. A profile
 *   that names a template the document does not have is refused, so a template in use cannot
 *   be removed without first unsetting it on every profile that names it.
 */
export const SessionSettingsSchema = z
  .strictObject({
    profiles: profilesOf(SessionProfileSchema).prefault({}),
    ...limitFields,
    jwtTemplates: JwtTemplates,
  })
  .superRefine(templatesExist)
  .meta({ ref: 'SessionSettings' })

/**
 * The `sessions` section of a stored settings document: unknown keys are dropped, and so is a
 * template (or a claim of one) this version would not accept. A profile that names a template
 * that is not there is read as stored and gets no custom claims (`jwtTemplateOfProfile`).
 */
export const StoredSessionSettingsSchema = z.object({
  profiles: profilesOf(StoredProfile).prefault({}),
  ...limitFields,
  jwtTemplates: StoredJwtTemplates,
})

/** The `sessions` section of an environment's settings. */
export type SessionSettings = z.infer<typeof SessionSettingsSchema>

/** A profile together with the name it is stored under. */
export interface NamedSessionProfile {
  name: string
  profile: SessionProfile
}

/**
 * The built-in profile of a client kind: `web` for a browser, `mobile` for everything else
 * (`ios`, `android`, `server`).
 *
 * @param client - The client kind (`x-tula-client`).
 * @returns `web` or `mobile`.
 *
 * @example
 * ```ts
 * builtInSessionProfile('ios') // 'mobile'
 * ```
 */
export function builtInSessionProfile(client: SessionClient): BuiltInSessionProfile {
  return client === 'web' ? 'web' : 'mobile'
}

function named(settings: SessionSettings, name: string): NamedSessionProfile | null {
  // Own keys only: `constructor` or `__proto__` must never resolve to something inherited.
  const profile = Object.hasOwn(settings.profiles, name) ? settings.profiles[name] : undefined
  return profile ? { name, profile } : null
}

function builtIn(settings: SessionSettings, client: SessionClient): NamedSessionProfile {
  const name = builtInSessionProfile(client)
  return { name, profile: settings.profiles[name] }
}

/**
 * Choose the profile of a session that is about to be created.
 *
 * The client kind decides (`web` → `web`, anything else → `mobile`), unless the client names a
 * profile **and** the environment marks that profile `clientSelectable`. Anything else it
 * names (an unknown profile, one that is not selectable, the other kind's built-in) is not an
 * error: the session gets its kind's built-in, so a client can neither pick a profile the
 * operator did not offer nor learn which names exist. A `stateful` profile is a browser
 * cookie, so a client that is not `web` gets `mobile` instead.
 *
 * @param settings - The environment's `sessions` settings.
 * @param request - The client kind and the profile it asked for, if any.
 * @returns The profile and its name.
 *
 * @example
 * ```ts
 * resolveSessionProfile(settings.sessions, { client: 'web', requested: 'admin' }).name
 * // 'admin' when profiles.admin.clientSelectable, otherwise 'web'
 * ```
 */
export function resolveSessionProfile(
  settings: SessionSettings,
  request: { client: SessionClient; requested?: string | null }
): NamedSessionProfile {
  const fallback = builtIn(settings, request.client)
  if (!request.requested || isBuiltIn(request.requested)) {
    return fallback
  }
  const asked = named(settings, request.requested)
  if (!asked?.profile.clientSelectable) {
    return fallback
  }
  return asked.profile.type === 'stateful' && request.client !== 'web' ? fallback : asked
}

/**
 * The profile whose limits apply to an existing session, as configured now.
 *
 * A session whose profile was deleted falls back to the built-in for its client kind. So does
 * a session that names a built-in of the other kind: before profiles existed every session was
 * stored as `web`, whatever its client.
 *
 * @param settings - The environment's `sessions` settings.
 * @param session - The session's stored profile name and client kind.
 * @returns The profile and its name.
 *
 * @example
 * ```ts
 * profileOfSession(settings.sessions, { profile: 'deleted-one', client: 'web' }).name // 'web'
 * ```
 */
export function profileOfSession(
  settings: SessionSettings,
  session: { profile: string; client: SessionClient }
): NamedSessionProfile {
  if (isBuiltIn(session.profile)) {
    return builtIn(settings, session.client)
  }
  return named(settings, session.profile) ?? builtIn(settings, session.client)
}

/**
 * How recent a session's last proof must be on a route that requires recent authentication:
 * its profile's `stepUpAfter`, or {@link DEFAULT_STEP_UP_AFTER} when the profile sets none, is
 * not named or no longer exists.
 *
 * @param settings - The environment's `sessions` settings.
 * @param profileName - The session's profile (the access token's `sp` claim), if known.
 * @returns The window in seconds.
 *
 * @example
 * ```ts
 * stepUpWindowSeconds(settings.sessions, claims.sp) // 600 unless the profile says otherwise
 * ```
 */
export function stepUpWindowSeconds(
  settings: SessionSettings,
  profileName: string | undefined
): number {
  const profile = profileName === undefined ? null : named(settings, profileName)?.profile
  return durationToMs(profile?.stepUpAfter ?? DEFAULT_STEP_UP_AFTER) / 1000
}
