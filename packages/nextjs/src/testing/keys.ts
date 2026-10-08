import { exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose'
import type { TulaServerOptions } from '../config'

// Test doubles: an environment's signing key, the JWKS the API would publish for it, and a
// fake API that answers the few routes the server side of the package calls.

export const API = 'https://api.internal:3003'
export const APP = 'http://localhost:3000'
export const ENV = 'env_1'
export const KEY = 'tula_pk_dev_0000'
export const SECRET = 'tula_sk_dev_0000'
export const ISSUER = `${API}/v1/environments/${ENV}`

export interface Signer {
  kid: string
  jwk: JWK
  /** Sign an access token; `claims` and `header` replace the defaults. */
  sign(claims?: Record<string, unknown>, header?: Record<string, unknown>): Promise<string>
}

export async function createSigner(kid = 'key-1'): Promise<Signer> {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true })
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'EdDSA', use: 'sig' }
  return {
    kid,
    jwk,
    sign(claims = {}, header = {}) {
      const now = Math.floor(Date.now() / 1000)
      return new SignJWT({
        iss: ISSUER,
        sub: 'user_1',
        aud: ENV,
        sid: 'sess_1',
        pid: 'proj_1',
        eid: ENV,
        v: 1,
        iat: now,
        exp: now + 60,
        auth_time: now,
        amr: ['pwd'],
        ...claims,
      })
        .setProtectedHeader({ alg: 'EdDSA', kid, ...header })
        .sign(privateKey)
    },
  }
}

/** A token with a JSON header and payload and no signature at all. */
export function unsignedToken(claims: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/=+$/, '').replaceAll('+', '-').replaceAll('/', '_')
  return `${encode({ alg: 'none', kid: 'key-1' })}.${encode(claims)}.`
}

export interface FakeApi {
  options: TulaServerOptions
  /** Every request received, in order. */
  requests: Request[]
  /** How many times each path was asked for. */
  count(path: string): number
  /** Replace the answer of one route (`'POST /v1/client/sessions/refresh'`). */
  on(route: string, respond: (request: Request) => Response | Promise<Response>): void
}

export function createFakeApi(signers: Signer[], overrides: TulaServerOptions = {}): FakeApi {
  const requests: Request[] = []
  const routes = new Map<string, (request: Request) => Response | Promise<Response>>()
  routes.set(`GET /v1/environments/${ENV}/.well-known/jwks.json`, () =>
    Response.json({ keys: signers.map((signer) => signer.jwk) })
  )
  return {
    requests,
    count: (path) => requests.filter((request) => new URL(request.url).pathname === path).length,
    on: (route, respond) => {
      routes.set(route, respond)
    },
    options: {
      apiUrl: API,
      publishableKey: KEY,
      environmentId: ENV,
      fetch: async (request) => {
        requests.push(request.clone())
        const route = routes.get(`${request.method} ${new URL(request.url).pathname}`)
        return route ? route(request) : new Response(null, { status: 404 })
      },
      ...overrides,
    },
  }
}
