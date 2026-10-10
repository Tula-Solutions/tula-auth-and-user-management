// Device binding (ADR 0043): a session bound at sign-in to a public key, refreshed only with a
// proof signed by that key. The proof is RFC 9449's DPoP proof JWT. This module imports
// nothing (no Zod) and uses web platform APIs only, so the server that checks a proof, the
// SDKs that make one and the conformance runner share one definition:
// `@tula/contract/device-binding`.

/**
 * Request header carrying the proof: one DPoP proof JWT (RFC 9449), made for this one request.
 * Sent when an attempt starts, to bind the session it ends in, and on every refresh of a bound
 * session.
 *
 * @example
 * ```ts
 * headers[DPOP_HEADER] = await createDpopProof(key, { method: 'POST', url, nonce })
 * ```
 */
export const DPOP_HEADER = 'DPoP'

/**
 * Response header carrying the server's nonce: on the answer that asks for one
 * (`device.nonce_required`), on every refresh of a bound session and on every start that
 * brought a proof. A client keeps the newest one and puts it in its next proof.
 *
 * @example
 * ```ts
 * const nonce = response.headers.get(DPOP_NONCE_HEADER)
 * ```
 */
export const DPOP_NONCE_HEADER = 'DPoP-Nonce'

/**
 * The `typ` of a proof's header. A token of any other type is not a proof.
 *
 * @example
 * ```ts
 * header.typ === DPOP_PROOF_TYPE // 'dpop+jwt'
 * ```
 */
export const DPOP_PROOF_TYPE = 'dpop+jwt'

/**
 * The signature algorithms a proof may use: a closed list, and `ES256` alone. It is what the
 * Secure Enclave and StrongBox sign with (ECDSA over P-256 with SHA-256); a later algorithm is
 * added here on purpose, never accepted because a proof names it.
 *
 * @example
 * ```ts
 * DPOP_ALGORITHMS.includes(header.alg) // only 'ES256'
 * ```
 */
export const DPOP_ALGORITHMS = ['ES256'] as const

/** One of {@link DPOP_ALGORITHMS}. */
export type DpopAlgorithm = (typeof DPOP_ALGORITHMS)[number]

/**
 * Longest proof the server reads, in characters. A proof is a small header, six short claims
 * and a 64-byte signature: about 500 characters. Anything longer is refused unread.
 *
 * @example
 * ```ts
 * proof.length <= MAX_DPOP_PROOF_LENGTH
 * ```
 */
export const MAX_DPOP_PROOF_LENGTH = 2048

/**
 * The public half of a device key, as a proof's header carries it: a P-256 point and nothing
 * else. No private member (`d`), no key id, no other field.
 *
 * @example
 * ```ts
 * const jwk: DevicePublicJwk = { kty: 'EC', crv: 'P-256', x: '…', y: '…' }
 * ```
 */
export interface DevicePublicJwk {
  kty: 'EC'
  crv: 'P-256'
  /** The point's x coordinate: 32 bytes, base64url without padding. */
  x: string
  /** The point's y coordinate: 32 bytes, base64url without padding. */
  y: string
}

/**
 * A key a session can be bound to: its public half, and a way to sign with the private half
 * that never hands the private half out. A native SDK backs it with the Secure Enclave or
 * StrongBox; {@link generateSoftwareDeviceKey} backs it with WebCrypto, for tests and for
 * platforms with no hardware key.
 *
 * @example
 * ```ts
 * const key: DeviceKey = await generateSoftwareDeviceKey()
 * const proof = await createDpopProof(key, { method: 'POST', url, nonce })
 * ```
 */
export interface DeviceKey {
  /** The public key, sent in every proof's header. */
  publicJwk: DevicePublicJwk
  /**
   * Sign with ECDSA over P-256 and SHA-256.
   *
   * @param data - The bytes to sign (a proof's `header.payload`).
   * @returns The signature in the JWS form: `r` then `s`, 32 bytes each (64 bytes). A platform
   *   that produces a DER signature converts it before returning.
   */
  sign(data: Uint8Array): Promise<Uint8Array>
}

/** What a proof is made for. */
export interface DpopProofInput {
  /** The request's method, e.g. `POST`: the proof's `htm`. */
  method: string
  /**
   * The request's address **as the API knows itself**: its public URL and the route's
   * path. The proof's `htu`. Never the address of a proxy or of an app's own route handler
   * in front of the API.
   *
   * It has one spelling, which needs no URL parser to produce or to check: `http` or
   * `https`, `://`, the host, an optional `:port` in digits, then a path that starts with
   * `/`, in printable ASCII (a host with other letters in its `xn--` form). The server
   * ignores the case of the scheme and of the host and a default port written out (`:443`,
   * `:80`), and compares the path byte for byte. It **refuses** an address with a
   * backslash, a `.` or `..` path segment, a percent sign, a query or a fragment (an empty
   * one too), user info (`user@`), or a space, a tab or a line break. It is signed as
   * given: this module does not rewrite it.
   */
  url: string
  /** The server's nonce, once the client has one ({@link DPOP_NONCE_HEADER}). */
  nonce?: string
  /** The proof's unique id. Left out, 16 random bytes. A proof is accepted once. */
  jti?: string
  /** When the proof is made, in milliseconds since the epoch. Left out, now. */
  now?: number
}

