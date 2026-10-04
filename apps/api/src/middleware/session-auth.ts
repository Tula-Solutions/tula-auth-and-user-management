import {
  ACCESS_TOKEN_ALGORITHM,
  type AccessTokenClaims,
  AccessTokenClaimsSchema,
  environmentIssuer,
  type Jwk,
} from '@tula/contract'
import { createMiddleware } from 'hono/factory'
import {
  createLocalJWKSet,
  decodeProtectedHeader,
  type JWTVerifyGetKey,
  errors as joseErrors,
  jwtVerify,
} from 'jose'
import type { AppEnv, Deps, SessionVariables, Tenant, TenantVariables } from '~/dependencies'
import { AuthError, InternalError } from '~/exceptions'
import { requestOrigin } from '~/lib/actor'
import { bearerToken } from '~/middleware/api-key'
import { requestMayUseSessionCookie } from '~/middleware/cors'
import { clearSessionCookie, readSessionCookie } from '~/modules/session/cookies'
import * as Sessions from '~/modules/session/service'

// Key sets are rebuilt only when the store returns a new array, so the cached store's array is
// imported once per cache period instead of on every request.
const keySets = new WeakMap<Jwk[], JWTVerifyGetKey>()

function keySet(keys: Jwk[]): JWTVerifyGetKey {
  let set = keySets.get(keys)
  if (!set) {
    set = createLocalJWKSet({ keys })
    keySets.set(keys, set)
  }
  return set
}

/**
 * Verify an access token for a tenant, using only cached public keys (no database hit).
 *
 * Checks, in order: a `kid` is present, the algorithm is EdDSA (so `alg: none` and HMAC
 * confusion are rejected), the signature matches one of the environment's keys, `iss`, `aud`,
 * `exp`, and that the token's project and environment match the API key's.
 *
 * @param deps - Signing keys, clock and issuer.
 * @param token - The compact JWS.
 * @param tenant - The tenant resolved from the publishable key.
 * @returns The verified claims.
 * @throws AuthError `session.expired` for an expired token; `session.invalid_token` otherwise.
 */
export async function verifyAccessToken(
  deps: Pick<Deps, 'signingKeys' | 'clock' | 'config'>,
  token: string,
  tenant: Tenant
): Promise<AccessTokenClaims> {
  const now = deps.clock.now()
  let payload: unknown
  try {
    // jose would fall back to the only key when `kid` is missing; the contract requires one.
    if (typeof decodeProtectedHeader(token).kid !== 'string') {
      throw new AuthError('session.invalid_token')
    }
    const keys = await deps.signingKeys.verificationKeys(tenant.environmentId, now)
    ;({ payload } = await jwtVerify(token, keySet(keys), {
      algorithms: [ACCESS_TOKEN_ALGORITHM],
      issuer: environmentIssuer(deps.config.publicUrl, tenant.environmentId),
      audience: tenant.environmentId,
      currentDate: now,
      requiredClaims: ['exp', 'iat', 'sub', 'sid'],
    }))
  } catch (error) {
    if (error instanceof joseErrors.JWTExpired) {
      throw new AuthError('session.expired')
    }
    if (error instanceof AuthError) {
      throw error
    }
    if (error instanceof joseErrors.JOSEError || error instanceof TypeError) {
      throw new AuthError('session.invalid_token', undefined, {
        internalMessage: error instanceof joseErrors.JOSEError ? error.code : 'malformed token',
      })
    }
    // Anything else (e.g. the key store is down) is our failure, not the client's.
    throw error
  }
  const claims = AccessTokenClaimsSchema.safeParse(payload)
  if (
    !claims.success ||
    claims.data.eid !== tenant.environmentId ||
    claims.data.pid !== tenant.projectId
  ) {
    throw new AuthError('session.invalid_token')
  }
  return claims.data
}

/**
 * Require a signed-in user and set `c.var.session` to the session's claims.
 *
 * Must run after `publishableKey()`, which resolves the tenant the session has to belong to.
 * Two kinds of session reach it (ADR 0028), and the rest of the API does not tell them apart:
 *
 * - **`hybrid`**: an `Authorization: Bearer` access token. Verified with cached keys (no
 *   database hit), then its `sid` is checked against the revoked-session denylist so a revoked
 *   session stops working before its token expires.
 * - **`stateful`**: the session cookie, when there is no `Authorization` header. Its token is
 *   looked up in the session store on every request (`Sessions.authenticate`), so a
 *   revocation is seen by the very next one. The cookie is read only when
 *   `requestMayUseSessionCookie` allows (the CSRF rules); otherwise the request is simply not
 *   signed in. A cookie that can never work again is cleared.
 *
 * A Bearer token that is present decides alone: a bad one is never rescued by the cookie.
 *
 * @returns The middleware.
 * @throws AuthError `auth.unauthenticated`, `session.expired`, `session.invalid_token`,
 *   `session.revoked`, `session.reuse_detected` or `auth.user_banned`.
 */
export function sessionAuth() {
  return createMiddleware<AppEnv & { Variables: TenantVariables & SessionVariables }>(
    async (c, next) => {
      const tenant = c.get('tenant') as Tenant | undefined
      if (!tenant) {
        throw new InternalError({ internalMessage: 'sessionAuth mounted without publishableKey' })
      }
      const deps = c.get('deps')
      if (c.req.header('authorization') !== undefined) {
        const token = bearerToken(c.req.header('authorization'))
        if (!token) {
          throw new AuthError('auth.unauthenticated')
        }
        const claims = await verifyAccessToken(deps, token, tenant)
        // The token itself is valid until `exp`; this catches sessions revoked since it was issued.
        if (await deps.revokedSessions.has(claims.sid, deps.clock.now())) {
          throw new AuthError('session.revoked')
        }
        c.set('session', claims)
        return next()
      }
      // The cookie first: a request without one is not signed in, whatever its origin, and
      // needs no settings read to be told so.
      const cookie = readSessionCookie(c, deps.config, tenant.environmentId)
      if (!cookie || !(await requestMayUseSessionCookie(c))) {
        throw new AuthError('auth.unauthenticated')
      }
      try {
        c.set('session', await Sessions.authenticate(deps, tenant, cookie, requestOrigin(c)))
      } catch (error) {
        if (error instanceof AuthError) {
          // The session is over: drop the cookie so the browser stops sending it.
          clearSessionCookie(c, deps.config, tenant.environmentId)
        }
        throw error
      }
      return next()
    }
  )
}
