import { z } from 'zod'
import {
  type CustomClaimValue,
  customClaimsBytes,
  isCustomClaimKey,
  MAX_CUSTOM_CLAIM_CONSTANT_LENGTH,
  MAX_CUSTOM_CLAIM_KEY_LENGTH,
  MAX_CUSTOM_CLAIMS_BYTES,
  MAX_JWT_TEMPLATE_CLAIMS,
} from './custom-claims'
import { SessionClientSchema } from './session'
import type { SessionProfile, SessionSettings } from './session-profile'

/**
 * What a template's claim can be read from, besides a constant (ADR 0036). A closed list:
 * things the server itself knows about the user and the session, never something a request
 * said.
 *
 * - `user.email`: the user's address in its normalised form (trimmed, ASCII letters
 *   lowercased), which is the form Tula matches addresses by. A string.
 * - `user.email_verified`: whether that address has been proven. A boolean. A user with no
 *   address has no value for it, as for `user.email`: the key is left out, never `false`.
 * - `user.created_at`: when the account was created, in seconds since the epoch. A number.
 * - `session.client`: the kind of client the session was started from (`web`, `ios`,
 *   `android`, `server`). A string.
 * - `session.created_at`: when the session was signed in to, in seconds since the epoch.
 *   Unlike `auth_time` a step-up does not move it. A number.
 *
 * Deliberately absent: the user id (it is `sub`), names (text the user chose), anything
 * secret, and the session's IP address and user agent (what a request claimed about itself
 * when the session began: personal data, not facts the server knows, and stale by the next
 * request).
 *
 * Later servers may add sources: additive.
 */
export const JWT_TEMPLATE_SOURCES = [
  'user.email',
  'user.email_verified',
  'user.created_at',
  'session.client',
  'session.created_at',
] as const

/** One of {@link JWT_TEMPLATE_SOURCES}. */
export const JwtTemplateSourceSchema = z
  .enum(JWT_TEMPLATE_SOURCES)
  .meta({ ref: 'JwtTemplateSource' })

/** One of {@link JWT_TEMPLATE_SOURCES}. */
export type JwtTemplateSource = z.infer<typeof JwtTemplateSourceSchema>

/**
 * The longest address Tula stores, in characters. An address is printable ASCII, so in JSON a
 * character takes one byte, or two when it is escaped (`"` and `\`).
 */
const MAX_EMAIL_LENGTH = 320

/**
 * The most bytes a `user.email` claim's value can take as JSON: every character of the longest
 * address escaped, and the two quotes. A true upper bound, not an estimate: a template is
 * refused when its claims **could** exceed {@link MAX_CUSTOM_CLAIMS_BYTES}.
 */
export const MAX_EMAIL_CLAIM_BYTES = 2 * MAX_EMAIL_LENGTH + 2

/** `false`. A source with no value for a user (no address) adds no key, which is less. */
const MAX_BOOLEAN_BYTES = 5
/** The digits of the largest integer a JSON number holds exactly; a time in seconds is far shorter. */
const MAX_TIME_BYTES = String(Number.MAX_SAFE_INTEGER).length
/** The longest client kind, with its quotes. */
const MAX_CLIENT_BYTES = Math.max(...SessionClientSchema.options.map((kind) => kind.length)) + 2

const SOURCE_MAX_BYTES: Record<JwtTemplateSource, number> = {
  'user.email': MAX_EMAIL_CLAIM_BYTES,
  'user.email_verified': MAX_BOOLEAN_BYTES,
  'user.created_at': MAX_TIME_BYTES,
  'session.client': MAX_CLIENT_BYTES,
  'session.created_at': MAX_TIME_BYTES,
}

// Control characters and line or paragraph separators: a constant is a value, not a layout.
const UNPRINTABLE = /[\p{Cc}\p{Zl}\p{Zp}]/u

const Constant = z.union([
  z
    .string()
    .max(MAX_CUSTOM_CLAIM_CONSTANT_LENGTH)
    .refine((value) => !UNPRINTABLE.test(value), {
      message: 'must not contain control characters or line breaks',
    }),
  z.number(),
  z.boolean(),
])

/**
 * Where one custom claim's value comes from: **exactly one** source.
 *
 * - `{ from: … }`: one of {@link JWT_TEMPLATE_SOURCES}, read from the user and the session
 *   each time a token is issued.
 * - `{ value: … }`: a constant: a string of at most
 *   {@link MAX_CUSTOM_CLAIM_CONSTANT_LENGTH} characters, a number or a boolean. Every session
 *   of the profile gets it. It says what the operator typed, not something Tula checked.
 *
 * There is no expression language, no concatenation and no nesting: a value is one source.
 */
export const JwtTemplateClaimSchema = z
  .union([z.strictObject({ from: JwtTemplateSourceSchema }), z.strictObject({ value: Constant })])
  .meta({ ref: 'JwtTemplateClaim' })

/** Where one custom claim's value comes from. */
export type JwtTemplateClaim = z.infer<typeof JwtTemplateClaimSchema>

const CLAIM_KEY_RULE = `a claim key is ASCII letters, digits and underscores, not starting with a digit, at most ${MAX_CUSTOM_CLAIM_KEY_LENGTH} characters, and not a reserved claim name`

/** The bytes of `"key":` in JSON. */
function keyBytes(key: string): number {
  // `{"key":0}` without its braces and the `0`.
  return customClaimsBytes({ [key]: 0 }) - 3
}

function valueMaxBytes(claim: JwtTemplateClaim): number {
  if ('from' in claim) {
    return SOURCE_MAX_BYTES[claim.from]
  }
  const constant: CustomClaimValue = claim.value
  return customClaimsBytes({ k: constant }) - '{"k":}'.length
}

