import { z } from 'zod'
import { CUSTOM_CLAIMS_CLAIM } from './custom-claims'

/** Version of the access-token claim layout. Bump only with a migration plan for SDKs. */
export const ACCESS_TOKEN_VERSION = 1

/** Only signing algorithm Tula issues or accepts. */
export const ACCESS_TOKEN_ALGORITHM = 'EdDSA'

/** Prefix of publishable keys (safe to embed in apps), followed by `<env>_`. */
export const PUBLISHABLE_KEY_PREFIX = 'tula_pk_'

/** Prefix of secret keys (server-side only), followed by `<env>_`. */
export const SECRET_KEY_PREFIX = 'tula_sk_'

/**
 * What `amr` (RFC 8176, "authentication methods references") can hold in a Tula access token:
 *
 * - `pwd`: the password.
 * - `email`: an emailed code or link (a sign-in's email first factor, a verified sign-up, a
 *   password reset's code).
 * - `sms`: a code texted to the account's phone number, as a sign-in's first factor
 *   (ADR 0037). It never satisfies a step-up and is never a second factor.
 * - `otp`: a code from an authenticator app (TOTP).
 * - `backup_code`: a single-use backup code.
 * - `hwk` / `swk`: a passkey, proven with user verification (ADR 0027). `hwk` for a credential
 *   bound to one device, `swk` for one its authenticator reports as eligible for backup (a
 *   synced passkey). Always beside `user`.
 * - `user`: the authenticator tested that the user was present and verified them.
 * - `mfa`: more than one kind of factor was proven for this session: a password or email and
 *   then a second factor, or a passkey, which is possession and a verified user in one step.
 *
 * `pwd`, `sms`, `otp`, `hwk`, `swk`, `user` and `mfa` are RFC 8176 values; `email` and `backup_code`
 * are Tula's own. Later servers may add values (a social provider): treat unknown ones as
 * opaque.
 */
export const AUTHENTICATION_METHODS = [
  'pwd',
  'email',
  'sms',
  'otp',
  'backup_code',
  'mfa',
  'hwk',
  'swk',
  'user',
] as const

/** One of {@link AUTHENTICATION_METHODS}. */
export type AuthenticationMethod = (typeof AUTHENTICATION_METHODS)[number]

/**
 * How long ago, at most, a session's `auth_time` may be for the API's own sensitive routes
 * (turning two-step verification on or off, new backup codes, an MFA user's password change):
 * ten minutes. Past it they answer `auth.step_up_required`.
 */
export const STEP_UP_MAX_AGE_SECONDS = 600

/**
 * Claims inside every Tula access token.
 *
 * Any language can verify these with the environment's JWKS: check `alg === 'EdDSA'`, the `kid`,
 * `iss`, `aud` and `exp`.
 */
export const AccessTokenClaimsSchema = z
  .object({
    /** Issuer: the environment's URL under the API ({@link environmentIssuer}). */
    iss: z.string(),
    /** Subject: the user id. */
    sub: z.string(),
    /** Audience: the environment id. */
    aud: z.string(),
    /** Session id. */
    sid: z.string(),
    /** Project id. */
    pid: z.string(),
    /** Environment id. */
    eid: z.string(),
    iat: z.number().int(),
    exp: z.number().int(),
    /** Claim layout version ({@link ACCESS_TOKEN_VERSION}). */
    v: z.literal(ACCESS_TOKEN_VERSION),
    /**
     * When the user last actively proved a factor for this session, in seconds since the epoch
     * (OpenID Connect's `auth_time`): the moment the sign-in completed, or the last step-up
     * (`POST /v1/client/sessions/step-up`). **Refreshing does not move it.** An absolute time,
     * not an age, because a token is static: compare it with your own clock to demand a recent
     * authentication, e.g. `now - auth_time <= 600`.
     *
     * Optional in the schema only so that a token issued by an older server still parses; every
     * token this version issues carries it. Treat a missing one as "not recent".
     */
    auth_time: z.number().int().optional(),
    /**
     * Every method proven for this session so far, at sign-in and in later step-ups
     * ({@link AUTHENTICATION_METHODS}), e.g. `["pwd"]`, `["pwd","otp","mfa"]`, `["email"]`.
     * `mfa` is present exactly when a second factor was proven. Plain strings, so a later
     * server's new method does not fail verification.
     *
     * **A set, not a sequence: the order means nothing.** Test membership
     * (`amr.includes('mfa')`), never position or equality with an array. The server happens
     * to emit the order of {@link AUTHENTICATION_METHODS}; that is not part of the contract.
     */
    amr: z.array(z.string()).optional(),
    /**
     * The name of the session's profile (`web`, `mobile` or one the environment defined), as
     * stored when the session was created (ADR 0028). The server reads it to find the
     * profile's step-up window; a resource server may use it to tell an `admin` session from
     * an ordinary one. Optional: tokens issued before profiles existed do not carry it.
     */
    sp: z.string().optional(),
    /**
     * The key a **device-bound** session is bound to (ADR 0043), in the shape of RFC 7800 and
     * RFC 9449: `jkt` is the SHA-256 thumbprint (RFC 7638) of the public key the session's
     * refreshes must be proven with. **Absent** for a session that is not bound.
     *
     * It says how the session is refreshed. It does not make this token a bound one: the API
     * asks for no proof with an access token, and a resource server that wants one checks it
     * itself.
     */
    cnf: z.object({ jkt: z.string() }).optional(),
    /**
     * The session's custom claims: what the JWT template of its profile defines (ADR 0036),
     * each key holding one string, number or boolean. **Absent** when the profile uses no
     * template or the template yields nothing for this user; never an empty object.
     *
     * Everything an operator adds lives under this one claim, so it can never be mistaken for
     * one of Tula's. A constant in it is what the operator configured, not something the
     * server checked. An application that authorizes on a custom claim must treat a missing
     * claim as "no". Read it with `readCustomClaims`, which refuses any other shape.
     */
    [CUSTOM_CLAIMS_CLAIM]: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .optional(),
  })
  .meta({ ref: 'AccessTokenClaims' })

/** An Ed25519 public key in JWK form. */
export const JwkSchema = z
  .object({
    kty: z.literal('OKP'),
    crv: z.literal('Ed25519'),
    x: z.string(),
    kid: z.string(),
    alg: z.literal(ACCESS_TOKEN_ALGORITHM),
    use: z.literal('sig'),
  })
  .meta({ ref: 'Jwk' })

/** The public key set served at `/.well-known/jwks.json`. */
export const JwksSchema = z.object({ keys: z.array(JwkSchema) }).meta({ ref: 'Jwks' })

export { environmentIssuer, jwksUrl } from './issuer'

/** Access token claims. */
export type AccessTokenClaims = z.infer<typeof AccessTokenClaimsSchema>
/** Public JWK. */
export type Jwk = z.infer<typeof JwkSchema>
/** JWK set. */
export type Jwks = z.infer<typeof JwksSchema>
