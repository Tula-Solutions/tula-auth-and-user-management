/**
 * A software WebAuthn authenticator, for conformance scenarios and SDK tests.
 *
 * It does what a platform authenticator does for a passkey: makes a P-256 key pair for a
 * relying party, answers `create` with an attestation of format `none`, and answers `get` with
 * a signed assertion. Web Crypto only, so it runs wherever the runner does. It is a test
 * double: keys live in memory and nothing protects them.
 */

const encoder = new TextEncoder()

const FLAG_USER_PRESENT = 0x01
const FLAG_USER_VERIFIED = 0x04
const FLAG_BACKUP_ELIGIBLE = 0x08
const FLAG_BACKED_UP = 0x10
const FLAG_ATTESTED_CREDENTIAL = 0x40

/** What a ceremony is run with, besides the options the server issued. */
export interface CeremonyInput {
  /** The page's origin, written into the client data: `https://app.example.com`. */
  origin: string
  /** Whether the authenticator verified the user (PIN, biometric). Default `true`. */
  userVerified?: boolean
  /**
   * The signature counter to report. Default `0`: an authenticator that keeps none, as synced
   * passkeys do.
   */
  counter?: number
  /** Report the credential as eligible for backup and backed up (a synced passkey). */
  synced?: boolean
  /** Sign for this relying-party id instead of the one in the options (a wrong RP ID hash). */
  rpId?: string
}

/** The JSON form of a registration, as `PublicKeyCredential.toJSON()` gives it. */
// A type alias, not an interface: it must be assignable to the contract's open object shapes.
export type RegistrationJson = {
  id: string
  rawId: string
  type: 'public-key'
  response: { clientDataJSON: string; attestationObject: string; transports: string[] }
  authenticatorAttachment: 'platform'
  clientExtensionResults: Record<string, never>
}

/** The JSON form of an assertion, as `PublicKeyCredential.toJSON()` gives it. */
export type AssertionJson = {
  id: string
  rawId: string
  type: 'public-key'
  response: {
    clientDataJSON: string
    authenticatorData: string
    signature: string
    userHandle: string
  }
  authenticatorAttachment: 'platform'
  clientExtensionResults: Record<string, never>
}

interface StoredKey {
  rpId: string
  userHandle: string
  privateKey: CryptoKey
  synced: boolean
}

/**
 * Encode bytes as unpadded base64url.
 *
 * @param bytes - The bytes.
 * @returns The text WebAuthn's JSON forms use for a binary value.
 *
 * @example
 * ```ts
 * toBase64Url(new Uint8Array([251, 255])) // '-_8'
 * ```
 */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Decode unpadded base64url.
 *
 * @param text - The encoded value.
 * @returns The bytes.
 * @throws Error when the text is not base64url.
 *
 * @example
 * ```ts
 * fromBase64Url('-_8') // Uint8Array [251, 255]
 * ```
 */
export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) {
    throw new Error('not base64url')
  }
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))
}

// CBOR, as much of it as an attestation object needs: short text strings and byte strings.
function cborText(text: string): Uint8Array {
  const bytes = encoder.encode(text)
  return concat(new Uint8Array([0x60 + bytes.length]), bytes)
}

function cborBytes(bytes: Uint8Array): Uint8Array {
  const head =
    bytes.length < 24
      ? [0x40 + bytes.length]
      : bytes.length < 256
        ? [0x58, bytes.length]
        : [0x59, bytes.length >> 8, bytes.length & 0xff]
  return concat(new Uint8Array(head), bytes)
}

/** A P-256 public key as a COSE_Key: `{1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y}`. */
function coseKey(x: Uint8Array, y: Uint8Array): Uint8Array {
  return concat(
    new Uint8Array([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21]),
    cborBytes(x),
    new Uint8Array([0x22]),
    cborBytes(y)
  )
}

/** An ECDSA signature as Web Crypto returns it (`r || s`), re-encoded as ASN.1 DER. */
function derSignature(raw: Uint8Array): Uint8Array {
  const integer = (bytes: Uint8Array): Uint8Array => {
    let start = 0
    while (start < bytes.length - 1 && bytes[start] === 0) {
      start += 1
    }
    const trimmed = bytes.slice(start)
    const padded = (trimmed[0] ?? 0) & 0x80 ? concat(new Uint8Array([0]), trimmed) : trimmed
    return concat(new Uint8Array([0x02, padded.length]), padded)
  }
  const body = concat(integer(raw.slice(0, 32)), integer(raw.slice(32)))
  return concat(new Uint8Array([0x30, body.length]), body)
}

function uint32(value: number): Uint8Array {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, value)
  return bytes
}

function flags(input: CeremonyInput, synced: boolean, attested: boolean): number {
  return (
    FLAG_USER_PRESENT |
    (input.userVerified === false ? 0 : FLAG_USER_VERIFIED) |
    (synced ? FLAG_BACKUP_ELIGIBLE | FLAG_BACKED_UP : 0) |
    (attested ? FLAG_ATTESTED_CREDENTIAL : 0)
  )
}

function clientData(type: string, challenge: string, origin: string): Uint8Array {
  return encoder.encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }))
}

function text(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`the passkey options have no ${what}`)
  }
  return value
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