/**
 * The most bytes the namespace claim can take for a template, as JSON: constants as they are,
 * and every other source at its own maximum (an address at {@link MAX_EMAIL_CLAIM_BYTES}).
 *
 * It is an upper bound over every user and session, which is what lets a template be refused
 * when it is saved instead of a token going out without its claims later.
 *
 * @param template - The template.
 * @returns The byte count; `2` for a template with no claim.
 *
 * @example
 * ```ts
 * jwtTemplateMaxBytes({ claims: { role: { value: 'admin' } } }) // 16
 * ```
 */
export function jwtTemplateMaxBytes(template: {
  claims: Readonly<Record<string, JwtTemplateClaim>>
}): number {
  const claims = Object.entries(template.claims)
  const separators = Math.max(0, claims.length - 1)
  return claims.reduce(
    (bytes, [key, claim]) => bytes + keyBytes(key) + valueMaxBytes(claim),
    2 + separators
  )
}

const fields = {
  /**
   * The claims, by key. A key is ASCII letters, digits and underscores, not starting with a
   * digit, at most {@link MAX_CUSTOM_CLAIM_KEY_LENGTH} characters, and never a reserved claim
   * name (`sub`, `exp`, `amr`, …: see `RESERVED_CLAIM_NAMES`). At most
   * {@link MAX_JWT_TEMPLATE_CLAIMS}.
   */
  claims: z
    .record(
      z.string().refine(isCustomClaimKey, { message: CLAIM_KEY_RULE }),
      JwtTemplateClaimSchema
    )
    .default({}),
}

function fewEnough(template: { claims: object }): boolean {
  return Object.keys(template.claims).length <= MAX_JWT_TEMPLATE_CLAIMS
}

function smallEnough(template: { claims: Record<string, JwtTemplateClaim> }): boolean {
  return jwtTemplateMaxBytes(template) <= MAX_CUSTOM_CLAIMS_BYTES
}

/**
 * A JWT template: a named set of custom claims an environment adds to the sessions of the
 * profiles that use it (ADR 0036).
 *
 * The claims are issued under the one namespace claim `ext`, in a `hybrid` session's access
 * token and in what the server answers for a `stateful` session. They are read again from the
 * user and the session every time a token is issued. A source that has no value for a user
 * leaves its key out; a template with no claim adds nothing at all.
 *
 * Refused: an unknown key, more than {@link MAX_JWT_TEMPLATE_CLAIMS} claims, and a template
 * whose claims **could** take more than `MAX_CUSTOM_CLAIMS_BYTES` as JSON
 * ({@link jwtTemplateMaxBytes}).
 */
export const JwtTemplateSchema = z
  .strictObject(fields)
  .refine(fewEnough, {
    message: `at most ${MAX_JWT_TEMPLATE_CLAIMS} claims`,
    path: ['claims'],
  })
  .refine(smallEnough, {
    message: `the claims could take more than ${MAX_CUSTOM_CLAIMS_BYTES} bytes`,
    path: ['claims'],
  })
  .meta({ ref: 'JwtTemplate' })

/** A JWT template. */
export type JwtTemplate = z.infer<typeof JwtTemplateSchema>

/**
 * Read one stored template, leaving out what this version does not accept.
 *
 * A stored document must never fail a read (settings are read on the request path), and a
 * newer server may have stored a source this one does not know before a rollback. Such a claim
 * is left out: to an application a missing claim is "no". A template that is over a cap even
 * so is left out whole, because cutting it down would choose which claims survive.
 *
 * @param stored - The stored value.
 * @returns The template, or `null` when it is not one.
 *
 * @example
 * ```ts
 * readStoredJwtTemplate({ claims: { a: { value: 1 }, b: { from: 'later.source' } } })
 * // { claims: { a: { value: 1 } } }
 * ```
 */
export function readStoredJwtTemplate(stored: unknown): JwtTemplate | null {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) {
    return null
  }
  const { claims: raw } = stored as { claims?: unknown }
  const claims: Record<string, JwtTemplateClaim> = {}
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    for (const key of Object.keys(raw)) {
      const claim = JwtTemplateClaimSchema.safeParse((raw as Record<string, unknown>)[key])
      if (isCustomClaimKey(key) && claim.success) {
        claims[key] = claim.data
      }
    }
  }
  const template = { claims }
  return fewEnough(template) && smallEnough(template) ? template : null
}

/** A template together with the name it is stored under. */
export interface NamedJwtTemplate {
  name: string
  template: JwtTemplate
}

/**
 * The template a profile's sessions use, as configured now.
 *
 * @param settings - The environment's `sessions` settings.
 * @param profile - The profile.
 * @returns The template and its name; `null` when the profile names none, or names one that
 *   no longer exists (possible only in a stored document: a save is refused).
 *
 * @example
 * ```ts
 * jwtTemplateOfProfile(settings.sessions, settings.sessions.profiles.web)?.name // 'app'
 * ```
 */
export function jwtTemplateOfProfile(
  settings: Pick<SessionSettings, 'jwtTemplates'>,
  profile: Pick<SessionProfile, 'jwtTemplate'>
): NamedJwtTemplate | null {
  const name = profile.jwtTemplate
  // Own keys only: `constructor` or `__proto__` must never resolve to something inherited.
  if (name === null || !Object.hasOwn(settings.jwtTemplates, name)) {
    return null
  }
  const template = settings.jwtTemplates[name]
  return template ? { name, template } : null
}
