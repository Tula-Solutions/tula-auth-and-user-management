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
  /**
   * User id for a `user`, API key id for an `admin`, dashboard session id for an
   * `instance_admin` (`null` when the admin token itself was presented), `null` for the `system`.
   */
  id: string | null
}

/**
 * Whether Postgres will accept a value in an `inet` column. `isIP` alone is not enough: it
 * accepts an IPv6 zone id (`fe80::1%eth0`), which `inet` rejects.
 */
function isStorableIp(value: string): boolean {
  return isIP(value) !== 0 && !value.includes('%')
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
    ipAddress: origin.ipAddress && isStorableIp(origin.ipAddress) ? origin.ipAddress : null,
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
 * The actor of an admin request: the secret key that authorized it, or the dashboard session
 * that did (ADR 0032), so every audit entry shows that the dashboard made the change.
 *
 * @param c - A context `secretKey()` has run on.
 * @returns An `admin` actor whose id is the API key's id, or an `instance_admin` actor whose id
 *   is the dashboard session's.
 */
export function adminActor<E extends AppEnv & { Variables: TenantVariables }>(
  c: Context<E>
): Actor {
  const dashboard = c.get('dashboard')
  if (dashboard) {
    return { type: 'instance_admin', id: dashboard.id, ...requestOrigin(c) }
  }
  return { type: 'admin', id: c.get('tenant').apiKeyId, ...requestOrigin(c) }
}

/**
 * The actor of an instance request: the deployment's operator.
 *
 * @param c - A context `instanceAdmin()` has run on, or the sign-in route's.
 * @returns An `instance_admin` actor whose id is the dashboard session's, or `null` when the
 *   request carried the admin token itself.
 */
export function instanceActor<E extends AppEnv>(c: Context<E>): Actor {
  return { type: 'instance_admin', id: c.get('dashboard')?.id ?? null, ...requestOrigin(c) }
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
