import {
  DPOP_ALGORITHMS,
  DPOP_PROOF_TYPE,
  isDevicePublicJwk,
  jwkThumbprint,
  MAX_DPOP_PROOF_LENGTH,
} from '@tula/contract'
import { compactVerify, decodeProtectedHeader, importJWK } from 'jose'

// The check of a device-binding proof (ADR 0043): RFC 9449's DPoP proof JWT, read by this one
// function. It knows nothing of sessions, nonces or replays: it says whether a string is a
// proof for a given request, signed by the key it carries, and which key that is. What the
// key must be, whether the nonce is the server's and whether the id was seen before are the
// caller's questions (`~/modules/session/device-binding`).

/**
 * How far a proof's `iat` may be from the server's clock, either way: five minutes. A proof
 * is tied to the present by the server's nonce; this is the second, coarser bound, wide enough
 * for a phone whose clock is a few minutes off and far too narrow to keep a proof for later.
 */
export const DPOP_IAT_TOLERANCE_MS = 5 * 60_000

/**
 * A proof's `jti`: 16 to 128 characters of the unreserved set, which a UUID and the base64url
 * of sixteen random bytes both are. Shorter is not unique enough to be remembered by; longer
 * is nothing a client needs.
 */
const JTI = /^[A-Za-z0-9._~-]{16,128}$/

/** Longest nonce read from a proof. The server's own are 64 characters. */
const MAX_NONCE_LENGTH = 128

/**
 * Why a string was not accepted as a proof. **For the log only**: every one of them is the
 * same answer to a client.
 */
export type ProofFailure =
  /** Not a compact JWS with a JSON object as payload, or longer than the cap. */
  | 'malformed'
  /** `typ` is not `dpop+jwt`. */
  | 'type'
  /** `alg` is not on the closed list. */
  | 'algorithm'
  /** `jwk` is not a public P-256 key and nothing else, or is not a point on the curve. */
  | 'key'
  /** The signature does not verify with the key in the header. */
  | 'signature'
  /** `htm` is not the request's method. */
  | 'method'
  /** `htu` is not the API's address of the route. */
  | 'address'
  /** `iat` is missing, not a whole number, or too far from the clock. */
  | 'issued_at'
  /** `jti` is missing or not of the accepted shape. */
  | 'id'
  /** `nonce` is present and is not a short string. */
  | 'nonce'

/** What a valid proof says. */
export interface VerifiedProof {
  /** The RFC 7638 thumbprint of the key that signed it. */
  thumbprint: string
  /** Its unique id. */
  jti: string
  /** The nonce it carries, or `null` for none. Not judged here. */
  nonce: string | null
}

/** The request a proof must be for. */
export interface ProofExpectation {
  /** The request's method. */
  method: string
  /** The API's own address of the route: no query, no fragment. */
  url: string
  /** The server's clock. */
  now: Date
}

/** The outcome of {@link verifyProof}. */
export type ProofVerdict = { ok: true; proof: VerifiedProof } | { ok: false; reason: ProofFailure }

const refuse = (reason: ProofFailure): ProofVerdict => ({ ok: false, reason })

/** The address a proof names, normalised as the URL parser does; `null` when it is none. */
function address(value: unknown): string | null {
  if (typeof value !== 'string' || !URL.canParse(value)) {
    return null
  }
  const url = new URL(value)
  // RFC 9449: the target without query and fragment. One that carries either is refused, not
  // trimmed: a client that signs something else than it was told to is not understood.
  if (url.search !== '' || url.hash !== '' || value.includes('?') || value.includes('#')) {
    return null
  }
  return url.href
}

/**
 * Check a DPoP proof (RFC 9449 §4.3) for one request.
 *
 * Accepted means: a compact JWS of at most {@link MAX_DPOP_PROOF_LENGTH} characters whose
 * header says `typ: "dpop+jwt"`, an `alg` of {@link DPOP_ALGORITHMS} (`ES256` alone) and a
 * `jwk` that is a public P-256 key **and nothing else** (a key with a private member is
 * refused); whose signature verifies with that key; and whose payload names this request's
 * method (`htm`) and the API's own address of the route (`htu`, compared after the URL
 * parser's normalisation, with no query and no fragment), an `iat` within
 * {@link DPOP_IAT_TOLERANCE_MS} of `now`, and a `jti`.
 *
 * It never throws and never logs: nothing of a proof, valid or not, leaves this function but
 * the verdict.
 *
 * @param proof - The value of the `DPoP` header.
 * @param expected - The request the proof must be for, and the clock.
 * @returns The key's thumbprint, the id and the nonce; or a fixed word saying why not.
 */
export async function verifyProof(
  proof: string,
  expected: ProofExpectation
): Promise<ProofVerdict> {
  if (proof.length > MAX_DPOP_PROOF_LENGTH || proof.split('.').length !== 3) {
    return refuse('malformed')
  }
  let header: ReturnType<typeof decodeProtectedHeader>
  try {
    header = decodeProtectedHeader(proof)
  } catch {
    return refuse('malformed')
  }
  if (header.typ !== DPOP_PROOF_TYPE) {
    return refuse('type')
  }
  const algorithms: readonly string[] = DPOP_ALGORITHMS
  if (typeof header.alg !== 'string' || !algorithms.includes(header.alg)) {
    return refuse('algorithm')
  }
  const jwk: unknown = header.jwk
  if (!isDevicePublicJwk(jwk)) {
    return refuse('key')
  }
  let key: Awaited<ReturnType<typeof importJWK>>
  try {
    key = await importJWK({ ...jwk }, header.alg)
  } catch {
    // Well-formed coordinates that are no point on the curve.
    return refuse('key')
  }
  let payload: unknown
  try {
    const verified = await compactVerify(proof, key, { algorithms: [...DPOP_ALGORITHMS] })
    payload = JSON.parse(new TextDecoder().decode(verified.payload))
  } catch {
    return refuse('signature')
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return refuse('malformed')
  }
  const claims = payload as Record<string, unknown>
  if (claims.htm !== expected.method) {
    return refuse('method')
  }
  const signedFor = address(claims.htu)
  if (signedFor === null || signedFor !== new URL(expected.url).href) {
    return refuse('address')
  }
  if (
    typeof claims.iat !== 'number' ||
    !Number.isSafeInteger(claims.iat) ||
    Math.abs(claims.iat * 1000 - expected.now.getTime()) > DPOP_IAT_TOLERANCE_MS
  ) {
    return refuse('issued_at')
  }
  if (typeof claims.jti !== 'string' || !JTI.test(claims.jti)) {
    return refuse('id')
  }
  if (
    claims.nonce !== undefined &&
    (typeof claims.nonce !== 'string' || claims.nonce.length > MAX_NONCE_LENGTH)
  ) {
    return refuse('nonce')
  }
  return {
    ok: true,
    proof: {
      thumbprint: await jwkThumbprint(jwk),
      jti: claims.jti,
      nonce: claims.nonce ?? null,
    },
  }
}