const encoder = new TextEncoder()

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// 32 bytes in base64url: 43 characters, of which the last carries four bits. Only the
// sixteen characters whose two low bits are zero end a canonical encoding; any other would
// be a second spelling of the same bytes, and a second thumbprint for the same key.
const THIRTY_TWO_BYTES = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/
const COORDINATE = THIRTY_TWO_BYTES
const THUMBPRINT = THIRTY_TWO_BYTES

/**
 * Whether a value is the public half of a device key and nothing more: exactly the four
 * members of {@link DevicePublicJwk}, each coordinate 32 bytes in its one canonical
 * base64url spelling (so that a key has one thumbprint). A key with a private member
 * (`d`) or any other field is refused: a client that sends its private key has none.
 *
 * It does not check that the point is on the curve; importing the key does.
 *
 * @param value - What a proof's header holds under `jwk`.
 * @returns `true` for a well-formed public P-256 key.
 * @example
 * ```ts
 * isDevicePublicJwk({ kty: 'EC', crv: 'P-256', x, y }) // true
 * isDevicePublicJwk({ kty: 'EC', crv: 'P-256', x, y, d }) // false
 * ```
 */
export function isDevicePublicJwk(value: unknown): value is DevicePublicJwk {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const jwk = value as Record<string, unknown>
  return (
    Object.keys(jwk).length === 4 &&
    jwk.kty === 'EC' &&
    jwk.crv === 'P-256' &&
    typeof jwk.x === 'string' &&
    COORDINATE.test(jwk.x) &&
    typeof jwk.y === 'string' &&
    COORDINATE.test(jwk.y)
  )
}

/**
 * Whether a value has the shape of a key thumbprint: 43 base64url characters (a SHA-256).
 *
 * @param value - A stored or received thumbprint.
 * @returns `true` for a well-formed one.
 * @example
 * ```ts
 * isKeyThumbprint(claims.cnf?.jkt)
 * ```
 */
export function isKeyThumbprint(value: unknown): value is string {
  return typeof value === 'string' && THUMBPRINT.test(value)
}

/**
 * The thumbprint of a device key (RFC 7638, SHA-256, base64url): what a bound session stores
 * and what its access token carries as `cnf.jkt`. Two keys have the same thumbprint only when
 * they are the same key.
 *
 * @param jwk - The public key.
 * @returns 43 base64url characters.
 * @example
 * ```ts
 * const jkt = await jwkThumbprint(key.publicJwk)
 * ```
 */
export async function jwkThumbprint(jwk: DevicePublicJwk): Promise<string> {
  // RFC 7638: the required members only, in lexicographic order, with no white space.
  const canonical = `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(canonical))
  return base64url(new Uint8Array(digest))
}

/**
 * Make a proof for one request: a JWT of type `dpop+jwt`, signed by the device key, carrying
 * the key's public half in its header and the request's method (`htm`), the API's address
 * (`htu`), the time (`iat`), a unique id (`jti`) and the server's nonce.
 *
 * A proof is good for one request: make a new one every time, never keep or reuse one.
 *
 * @param key - The device key.
 * @param input - The request the proof is for, and the server's nonce.
 * @returns The compact JWT for the {@link DPOP_HEADER} header.
 * @example
 * ```ts
 * const proof = await createDpopProof(key, {
 *   method: 'POST',
 *   url: 'https://auth.example.com/v1/client/sessions/refresh',
 *   nonce,
 * })
 * ```
 */
export async function createDpopProof(key: DeviceKey, input: DpopProofInput): Promise<string> {
  const header = { typ: DPOP_PROOF_TYPE, alg: DPOP_ALGORITHMS[0], jwk: key.publicJwk }
  const payload = {
    htm: input.method,
    htu: input.url,
    iat: Math.floor((input.now ?? Date.now()) / 1000),
    jti: input.jti ?? base64url(crypto.getRandomValues(new Uint8Array(16))),
    ...(input.nonce !== undefined && { nonce: input.nonce }),
  }
  const signed = `${base64url(encoder.encode(JSON.stringify(header)))}.${base64url(
    encoder.encode(JSON.stringify(payload))
  )}`
  return `${signed}.${base64url(await key.sign(encoder.encode(signed)))}`
}

/**
 * Make a device key in software, with WebCrypto: a fresh P-256 key pair whose private half is
 * **not extractable**, so the page or process that holds it can sign with it and cannot read
 * it. It lives in memory only; a client that wants it to outlive the process keeps the
 * `CryptoKey` where its platform allows (IndexedDB stores one without exposing it).
 *
 * This is what tests and the conformance runner bind with. It proves nothing about hardware:
 * a native SDK supplies its own {@link DeviceKey} backed by the Secure Enclave or StrongBox.
 *
 * @returns A key whose `sign` uses the private half.
 * @example
 * ```ts
 * const deviceKey = await generateSoftwareDeviceKey()
 * const tula = createTulaClient({ publishableKey, baseUrl, client: 'ios', deviceKey })
 * ```
 */
export async function generateSoftwareDeviceKey(): Promise<DeviceKey> {
  const algorithm = { name: 'ECDSA', namedCurve: 'P-256' }
  const pair = await crypto.subtle.generateKey(algorithm, false, ['sign'])
  const { x, y } = await crypto.subtle.exportKey('jwk', pair.publicKey)
  return {
    publicJwk: { kty: 'EC', crv: 'P-256', x: x as string, y: y as string },
    async sign(data) {
      const signature = await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        pair.privateKey,
        // A copy: its buffer is an `ArrayBuffer` whatever the caller's view was over.
        new Uint8Array(data)
      )
      return new Uint8Array(signature)
    },
  }
}
