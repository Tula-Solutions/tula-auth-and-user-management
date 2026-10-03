import { z } from 'zod'

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
 * - `otp`: a code from an authenticator app (TOTP).
 * - `backup_code`: a single-use backup code.
 * - `mfa`: two different kinds of factor were proven for this session (always beside the two).
 *
 * `pwd`, `otp` and `mfa` are RFC 8176 values; `email` and `backup_code` are Tula's own. Later
 * servers may add values (a passkey, a social provider): treat unknown ones as opaque.
 */
export const AUTHENTICATION_METHODS = ['pwd', 'email', 'otp', 'backup_code', 'mfa'] as const

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
     */
    amr: z.array(z.string()).optional(),
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

/**
 * The issuer (`iss`) of an environment's access tokens: its URL under the API.
 *
 * Standard JWKS clients fetch keys from a URL with no custom headers, so the environment is part
 * of the path, and the key set lives at {@link jwksUrl} of the issuer (OIDC-style discovery).
 *
 * @param apiUrl - The API's public base URL, e.g. `https://auth.example.com`.
 * @param environmentId - The environment id.
 * @returns The issuer URL, without a trailing slash.
 *
 * @example
 * ```ts
 * environmentIssuer('https://auth.example.com/', 'env_1')
 * // 'https://auth.example.com/v1/environments/env_1'
 * ```
 */
export function environmentIssuer(apiUrl: string, environmentId: string): string {
  return `${apiUrl.replace(/\/+$/, '')}/v1/environments/${encodeURIComponent(environmentId)}`
}

/**
 * Where an issuer publishes its public signing keys.
 *
 * @param issuer - The token's `iss` claim.
 * @returns The JWKS URL.
 *
 * @example
 * ```ts
 * jwksUrl('https://auth.example.com/v1/environments/env_1')
 * // 'https://auth.example.com/v1/environments/env_1/.well-known/jwks.json'
 * ```
 */
export function jwksUrl(issuer: string): string {
  return `${issuer.replace(/\/+$/, '')}/.well-known/jwks.json`
}

/** Access token claims. */
export type AccessTokenClaims = z.infer<typeof AccessTokenClaimsSchema>
/** Public JWK. */
export type Jwk = z.infer<typeof JwkSchema>
/** JWK set. */
export type Jwks = z.infer<typeof JwksSchema>
