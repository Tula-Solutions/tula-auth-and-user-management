// The custom claims of a session: where they sit in the claims, what a key may be, how large
// they may get, and how a verifier reads them. This module imports nothing (no Zod), so an SDK
// that verifies tokens (`@tula/nextjs`) can use it without a schema library in its bundle:
// `@tula/contract/custom-claims`.

/**
 * The one top-level claim every custom claim is nested under (ADR 0036).
 *
 * An operator's claims never sit beside Tula's own, so a claim Tula adds later cannot collide
 * with a customer's, and a template cannot set a claim Tula's servers or SDKs act on. `ext`
 * ("extension") is three bytes in every token, and is not a registered claim name (IANA's
 * "JSON Web Token Claims" registry, read in October 2026) nor one OpenID Connect defines.
 *
 * @example
 * ```ts
 * const role = payload[CUSTOM_CLAIMS_CLAIM]?.role // payload.ext.role
 * ```
 */
export const CUSTOM_CLAIMS_CLAIM = 'ext'

/**
 * Claim names a custom claim's key may never be: every claim Tula's tokens carry, the
 * registered claims a verifier acts on, `cnf` (reserved for device binding) and the namespace
 * claim itself.
 *
 * A custom claim lives inside {@link CUSTOM_CLAIMS_CLAIM}, so it could not overwrite one of
 * these anyway. They are refused so that nobody reads `claims.ext.sub` as the subject.
 *
 * @example
 * ```ts
 * RESERVED_CLAIM_NAMES.includes('sub') // true
 * ```
 */
export const RESERVED_CLAIM_NAMES = [
  'iss',
  'sub',
  'aud',
  'exp',
  'nbf',
  'iat',
  'jti',
  'sid',
  'pid',
  'eid',
  'v',
  'auth_time',
  'amr',
  'sp',
  'cnf',
  CUSTOM_CLAIMS_CLAIM,
] as const

/**
 * The most bytes the namespace claim's value may take as JSON (UTF-8), whatever puts claims
 * in it.
 *
 * An access token is sent with every request and `@tula/nextjs` keeps it in a cookie, where a
 * browser allows about 4,096 bytes for the name and the value together. A token without
 * custom claims is about 700 bytes; this cap adds at most 1,366 (base64url), which leaves
 * room for a long issuer URL.
 */
export const MAX_CUSTOM_CLAIMS_BYTES = 1024

/** Most JWT templates an environment may define. */
export const MAX_JWT_TEMPLATES = 10

/** Most claims one JWT template may define. */
export const MAX_JWT_TEMPLATE_CLAIMS = 16

/** Longest custom claim key, in characters. */
export const MAX_CUSTOM_CLAIM_KEY_LENGTH = 32

/** Longest string a template may set as a constant, in characters. */
export const MAX_CUSTOM_CLAIM_CONSTANT_LENGTH = 256

/** What a custom claim's value can be: one string, number or boolean. Never a list or an object. */
export type CustomClaimValue = string | number | boolean

/**
 * The custom claims of a verified session, as an SDK hands them to an application: a frozen
 * map from claim key to value.
 *
 * The values are typed `unknown` because only the operator knows what their template puts
 * under each key: narrow before use. At run time each is a string, a number or a boolean.
 *
 * @example
 * ```ts
 * const { customClaims } = await auth()
 * const isAdmin = customClaims.role === 'admin' // a missing claim is `undefined`: "no"
 * ```
 */
export type CustomClaims = Readonly<Record<string, unknown>>

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

// Keys that are not claims but ways to reach an object's prototype.
const UNSAFE_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype']

/**
 * Whether a string can be the key of a custom claim: ASCII letters, digits and underscores,
 * not starting with a digit, at most {@link MAX_CUSTOM_CLAIM_KEY_LENGTH} characters, and none
 * of {@link RESERVED_CLAIM_NAMES}, `__proto__`, `constructor` or `prototype`.
 *
 * @param key - The candidate.
 * @returns `true` when it can be a key.
 *
 * @example
 * ```ts
 * isCustomClaimKey('role') // true
 * isCustomClaimKey('sub') // false: reserved
 * isCustomClaimKey('my-claim') // false: a hyphen
 * ```
 */
export function isCustomClaimKey(key: unknown): key is string {
  return (
    typeof key === 'string' &&
    key.length <= MAX_CUSTOM_CLAIM_KEY_LENGTH &&
    KEY.test(key) &&
    !UNSAFE_KEYS.includes(key) &&
    !(RESERVED_CLAIM_NAMES as readonly string[]).includes(key)
  )
}

/**
 * Whether a value can be a custom claim's: a string, a boolean, or a number JSON can hold.
 *
 * @param value - The candidate.
 * @returns `true` for a string, a boolean and a finite number.
 *
 * @example
 * ```ts
 * isCustomClaimValue('admin') // true
 * isCustomClaimValue(['admin']) // false
 * ```
 */
