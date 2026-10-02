import { isIP } from 'node:net'
import type { AuditActorType } from '@tula/contract'
import type { Context } from 'hono'
import type { AppEnv, SessionVariables, TenantVariables } from '~/dependencies'
import { clientIp } from '~/lib/client-ip'

/** Longest user agent stored with a session or an audit entry; longer values are cut. */
export const MAX_USER_AGENT_LENGTH = 512

/** Where a request came from. */
export interface Origin {
  ipAddress: string | null
  userAgent: string | null
}

/** Who did something, and from where. Recorded with every audited action. */
export interface Actor extends Origin {
  type: AuditActorType
  /** User id for a `user`, API key id for an `admin`, `null` for the `system`. */
  id: string | null
}

/**
 * Make an origin safe to store: the IP must parse (the audit column is `inet`, and a bad value
 * would fail the insert and roll back the change it records), and the user agent is capped.
 *
 * @param origin - Values as received.
 * @returns A valid IP or `null`, and a bounded user agent or `null`.
 */
export function cleanOrigin(origin: Partial<Origin>): Origin {
  return {
    ipAddress: origin.ipAddress && isIP(origin.ipAddress) ? origin.ipAddress : null,
    userAgent: origin.userAgent?.slice(0, MAX_USER_AGENT_LENGTH) || null,
  }
}

/**
 * @param c - The request context.
 * @returns The request's client IP and user agent.
 */
export function requestOrigin<E extends AppEnv>(c: Context<E>): Origin {
  return cleanOrigin({
    ipAddress: clientIp(c, c.get('deps').config.trustProxy),
    userAgent: c.req.header('user-agent'),
  })
}

/**
 * The actor of an admin request: the secret key that authorized it.
 *
 * @param c - A context `secretKey()` has run on.
 * @returns An `admin` actor whose id is the API key's id.
 */
export function adminActor<E extends AppEnv & { Variables: TenantVariables }>(
  c: Context<E>
): Actor {
  return { type: 'admin', id: c.get('tenant').apiKeyId, ...requestOrigin(c) }
}

/**
 * The actor of a signed-in user's request.
 *
 * @param c - A context `sessionAuth()` has run on.
 * @returns A `user` actor whose id is the access token's subject.
 */
export function userActor<E extends AppEnv & { Variables: SessionVariables }>(
  c: Context<E>
): Actor {
  return { type: 'user', id: c.get('session').sub, ...requestOrigin(c) }
}

/**
 * The actor of something the server decided by itself, e.g. revoking a session whose refresh
 * token was replayed.
 *
 * @param origin - The request that triggered it, if any.
 * @returns A `system` actor.
 */
export function systemActor(origin: Partial<Origin> = {}): Actor {
  return { type: 'system', id: null, ...cleanOrigin(origin) }
}
