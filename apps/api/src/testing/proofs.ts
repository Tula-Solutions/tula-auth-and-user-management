import {
  createDpopProof,
  type DeviceKey,
  DPOP_HEADER,
  DPOP_NONCE_HEADER,
  generateSoftwareDeviceKey,
  jwkThumbprint,
} from '@tula/contract'
import { TEST_CONFIG } from '~/testing'

// Test support for device binding (ADR 0043): software keys, and proofs made right or made
// wrong on purpose. Never imported by the server's own code.

export { DPOP_HEADER, DPOP_NONCE_HEADER, generateSoftwareDeviceKey, jwkThumbprint }

/** The path of the refresh route. */
export const REFRESH_PATH = '/v1/client/sessions/refresh'

/** The API's own address of a route, as a proof must name it. */
export function addressOf(path: string, publicUrl = TEST_CONFIG.publicUrl): string {
  return `${publicUrl}${path}`
}

function base64url(value: string | Uint8Array): string {
  return Buffer.from(value).toString('base64url')
}

/** What a hand-made proof may get wrong. */
export interface CraftedProof {
  /** Members merged over the header (`typ`, `alg`, `jwk`); `undefined` removes one. */
  header?: Record<string, unknown>
  /** Members merged over the payload; `undefined` removes one. */
  payload?: Record<string, unknown>
  /** Sign with this key instead of the one the header carries. */
  signWith?: DeviceKey
  /** Replace the signature outright. */
  signature?: string
}

/**
 * A proof built member by member, so that a test can get exactly one thing wrong. Without
 * overrides it is a valid proof for `POST` to the refresh route at `now`.
 */
export async function craftProof(
  key: DeviceKey,
  base: { now: Date; nonce?: string; path?: string; method?: string },
  wrong: CraftedProof = {}
): Promise<string> {
  const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: key.publicJwk, ...wrong.header }
  const payload = {
    htm: base.method ?? 'POST',
    htu: addressOf(base.path ?? REFRESH_PATH),
    iat: Math.floor(base.now.getTime() / 1000),
    jti: Bun.randomUUIDv7(),
    ...(base.nonce !== undefined && { nonce: base.nonce }),
    ...wrong.payload,
  }
  const signed = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`
  const signature =
    wrong.signature ??
    base64url(await (wrong.signWith ?? key).sign(new TextEncoder().encode(signed)))
  return `${signed}.${signature}`
}

/** A valid proof, made the way a client makes one. */
export function proofFor(
  key: DeviceKey,
  input: { now: Date; nonce?: string; path?: string; method?: string; jti?: string }
): Promise<string> {
  return createDpopProof(key, {
    method: input.method ?? 'POST',
    url: addressOf(input.path ?? REFRESH_PATH),
    nonce: input.nonce,
    jti: input.jti,
    now: input.now.getTime(),
  })
}
