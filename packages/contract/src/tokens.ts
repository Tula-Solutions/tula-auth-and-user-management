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
 * Claims inside every Tula access token.
 *
 * Any language can verify these with the environment's JWKS: check `alg === 'EdDSA'`, the `kid`,
 * `iss`, `aud` and `exp`.
 */
export const AccessTokenClaimsSchema = z
  .object({
    /** Issuer: the environment's public API URL. */
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

/** Access token claims. */
export type AccessTokenClaims = z.infer<typeof AccessTokenClaimsSchema>
/** Public JWK. */
export type Jwk = z.infer<typeof JwkSchema>
/** JWK set. */
export type Jwks = z.infer<typeof JwksSchema>
