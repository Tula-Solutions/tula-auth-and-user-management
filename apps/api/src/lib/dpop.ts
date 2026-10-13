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

/**
 * The one spelling of an address a proof may name: `http` or `https`, `://`, a host of
 * letters, digits, full stops, hyphens and underscores (or an IPv6 address in brackets; the
 * underscore because `new URL` keeps one, and a Compose service name has one), an optional
 * port in digits, and a path that starts with `/`. Scheme and host are matched whatever
 * their case. The path's characters exclude everything a URL parser would rewrite or cut
 * at: a backslash, a percent sign, `?`, `#`, a space and whatever is not printable ASCII.
 * No user info fits (`@` is not a host character). Linear: no quantifier inside another.
 */
const HTU = /^(https?):\/\/([a-z0-9._-]+|\[[0-9a-f:.]+\])(?::([0-9]{1,5}))?(\/[!-~]*)$/i

/** What a path may not hold although it is printable ASCII. */
const NOT_IN_A_PATH = /[\\%?#]/

const DEFAULT_PORTS: Record<string, string> = { http: '80', https: '443' }

/**
 * The address a proof names, in the one form addresses are compared in; `null` when it is
 * not spelt as {@link HTU} allows.
 *
 * The rule is string work on purpose, with no URL parser: a native SDK has to produce an
 * `htu` the server accepts, and "whatever a WHATWG parser makes of it" is not a rule it can
 * hold itself to. The three normalisations RFC 9449 §4.3 asks for are kept (the scheme's
 * case, the host's case, a default port written out); everything else a parser would repair
 * (a backslash for a slash, a `.` or `..` segment, a percent-encoded character, a tab, user
 * info, a query or a fragment to cut off) is refused, not repaired: a client that signs
 * something other than it was told to is not understood.
 */
function address(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const parts = HTU.exec(value)
  if (!parts) {
    return null
  }
  const scheme = (parts[1] as string).toLowerCase()
  const host = (parts[2] as string).toLowerCase()
  const port = parts[3]
  const path = parts[4] as string
  if (NOT_IN_A_PATH.test(path) || path.split('/').some((s) => s === '.' || s === '..')) {
    return null
  }
  const withPort = port === undefined || port === DEFAULT_PORTS[scheme] ? host : `${host}:${port}`
  return `${scheme}://${withPort}${path}`
}

/** The server's own address of a route, in the form {@link address} answers. */
function own(url: string): string {
  // The server's configuration, not a client's text: here the parser's reading is the rule.
  const parsed = new URL(url)
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}`
}

/**
 * Whether a proof can name one of the server's own addresses at all.
 *
 * The server's side of the comparison is what the URL parser makes of its configuration;
 * the client's side has one spelling. Where the first is not of the second's form (the
 * parser percent-encodes a space or a letter outside ASCII in a path, and a proof may hold
 * no percent sign), no client could comply, and every proof would be refused for its
 * address. A caller asks this once and says "not supported" instead.
 *
 * @param url - An address the server would expect a proof to name.
 * @returns Whether some `htu` is accepted for it.
 */
export function canBeNamed(url: string): boolean {
  if (!URL.canParse(url)) {
    return false
  }
  const expected = own(url)
  return address(expected) === expected
}

/**
 * Check a DPoP proof (RFC 9449 §4.3) for one request.
 *
 * Accepted means: a compact JWS of at most {@link MAX_DPOP_PROOF_LENGTH} characters whose
 * header says `typ: "dpop+jwt"`, an `alg` of {@link DPOP_ALGORITHMS} (`ES256` alone) and a
 * `jwk` that is a public P-256 key **and nothing else** (a key with a private member is
 * refused); whose signature verifies with that key; and whose payload names this request's
 * method (`htm`) and the API's own address of the route (`htu`: one spelling, with only the
 * scheme's and the host's case and a default port normalised; no query, fragment, user
 * info, backslash, percent sign or dot segment), an `iat` within
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
  if (signedFor === null || signedFor !== own(expected.url)) {
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
