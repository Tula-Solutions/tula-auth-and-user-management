import type { Jwk } from '@tula/contract'
import { canVerify, type SigningKeyStatus, type SigningKeyStore } from '~/ports/signing-key-store'

interface StoredKey {
  environmentId: string
  jwk: Jwk
  status: SigningKeyStatus
  retiredAt: Date | null
}

/** In-memory public signing keys. Tests add keys with {@link MemorySigningKeyStore.add}. */
export class MemorySigningKeyStore implements SigningKeyStore {
  readonly #keys: StoredKey[]

  // Assigned in the constructor, not as a field initializer: Bun's coverage counts a class with
  // initializers but no constructor as having an uncalled function, failing the per-file threshold.
  constructor() {
    this.#keys = []
  }

  /**
   * Publish a public key for an environment.
   *
   * @param key - The environment, public JWK, lifecycle status and retirement time.
   */
  add(key: {
    environmentId: string
    jwk: Jwk
    status: SigningKeyStatus
    retiredAt?: Date | null
  }): void {
    this.#keys.push({ ...key, retiredAt: key.retiredAt ?? null })
  }

  /** @inheritdoc */
  async verificationKeys(environmentId: string, now: Date): Promise<Jwk[]> {
    return this.#keys
      .filter((key) => key.environmentId === environmentId && canVerify(key, now))
      .map((key) => key.jwk)
  }
}
