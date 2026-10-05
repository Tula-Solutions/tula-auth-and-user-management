import { durationToMs, type Jwk, MAX_ACCESS_TOKEN_TTL } from '@tula/contract'
import type { Recorded } from '~/ports/activity-log'

/** Lifecycle of a signing key: `next` is published ahead of use, `active` signs, `retired` verifies. */
export type SigningKeyStatus = 'next' | 'active' | 'retired'

/**
 * How long a retired key stays usable for verification: twice the longest access-token TTL a
 * session profile may set (`MAX_ACCESS_TOKEN_TTL`, ADR 0028), so every token it signed has
 * expired and external JWKS caches have refreshed.
 */
export const RETIRED_KEY_RETENTION_MS = 2 * durationToMs(MAX_ACCESS_TOKEN_TTL)

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

/** A stored signing key. `privateKeyCiphertext` is sealed with the `signing-keys` secret box. */
export interface SigningKeyRecord {
  /** Also the JWT `kid`. */
  id: string
  projectId: string
  environmentId: string
  status: SigningKeyStatus
  /** Public JWK (its `kid` is set to `id` when served). */
  publicJwk: Jwk
  privateKeyCiphertext: string
  createdAt: Date
  activatedAt: Date | null
  retiredAt: Date | null
}

/** A key to store: bootstrap inserts `active` + `next`; rotation inserts a new `next`. */
export type NewSigningKey = Omit<SigningKeyRecord, 'retiredAt'>

/** One rotation step: `active → retired`, `next → active`, and a new `next`. */
export interface RotationPlan {
  retireId: string
  activateId: string
  next: NewSigningKey
}

/**
 * Signing keys: verification keys for `sessionAuth`, plus the lifecycle writes for the jwks module.
 *
 * Invariants (enforced by partial unique indexes in Postgres and mirrored by the memory adapter):
 * at most one `active` and one `next` key per environment.
 *
 * Rotation invariant, relied on by the cached adapter and external JWKS caches: a key must be
 * published as `next` for at least one cache TTL before it becomes `active`, or freshly signed
 * tokens fail verification on instances whose cache predates the key.
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

  /**
   * Every key of an environment, newest first, including long-retired ones.
   *
   * @param environmentId - The environment.
   * @returns The keys, with their ciphertext.
   */
  list(environmentId: string): Promise<SigningKeyRecord[]>

  /**
   * Insert keys atomically (all or none).
   *
   * @param environmentId - The environment every key belongs to.
   * @param keys - Keys to insert.
   * @returns `false` when another writer already holds an `active`/`next` slot (nothing inserted).
   */
  insert(environmentId: string, keys: NewSigningKey[]): Promise<boolean>

  /**
   * Apply a rotation atomically.
   *
   * @param environmentId - The environment.
   * @param plan - Which key to retire, which to activate, and the new `next` key.
   * @param at - Rotation time (becomes `retiredAt` / `activatedAt`).
   * @param activity - Recorded in the same transaction, only if the rotation happened.
   * @returns `false` when the keys are no longer in the expected states (a concurrent rotation
   *   won); nothing is changed in that case.
   */
  rotate(environmentId: string, plan: RotationPlan, at: Date, activity: Recorded): Promise<boolean>
}
