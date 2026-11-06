import { createMiddleware } from 'hono/factory'
import type { AppEnv, TenantVariables } from '~/dependencies'
import { AuthError, RateLimitError } from '~/exceptions'
import { sha256Hex } from '~/lib/crypto'
import * as logger from '~/lib/logger'
import { errorReason } from '~/lib/safe-error'
import { bearerToken, LAST_USED_PRECISION_MS } from '~/middleware/api-key'
import * as ScimTokens from '~/modules/scim-token/service'

/** Longer values are rejected before hashing so huge headers cost nothing. */
const MAX_TOKEN_LENGTH = 256

/** Requests per minute one token may make. */
export const SCIM_TOKEN_RATE_LIMIT = 600

/** Requests per minute all the tokens of one organization may make together. */
export const SCIM_ORGANIZATION_RATE_LIMIT = 1200

/** Requests per minute one IP may make to `/v1/scim/v2`, counted before the token is checked. */
export const SCIM_IP_RATE_LIMIT = 1200

/** What `scimToken()` adds to the context: the organization the token provisions for. */
export interface ScimVariables {
  scim: { organizationId: string; tokenId: string; viaSetupLink: boolean }
}

/**
 * Authorize a `/v1/scim/v2/*` request with a SCIM token and set `c.var.tenant` and `c.var.scim`
 * (ADR 0067, "SCIM").
 *
 * A SCIM token opens this group and nothing else, and no other credential opens it: a secret
 * key, an agent key or a dashboard session is answered like a wrong token. Every failure
 * (missing, malformed, unknown, another environment's, revoked) is the same `auth.invalid_key`.
 * The token names its environment, which the lookup needs because the table is behind
 * row-level security; the SHA-256 hash is what decides. Each valid request is counted against
 * the token and against its organization, and a limiter that cannot answer refuses it.
 *
 * @returns The middleware.
 * @throws AuthError `auth.invalid_key`; RateLimitError once a limit is exceeded.
 */
export function scimToken() {
  return createMiddleware<AppEnv & { Variables: TenantVariables & ScimVariables }>(
    async (c, next) => {
      const deps = c.get('deps')
      const presented = bearerToken(c.req.header('authorization'))
      const environmentId =
        presented && presented.length <= MAX_TOKEN_LENGTH
          ? ScimTokens.environmentOf(presented)
          : null
      if (!presented || !environmentId) {
        throw new AuthError('auth.invalid_key')
      }
      const record = await deps.scim.findTokenByHash(environmentId, sha256Hex(presented))
      if (!record || record.revokedAt !== null) {
        throw new AuthError('auth.invalid_key')
      }
      const windowMs = 60_000
      for (const [bucket, limit] of [
        [`scim:token:${record.id}`, SCIM_TOKEN_RATE_LIMIT],
        [`scim:org:${record.organizationId}`, SCIM_ORGANIZATION_RATE_LIMIT],
      ] as const) {
        const decision = await deps.rateLimiter.hit(bucket, limit, windowMs)
        if (!decision.allowed) {
          throw new RateLimitError(decision.retryAfterMs)
        }
      }
      const now = deps.clock.now()
      if (
        !record.lastUsedAt ||
        now.getTime() - record.lastUsedAt.getTime() >= LAST_USED_PRECISION_MS
      ) {
        // Bookkeeping only: a failed write must never turn a valid token into a failed request.
        await deps.scim.touchToken(environmentId, record.id, now).catch((error: unknown) => {
          logger.warn('could not record scim token usage', {
            scimTokenId: record.id,
            reason: errorReason(error),
          })
        })
      }
      c.set('tenant', {
        projectId: record.projectId,
        environmentId: record.environmentId,
        apiKeyId: record.id,
      })
      c.set('scim', {
        organizationId: record.organizationId,
        tokenId: record.id,
        viaSetupLink: record.viaSetupLink,
      })
      await next()
    }
  )
}
