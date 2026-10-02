import type { Jwk } from '@tula/contract'
import { MemoryActivityLog } from '~/adapters/memory/activity-log'
import type { Activity } from '~/ports/activity-log'
import {
  canVerify,
  type NewSigningKey,
  type RotationPlan,
  type SigningKeyRecord,
  type SigningKeyStore,
} from '~/ports/signing-key-store'

function copy(record: SigningKeyRecord): SigningKeyRecord {
  return { ...record, publicJwk: { ...record.publicJwk } }
}

/** In-memory signing keys, mirroring the Postgres one-active / one-next constraints. */
export class MemorySigningKeyStore implements SigningKeyStore {
  readonly #keys: SigningKeyRecord[]
  readonly #activityLog: MemoryActivityLog

  /**
   * Fields are assigned here for Bun coverage; see MemoryApiKeyRepository.
   *
   * @param activityLog - Where activity is recorded; shared with the other memory stores.
   */
  constructor(activityLog: MemoryActivityLog = new MemoryActivityLog()) {
    this.#keys = []
    this.#activityLog = activityLog
  }

  /**
   * Store a key directly (test seeding), bypassing the lifecycle constraints.
   *
   * @param key - Environment, public JWK, status and optional retirement time.
   */
  add(key: {
    environmentId: string
    jwk: Jwk
    status: SigningKeyRecord['status']
    retiredAt?: Date | null
  }): void {
    this.#keys.push({
      id: key.jwk.kid,
      projectId: 'seeded',
      environmentId: key.environmentId,
      status: key.status,
      publicJwk: key.jwk,
      privateKeyCiphertext: 'seeded',
      createdAt: new Date(0),
      activatedAt: null,
      retiredAt: key.retiredAt ?? null,
    })
  }

  /** @inheritdoc */
  async verificationKeys(environmentId: string, now: Date): Promise<Jwk[]> {
    return this.#keys
      .filter((key) => key.environmentId === environmentId && canVerify(key, now))
      .map((key) => ({ ...key.publicJwk, kid: key.id }))
  }

  /** @inheritdoc */
  async list(environmentId: string): Promise<SigningKeyRecord[]> {
    return this.#keys
      .filter((key) => key.environmentId === environmentId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
      .map(copy)
  }

  /** @inheritdoc */
  async insert(environmentId: string, keys: NewSigningKey[]): Promise<boolean> {
    const taken = (status: string) =>
      this.#keys.some((key) => key.environmentId === environmentId && key.status === status)
    const statuses = keys.map((key) => key.status)
    const clash =
      statuses.some((status) => status !== 'retired' && taken(status)) ||
      new Set(statuses).size !== statuses.length
    if (clash) {
      return false
    }
    for (const key of keys) {
      this.#keys.push(copy({ ...key, environmentId, retiredAt: null }))
    }
    return true
  }

  /** @inheritdoc */
  async rotate(
    environmentId: string,
    plan: RotationPlan,
    at: Date,
    activity?: Activity
  ): Promise<boolean> {
    const find = (id: string) =>
      this.#keys.find((key) => key.id === id && key.environmentId === environmentId)
    const retiring = find(plan.retireId)
    const activating = find(plan.activateId)
    if (retiring?.status !== 'active' || activating?.status !== 'next') {
      return false
    }
    retiring.status = 'retired'
    retiring.retiredAt = at
    activating.status = 'active'
    activating.activatedAt = at
    this.#keys.push(copy({ ...plan.next, environmentId, retiredAt: null }))
    this.#activityLog.record(activity ? [activity] : [])
    return true
  }
}