/**
 * A software authenticator holding discoverable P-256 credentials.
 *
 * @example
 * ```ts
 * const authenticator = new VirtualAuthenticator()
 * const registration = await authenticator.create(creationOptions, { origin })
 * const assertion = await authenticator.get(requestOptions, { origin })
 * ```
 */
export class VirtualAuthenticator {
  readonly #keys: Map<string, StoredKey>

  constructor() {
    this.#keys = new Map()
  }

  /** The ids (base64url) of the credentials this authenticator holds, oldest first. */
  get credentialIds(): string[] {
    return [...this.#keys.keys()]
  }

  /**
   * Forget a credential, as a user deleting a passkey from their device does.
   *
   * @param credentialId - The credential id, base64url.
   */
  forget(credentialId: string): void {
    this.#keys.delete(credentialId)
  }

  /**
   * Make a credential: what `navigator.credentials.create()` does.
   *
   * @param options - `PublicKeyCredentialCreationOptionsJSON`, as the server issued them.
   * @param input - The page's origin and how the authenticator behaves.
   * @returns The registration to send back (`RegistrationResponseJSON`).
   * @throws Error when the options lack a challenge, a relying party or a user, do not offer
   *   ES256, or exclude a credential this authenticator holds (a real one answers
   *   `InvalidStateError`).
   */
  async create(options: unknown, input: CeremonyInput): Promise<RegistrationJson> {
    const given = record(options)
    const challenge = text(given.challenge, 'challenge')
    const rpId = input.rpId ?? text(record(given.rp).id, 'relying-party id')
    const userHandle = text(record(given.user).id, 'user id')
    const algorithms = Array.isArray(given.pubKeyCredParams) ? given.pubKeyCredParams : []
    if (!algorithms.some((entry) => record(entry).alg === -7)) {
      throw new Error('the passkey options do not offer ES256')
    }
    const excluded = Array.isArray(given.excludeCredentials) ? given.excludeCredentials : []
    if (excluded.some((entry) => this.#keys.has(String(record(entry).id)))) {
      throw new Error('this authenticator already holds a credential the options exclude')
    }
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])
    const point = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
    const credentialId = crypto.getRandomValues(new Uint8Array(32))
    const id = toBase64Url(credentialId)
    const synced = input.synced ?? false
    this.#keys.set(id, { rpId, userHandle, privateKey: pair.privateKey, synced })
    const authData = concat(
      await sha256(encoder.encode(rpId)),
      new Uint8Array([flags(input, synced, true)]),
      uint32(input.counter ?? 0),
      new Uint8Array(16),
      new Uint8Array([credentialId.length >> 8, credentialId.length & 0xff]),
      credentialId,
      coseKey(point.slice(1, 33), point.slice(33, 65))
    )
    const attestationObject = concat(
      new Uint8Array([0xa3]),
      cborText('fmt'),
      cborText('none'),
      cborText('attStmt'),
      new Uint8Array([0xa0]),
      cborText('authData'),
      cborBytes(authData)
    )
    return {
      id,
      rawId: id,
      type: 'public-key',
      response: {
        clientDataJSON: toBase64Url(clientData('webauthn.create', challenge, input.origin)),
        attestationObject: toBase64Url(attestationObject),
        transports: ['internal'],
      },
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
    }
  }

  /**
   * Sign an assertion: what `navigator.credentials.get()` does.
   *
   * With `allowCredentials` in the options, the first listed credential this authenticator
   * holds is used; without, its newest credential for the relying party (a discoverable
   * credential).
   *
   * @param options - `PublicKeyCredentialRequestOptionsJSON`, as the server issued them.
   * @param input - The page's origin and how the authenticator behaves.
   * @returns The assertion to send back (`AuthenticationResponseJSON`).
   * @throws Error when the options lack a challenge or a relying-party id, or the authenticator
   *   holds no credential they accept.
   */
  async get(options: unknown, input: CeremonyInput): Promise<AssertionJson> {
    const given = record(options)
    const challenge = text(given.challenge, 'challenge')
    const rpId = text(given.rpId, 'relying-party id')
    const allowed = Array.isArray(given.allowCredentials)
      ? given.allowCredentials.map((entry) => String(record(entry).id))
      : null
    const id = [...this.#keys.keys()]
      .reverse()
      .find((candidate) =>
        allowed ? allowed.includes(candidate) : this.#keys.get(candidate)?.rpId === rpId
      )
    const key = id === undefined ? undefined : this.#keys.get(id)
    if (id === undefined || !key) {
      throw new Error('this authenticator holds no credential the options accept')
    }
    const client = clientData('webauthn.get', challenge, input.origin)
    const authData = concat(
      await sha256(encoder.encode(input.rpId ?? rpId)),
      new Uint8Array([flags(input, input.synced ?? key.synced, false)]),
      uint32(input.counter ?? 0)
    )
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        key.privateKey,
        concat(authData, await sha256(client))
      )
    )
    return {
      id,
      rawId: id,
      type: 'public-key',
      response: {
        clientDataJSON: toBase64Url(client),
        authenticatorData: toBase64Url(authData),
        signature: toBase64Url(derSignature(signature)),
        userHandle: key.userHandle,
      },
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
    }
  }
}
