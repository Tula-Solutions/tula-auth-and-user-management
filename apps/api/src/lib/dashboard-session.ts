import type { DashboardSession, Deps } from '~/dependencies'
import { timingSafeEqual } from '~/lib/crypto'

/**
 * How long a dashboard session lasts, from sign-in. Absolute: nothing extends it, so a copied
 * cookie is worth eight hours at most (ADR 0032).
 */
export const DASHBOARD_SESSION_TTL_MS = 8 * 60 * 60_000

/** Key-separation label of the session MAC (`~/lib/keyed-hash`). */
export const DASHBOARD_SESSION_PURPOSE = 'dashboard-sessions'

/** Longest cookie value looked at; a real one is under 200 characters. */
const MAX_VALUE_LENGTH = 512

const VERSION = 'v1'

type SessionDeps = Pick<Deps, 'keyedHash' | 'clock' | 'config'>

/**
 * The MAC over a payload. The admin token's digest is part of what is signed, so every session
 * dies when `TULA_ADMIN_TOKEN` changes, and the key is derived from `TULA_MASTER_KEY`, so they
 * die when that changes too. The digest is an input only: nothing derived from the token is in
 * the cookie.
 */
function sign(deps: SessionDeps, payload: string, tokenHash: string): Promise<string> {
  return deps.keyedHash.hmac(DASHBOARD_SESSION_PURPOSE, `${VERSION}.${payload}.${tokenHash}`)
}

/**
 * Mint a dashboard session: `v1.<base64url JSON { sid, iat, exp }>.<HMAC-SHA256 hex>`.
 *
 * Stateless: nothing is stored, so every API instance with the same master key and admin token
 * honours it, and one session cannot be revoked by itself (ADR 0032).
 *
 * @param deps - Keyed hash, clock and config.
 * @param id - The session's random id.
 * @returns The cookie value and the session it describes.
 * @throws Error when the deployment has no admin token (the caller answers 404 before this).
 */
export async function mintDashboardSession(
  deps: SessionDeps,
  id: string
): Promise<{ value: string; session: DashboardSession }> {
  const tokenHash = deps.config.instanceAdminTokenHash
  if (tokenHash === null) {
    throw new Error('mintDashboardSession: no instance admin token')
  }
  const issuedAt = Math.floor(deps.clock.now().getTime() / 1000)
  const expiresAt = issuedAt + DASHBOARD_SESSION_TTL_MS / 1000
  const payload = Buffer.from(JSON.stringify({ sid: id, iat: issuedAt, exp: expiresAt })).toString(
    'base64url'
  )
  return {
    value: `${VERSION}.${payload}.${await sign(deps, payload, tokenHash)}`,
    session: { id, expiresAt: new Date(expiresAt * 1000) },
  }
}

function readPayload(payload: string): { sid: string; iat: number; exp: number } | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (typeof parsed !== 'object' || parsed === null) {
      return null
    }
    const { sid, iat, exp } = parsed as Record<string, unknown>
    if (
      typeof sid !== 'string' ||
      sid === '' ||
      !Number.isSafeInteger(iat) ||
      !Number.isSafeInteger(exp)
    ) {
      return null
    }
    return { sid, iat: iat as number, exp: exp as number }
  } catch {
    return null
  }
}

/**
 * Verify a dashboard session cookie's value.
 *
 * The MAC is compared in constant time before the payload is parsed. A session is honoured
 * only between its `iat` and `exp`, and never for longer than {@link DASHBOARD_SESSION_TTL_MS}
 * whatever the payload claims.
 *
 * @param deps - Keyed hash, clock and config.
 * @param value - The cookie's value, if any.
 * @returns The session, or `null` for anything else: missing, malformed, forged, expired, made
 *   under another admin token or master key, or a deployment with no admin token.
 */
export async function verifyDashboardSession(
  deps: SessionDeps,
  value: string | undefined
): Promise<DashboardSession | null> {
  const tokenHash = deps.config.instanceAdminTokenHash
  if (tokenHash === null || !value || value.length > MAX_VALUE_LENGTH) {
    return null
  }
  const pieces = value.split('.')
  const [version, payload, mac] = pieces
  if (pieces.length !== 3 || version !== VERSION || !payload || !mac) {
    return null
  }
  if (!timingSafeEqual(mac, await sign(deps, payload, tokenHash))) {
    return null
  }
  const claims = readPayload(payload)
  if (!claims) {
    return null
  }
  const now = deps.clock.now().getTime()
  const issuedAt = claims.iat * 1000
  const expiresAt = claims.exp * 1000
  if (issuedAt > now || expiresAt <= now || expiresAt - issuedAt > DASHBOARD_SESSION_TTL_MS) {
    return null
  }
  return { id: claims.sid, expiresAt: new Date(expiresAt) }
}
