/** Where a server with the mock OAuth provider mints an ID token for a tool. */
export const MOCK_ID_TOKEN_PATH = '/v1/dev/oauth/id-token'

/** How long one request to it may take, in milliseconds. */
const ID_TOKEN_REQUEST_TIMEOUT_MS = 5_000

/**
 * What an `idToken` step asks the mock provider to put in a token: what a provider's native
 * SDK would have handed the app, right or wrong on purpose.
 */
export interface IdTokenAsk {
  /** The provider the token is said to be from. */
  provider: string
  /** The token's `aud`: the client id it was issued for. */
  audience: string
  /** The token's `azp`: the client id of the app that asked for it. Left out, there is none. */
  authorizedParty?: string
  /** The token's `nonce`. Left out, the token carries none. */
  nonce?: string
  /** The address the provider reports. */
  email?: string
  /** The provider's id for the account. Derived from the address when left out. */
  subject?: string
  /** The provider reports the address as unverified. */
  unverified?: boolean
  /** The account's given name. */
  givenName?: string
  /** The account's family name. */
  familyName?: string
  /** The token expired before it was presented. */
  expired?: boolean
}

/**
 * Have a live server's mock OAuth provider mint ID tokens (ADR 0045).
 *
 * The server must run with `OAUTH_MOCK_PROVIDER=true` (the `local` tier and a loopback
 * `PUBLIC_URL` only), and must be reached at a loopback address: its route refuses any other
 * `Host`. A server without the mock has no such route (404), which is an error here and is
 * said without anything of the answer.
 *
 * @param baseUrl - The origin of the server, e.g. `http://localhost:3003`.
 * @param options - Injectable `fetch`, for tests.
 * @returns A function that returns the token for what it was asked.
 *
 * @example
 * ```ts
 * const idToken = devIdTokens('http://localhost:3003')
 * const token = await idToken({ provider: 'google', audience: clientId, nonce, email })
 * ```
 */
export function devIdTokens(
  baseUrl: string,
  options: { fetch?: typeof fetch } = {}
): (ask: IdTokenAsk) => Promise<string> {
  const send = options.fetch ?? fetch
  return async (ask) => {
    const response = await send(`${baseUrl}${MOCK_ID_TOKEN_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ask),
      redirect: 'error',
      signal: AbortSignal.timeout(ID_TOKEN_REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(
        `the mock provider's ID-token endpoint answered ${response.status} (is OAUTH_MOCK_PROVIDER on, and the server reached at a loopback address?)`
      )
    }
    const { idToken } = (await response.json()) as { idToken?: unknown }
    if (typeof idToken !== 'string' || idToken === '') {
      throw new Error("the mock provider's ID-token endpoint answered without a token")
    }
    return idToken
  }
}
