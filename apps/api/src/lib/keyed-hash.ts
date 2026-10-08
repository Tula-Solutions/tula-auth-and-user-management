/**
 * Keyed hashes (HMAC-SHA256) for secrets too guessable for a plain hash, such as 6-digit codes,
 * and for values derived from a server secret, such as refresh-token children.
 *
 * Each purpose gets its own key, derived from `TULA_MASTER_KEY` with HKDF-SHA256, so a hash made
 * for one purpose is useless for another.
 */
export interface KeyedHash {
  /**
   * @param purpose - Key-separation label, e.g. `verification-codes`.
   * @param message - The value to authenticate. Bind it to its row (e.g. `<token id>:<code>`).
   * @returns The HMAC as 64 lowercase hex characters.
   */
  hmac(purpose: string, message: string): Promise<string>
}

const VERSION = 'v1'
// Distinct from the secret box's salt so the two never derive the same key for a purpose.
const HKDF_SALT = new TextEncoder().encode('tula-keyed-hash')

/**
 * Create a keyed hasher from the master key.
 *
 * Derived keys are non-extractable and cached per purpose; derivation is lazy.
 *
 * @param masterKeyHex - `TULA_MASTER_KEY`: 64 hex characters.
 * @returns The keyed hasher.
 * @throws Error when the master key is not 32 bytes of hex.
 */
export function createKeyedHash(masterKeyHex: string): KeyedHash {
  if (!/^[0-9a-fA-F]{64}$/.test(masterKeyHex)) {
    throw new Error('createKeyedHash: master key must be 64 hex characters')
  }
  const master = crypto.subtle.importKey('raw', Buffer.from(masterKeyHex, 'hex'), 'HKDF', false, [
    'deriveKey',
  ])
  const keys = new Map<string, Promise<CryptoKey>>()

  function keyFor(purpose: string): Promise<CryptoKey> {
    let key = keys.get(purpose)
    if (!key) {
      key = master.then((base) =>
        crypto.subtle.deriveKey(
          {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: HKDF_SALT,
            info: new TextEncoder().encode(`tula:${purpose}:${VERSION}`),
          },
          base,
          { name: 'HMAC', hash: 'SHA-256', length: 256 },
          false,
          ['sign']
        )
      )
      keys.set(purpose, key)
    }
    return key
  }

  return {
    async hmac(purpose, message) {
      const signature = await crypto.subtle.sign(
        'HMAC',
        await keyFor(purpose),
        new TextEncoder().encode(message)
      )
      return Buffer.from(signature).toString('hex')
    },
  }
}
