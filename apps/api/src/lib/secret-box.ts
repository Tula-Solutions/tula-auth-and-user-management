/**
 * Encrypts secrets at rest (signing keys now; TOTP seeds later) with AES-256-GCM.
 *
 * Each purpose gets its own key, derived from `TULA_MASTER_KEY` with HKDF-SHA256, so a ciphertext
 * from one purpose can never be opened as another. Callers pass associated data (AAD) that binds
 * a ciphertext to its row, e.g. the key id and environment id: copying a ciphertext into a
 * different row then fails to decrypt instead of silently working.
 */
export interface SecretBox {
  /**
   * Encrypt a secret.
   *
   * @param purpose - Key-separation label, e.g. `signing-keys`.
   * @param plaintext - The secret bytes.
   * @param aad - Associated data that must be presented again to decrypt.
   * @returns `v1.<iv>.<ciphertext+tag>`, base64url segments.
   */
  seal(purpose: string, plaintext: Uint8Array, aad: string): Promise<string>

  /**
   * Decrypt a secret sealed by {@link SecretBox.seal}.
   *
   * @param purpose - The purpose it was sealed with.
   * @param sealed - The sealed string.
   * @param aad - The associated data it was sealed with.
   * @returns The plaintext bytes.
   * @throws Error when the format, key, purpose or AAD does not match, or the data was altered.
   */
  open(purpose: string, sealed: string, aad: string): Promise<Uint8Array>
}

const VERSION = 'v1'
const IV_BYTES = 12
const HKDF_SALT = new TextEncoder().encode('tula-secret-box')

/**
 * Create a secret box from the master key.
 *
 * Derived keys are non-extractable and cached per purpose. Derivation is lazy, so construction is
 * synchronous and cheap.
 *
 * @param masterKeyHex - `TULA_MASTER_KEY`: 64 hex characters.
 * @returns The secret box.
 * @throws Error when the master key is not 32 bytes of hex.
 */
export function createSecretBox(masterKeyHex: string): SecretBox {
  if (!/^[0-9a-fA-F]{64}$/.test(masterKeyHex)) {
    throw new Error('createSecretBox: master key must be 64 hex characters')
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
          { name: 'AES-GCM', length: 256 },
          false,
          ['encrypt', 'decrypt']
        )
      )
      keys.set(purpose, key)
    }
    return key
  }

  return {
    async seal(purpose, plaintext, aad) {
      const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
      const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad) },
        await keyFor(purpose),
        // Copy into an ArrayBuffer-backed view, as WebCrypto rejects SharedArrayBuffer views.
        new Uint8Array(plaintext)
      )
      return [
        VERSION,
        Buffer.from(iv).toString('base64url'),
        Buffer.from(ciphertext).toString('base64url'),
      ].join('.')
    },

    async open(purpose, sealed, aad) {
      const [version, iv, ciphertext, ...rest] = sealed.split('.')
      if (version !== VERSION || !iv || !ciphertext || rest.length > 0) {
        throw new Error('secret box: unrecognised ciphertext format')
      }
      const plaintext = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: Buffer.from(iv, 'base64url'),
          additionalData: new TextEncoder().encode(aad),
        },
        await keyFor(purpose),
        Buffer.from(ciphertext, 'base64url')
      )
      return new Uint8Array(plaintext)
    },
  }
}