export function isCustomClaimValue(value: unknown): value is CustomClaimValue {
  return (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
}

/** The UTF-8 length of a string, counted without an encoder (the contract runs anywhere). */
function utf8Length(text: string): number {
  let bytes = 0
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index)
    if (unit < 0x80) {
      bytes += 1
    } else if (unit < 0x800) {
      bytes += 2
    } else if (unit >= 0xd800 && unit <= 0xdbff && isLowSurrogate(text.charCodeAt(index + 1))) {
      // A pair is one four-byte character.
      bytes += 4
      index += 1
    } else {
      bytes += 3
    }
  }
  return bytes
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff
}

/**
 * How many bytes custom claims take in a token: the UTF-8 length of their JSON, which is what
 * {@link MAX_CUSTOM_CLAIMS_BYTES} caps.
 *
 * @param claims - The value of the namespace claim.
 * @returns The byte count.
 *
 * @example
 * ```ts
 * customClaimsBytes({ role: 'admin' }) // 16: {"role":"admin"}
 * ```
 */
export function customClaimsBytes(claims: Readonly<Record<string, CustomClaimValue>>): number {
  return utf8Length(JSON.stringify(claims))
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * What {@link checkCustomClaims} found: the claims, or why they are not claims.
 *
 * - `invalid`: not a plain object, a key that fails {@link isCustomClaimKey} (a reserved
 *   name and `__proto__` among them), or a value that is not one string, number or boolean.
 * - `too_large`: every claim is fine and together they are over
 *   {@link MAX_CUSTOM_CLAIMS_BYTES}.
 */
export type CustomClaimsCheck =
  | { claims: Record<string, CustomClaimValue> }
  | { problem: 'invalid' | 'too_large' }

/**
 * Judge claims that did not come from the environment's settings (a hook's answer), **whole**:
 * either every one of them can be issued under the namespace claim, or none is.
 *
 * Nothing is repaired and nothing is left out: one bad key makes the whole value `invalid`.
 * Give it the value as it was parsed (`JSON.parse`), not one a schema library has rebuilt:
 * the keys are read as the object's **own** keys, so a `__proto__` key a parser kept is seen
 * and refused, where a library that copies objects would have dropped it silently. An empty
 * object is fine and means no claims.
 *
 * @param value - The candidate claims.
 * @returns A copy of the claims (own keys only, no prototype reachable), or the problem.
 *
 * @example
 * ```ts
 * checkCustomClaims({ role: 'admin' }) // { claims: { role: 'admin' } }
 * checkCustomClaims({ sub: 'someone-else' }) // { problem: 'invalid' }
 * ```
 */
export function checkCustomClaims(value: unknown): CustomClaimsCheck {
  if (!isPlainObject(value)) {
    return { problem: 'invalid' }
  }
  const entries: [string, CustomClaimValue][] = []
  for (const key of Object.keys(value)) {
    const claim = value[key]
    if (!isCustomClaimKey(key) || !isCustomClaimValue(claim)) {
      return { problem: 'invalid' }
    }
    entries.push([key, claim])
  }
  // `fromEntries` defines own properties: no key can reach a prototype.
  const claims: Record<string, CustomClaimValue> = Object.fromEntries(entries)
  return customClaimsBytes(claims) > MAX_CUSTOM_CLAIMS_BYTES ? { problem: 'too_large' } : { claims }
}

/**
 * Read the custom claims out of a session's claims, for an SDK to hand to an application.
 *
 * Call it only with claims that were **verified** (a token's signature and issuer, or the
 * API's own answer): this checks a shape, not where the claims came from.
 *
 * The namespace claim is returned only when it is exactly what a Tula server issues: a plain
 * object, not empty, at most {@link MAX_CUSTOM_CLAIMS_BYTES} as JSON, whose every key passes
 * {@link isCustomClaimKey} and whose every value is a string, a boolean or a finite number.
 * Anything else is **absent as a whole**, never passed through and never repaired: an
 * application must not be handed an object of a shape it did not expect under a name it
 * trusts. Treat an absent claim as "no".
 *
 * @param claims - A session's verified claims.
 * @returns A frozen copy of the custom claims, or `null` when there are none.
 *
 * @example
 * ```ts
 * readCustomClaims({ sub: 'u1', ext: { role: 'admin' } }) // { role: 'admin' }
 * readCustomClaims({ sub: 'u1', ext: ['admin'] }) // null
 * ```
 */
export function readCustomClaims(claims: unknown): CustomClaims | null {
  if (!isPlainObject(claims) || !Object.hasOwn(claims, CUSTOM_CLAIMS_CLAIM)) {
    return null
  }
  const raw = claims[CUSTOM_CLAIMS_CLAIM]
  if (!isPlainObject(raw)) {
    return null
  }
  const entries: [string, CustomClaimValue][] = []
  for (const key of Object.keys(raw)) {
    const value = raw[key]
    if (!isCustomClaimKey(key) || !isCustomClaimValue(value)) {
      return null
    }
    entries.push([key, value])
  }
  if (entries.length === 0) {
    return null
  }
  const read = Object.fromEntries(entries)
  return customClaimsBytes(read) <= MAX_CUSTOM_CLAIMS_BYTES ? Object.freeze(read) : null
}
