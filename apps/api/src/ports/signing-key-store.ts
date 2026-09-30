import { DEFAULT_WEB_SESSION_PROFILE, durationToMs, type Jwk } from '@tula/contract'

/** Lifecycle of a signing key: `next` is published ahead of use, `active` signs, `retired` verifies. */
export type SigningKeyStatus = 'next' | 'active' | 'retired'

/**
 * How long a retired key stays usable for verification: twice the longest access-token TTL, so
 * every token it signed has expired and external JWKS caches have refreshed.
 *
 * Phase 0 issues only the default web profile; this must grow with configurable profiles.
 */
export const RETIRED_KEY_RETENTION_MS = 2 * durationToMs(DEFAULT_WEB_SESSION_PROFILE.accessTokenTtl)

/**
 * Whether a key can verify tokens at `now`.
 *
 * Shared by every adapter so they agree on the lifecycle rule.
 *
 * @param key - The key's status and retirement time.
 * @param now - The current time.
 * @returns `true` for `next` and `active` keys, and for keys retired within the retention window.
 */
export function canVerify(
  key: { status: SigningKeyStatus; retiredAt: Date | null },
  now: Date
): boolean {
  if (key.status !== 'retired') {
    return true
  }
  return (
    key.retiredAt !== null && now.getTime() - key.retiredAt.getTime() < RETIRED_KEY_RETENTION_MS
  )
}

/**
 * Public signing keys used to verify access tokens.
 *
 * Rotation invariant, relied on by the cached adapter: a key must be published as `next` for at
 * least one cache TTL before it becomes `active`, or freshly signed tokens fail verification on
 * instances whose cache predates the key.
 */
export interface SigningKeyStore {
  /**
   * Public keys that may verify tokens for an environment at `now`.
   *
   * @param environmentId - The environment (tenant) id.
   * @param now - The current time, for the retirement window.
   * @returns Public JWKs whose `kid` is the signing-key row id.
   */
  verificationKeys(environmentId: string, now: Date): Promise<Jwk[]>
}
