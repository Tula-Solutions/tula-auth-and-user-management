import { SETUP_LINK_HEADER } from '@tula-tech/contract'
import { createMiddleware } from 'hono/factory'
import type { AppEnv, TenantVariables } from '~/dependencies'
import { AuthError, RateLimitError } from '~/exceptions'
import { sha256Hex } from '~/lib/crypto'
import * as logger from '~/lib/logger'
import { errorReason } from '~/lib/safe-error'
import { LAST_USED_PRECISION_MS } from '~/middleware/api-key'
import * as SetupLinks from '~/modules/setup-link/service'

/** Longer values are rejected before hashing so huge headers cost nothing. */
const MAX_TOKEN_LENGTH = 256

/** Requests per minute one setup link may make. */
export const SETUP_LINK_RATE_LIMIT = 120

/** Requests per minute all the links of one organization may make together. */
export const SETUP_ORGANIZATION_RATE_LIMIT = 240

/** Requests per minute one IP may make to `/v1/setup`, counted before the token is checked. */
export const SETUP_IP_RATE_LIMIT = 300

/** What `setupLink()` adds to the context: the one organization the link is for. */
export interface SetupLinkVariables {
  setupLink: { organizationId: string; linkId: string; expiresAt: Date }
}

/**
 * Authorize a `/v1/setup/*` request with a setup link's token and set `c.var.tenant` and
 * `c.var.setupLink` (ADR 0067, "Setup links").
 *
 * The token is read from the `x-tula-setup-token` header and from nowhere else, so a secret
 * key, an agent key, a SCIM token or a dashboard session sent the usual way is "no token", and
 * a setup token sent as a bearer token opens no other group. Every failure (missing,
 * malformed, unknown, another environment's, revoked, expired) is the same `auth.invalid_key`.
 * The token names its environment, which the lookup needs because the table is behind
 * row-level security; the SHA-256 hash is what decides. Each valid request is counted against
 * the link and its organization, and a limiter that cannot answer refuses it.
 *
 * @returns The middleware.
 * @throws AuthError `auth.invalid_key`; RateLimitError once a limit is exceeded.
 */
export function setupLink() {
  return createMiddleware<AppEnv & { Variables: TenantVariables & SetupLinkVariables }>(
    async (c, next) => {
      const deps = c.get('deps')
      const presented = c.req.header(SETUP_LINK_HEADER)
      const environmentId =
        presented && presented.length <= MAX_TOKEN_LENGTH
          ? SetupLinks.environmentOf(presented)
          : null
      if (!presented || !environmentId) {
        throw new AuthError('auth.invalid_key')
      }
      const record = await deps.setupLinks.findByHash(environmentId, sha256Hex(presented))
      const now = deps.clock.now()
      if (!record || record.revokedAt !== null || record.expiresAt.getTime() <= now.getTime()) {
        throw new AuthError('auth.invalid_key')
      }
      const windowMs = 60_000
      for (const [bucket, limit] of [
        [`setup:link:${record.id}`, SETUP_LINK_RATE_LIMIT],
        [`setup:org:${record.organizationId}`, SETUP_ORGANIZATION_RATE_LIMIT],
      ] as const) {
        const decision = await deps.rateLimiter.hit(bucket, limit, windowMs)
        if (!decision.allowed) {
          throw new RateLimitError(decision.retryAfterMs)
        }
      }
      if (
        !record.lastUsedAt ||
        now.getTime() - record.lastUsedAt.getTime() >= LAST_USED_PRECISION_MS
      ) {
        // Bookkeeping only: a failed write must never turn a valid link into a failed request.
        await deps.setupLinks.touch(environmentId, record.id, now).catch((error: unknown) => {
          logger.warn('could not record setup link usage', {
            setupLinkId: record.id,
            reason: errorReason(error),
          })
        })
      }
      c.set('tenant', {
        projectId: record.projectId,
        environmentId: record.environmentId,
        apiKeyId: record.id,
      })
      c.set('setupLink', {
        organizationId: record.organizationId,
        linkId: record.id,
        expiresAt: record.expiresAt,
      })
      await next()
    }
  )
}
