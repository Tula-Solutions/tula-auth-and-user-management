import type { TulaConfig } from './config'
import { clearCookieLine, formatCookieHeader, isCookieValue, setCookieLine } from './cookies'
import { apiHeaders, callApi, readRequestCookies, refreshSession } from './upstream'
import { hasTimeLeft, isSessionOf, type SessionClaims, verifyAccessToken } from './verify'

// What a request's cookies amount to. The middleware runs this once per request and may
// refresh; the server helpers run the read-only half of it.

/**
 * The request header the middleware uses to hand a `stateful` session's claims to the rest of
 * the request, so the API is asked once and not once per helper.
 *
 * It is not trusted for being present. Its value is the claims with an HMAC over them and
 * over the session cookie they were verified for, keyed by the secret key; the middleware
 * also removes any copy the browser sent. A forged one fails the signature even on a route
 * the middleware does not cover.
 */
export const AUTH_HEADER = 'x-tula-auth'

/** A verified session, and its access token when it has one. */
export interface VerifiedSession {
  claims: SessionClaims
  /** The access token; `null` for a `stateful` session, which has none. */
  token: string | null
}

const encoder = new TextEncoder()

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/=+$/, '').replaceAll('+', '-').replaceAll('/', '_')
}

function fromBase64url(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    return null
  }
  try {
    const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/'))
    const bytes = new Uint8Array(new ArrayBuffer(binary.length))
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i)
    }
    return bytes
  } catch {
    return null
  }
}

function sealingKey(secretKey: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(`tula-nextjs-auth-v1:${secretKey}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  )
}

async function cookieDigest(sessionToken: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(sessionToken))
  return base64url(new Uint8Array(digest))
}

/**
 * Seal a stateful session's claims for {@link AUTH_HEADER}.
 *
 * @param secretKey - The app's secret key: the HMAC key is derived from it.
 * @param claims - The claims the API answered with.
 * @param sessionToken - The session cookie they were verified for.
 * @returns The header's value.
 *
 * @example
 * ```ts
 * headers.set(AUTH_HEADER, await sealClaims(secretKey, claims, cookies.session))
 * ```
 */
export async function sealClaims(
  secretKey: string,
  claims: SessionClaims,
  sessionToken: string
): Promise<string> {
  const body = base64url(
    encoder.encode(JSON.stringify({ claims, cookie: await cookieDigest(sessionToken) }))
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    await sealingKey(secretKey),
    encoder.encode(body)
  )
  return `${body}.${base64url(new Uint8Array(signature))}`
}

/**
 * Open a value of {@link AUTH_HEADER}.
 *
 * @param secretKey - The app's secret key.
 * @param value - The header's value, as received.
 * @param sessionToken - The session cookie of this request.
 * @param config - The configuration, for the claims' issuer and audience.
 * @returns The claims, or `null` unless the signature is this app's, the claims were sealed
 *   for this very cookie, and they are an unexpired session of this environment.
 *
 * @example
 * ```ts
 * const claims = await openClaims(secretKey, request.headers.get(AUTH_HEADER) ?? '', token, config)
 * ```
 */
export async function openClaims(
  secretKey: string,
  value: string,
  sessionToken: string,
  config: Pick<TulaConfig, 'issuer' | 'environmentId'>
): Promise<SessionClaims | null> {
  const [body = '', signature = '', ...rest] = value.split('.')
  const signed = fromBase64url(signature)
  if (rest.length > 0 || body === '' || signed === null) {
    return null
  }
  const valid = await crypto.subtle.verify(
    'HMAC',
    await sealingKey(secretKey),
    signed,
    encoder.encode(body)
  )
  if (!valid) {
    return null
  }
  try {
    const bytes = fromBase64url(body)
    const parsed = JSON.parse(new TextDecoder().decode(bytes ?? new Uint8Array())) as {
      claims?: unknown
      cookie?: unknown
    }
    if (parsed.cookie !== (await cookieDigest(sessionToken))) {
      return null
    }
    return isSessionOf(parsed.claims, config) ? parsed.claims : null
  } catch {
    return null
  }
}

/** What asking the API about a stateful session came to. */
type StatefulOutcome =
  | { status: 'verified'; claims: SessionClaims }
  | { status: 'refused' }
  | { status: 'unavailable' }

/**
 * Ask the API whether a `stateful` session's cookie is a live session.
 *
 * Such a session has no token to verify offline, so this is a network call
 * (`POST /v1/admin/sessions/verify`, with the secret key) on every request that carries the
 * cookie; the API counts it as activity on the session.
 *
 * @param request - The request to the app.
 * @param config - The configuration; without a secret key the answer is `unavailable`.
 * @param sessionToken - The session cookie's value.
 * @returns The claims, a refusal (the session is over), or `unavailable`.
 *
 * @example
 * ```ts
 * const outcome = await verifyStatefulSession(request, config, cookies.session)
 * ```
 */
export async function verifyStatefulSession(
  request: Request,
  config: TulaConfig,
  sessionToken: string
): Promise<StatefulOutcome> {
  if (!config.secretKey) {
    return { status: 'unavailable' }
  }
  const headers = apiHeaders(request, config)
  headers.set('authorization', `Bearer ${config.secretKey}`)
  headers.set('content-type', 'application/json')
  try {
    const response = await callApi(config, `${config.apiUrl}/v1/admin/sessions/verify`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ token: sessionToken }),
    })
    if (response.status === 401) {
      return { status: 'refused' }
    }
    if (response.status !== 200) {
      return { status: 'unavailable' }
    }
    const claims: unknown = await response.json()
    return isSessionOf(claims, config) ? { status: 'verified', claims } : { status: 'unavailable' }
  } catch {
    return { status: 'unavailable' }
  }
}

/**
 * Read a request's session without changing anything: what `auth()` does.
 *
 * A valid access-token cookie is a session. Otherwise a `stateful` session cookie is one when
 * the middleware's sealed claims accompany it or, failing that, when the API says so.
 *
 * @param request - The request (or a stand-in carrying its headers).
 * @param config - The configuration.
 * @returns The session, or `null` when the request is signed out.
 *
 * @example
 * ```ts
 * const session = await readSession(request, config)
 * session?.claims.sub
 * ```
 */
export async function readSession(
  request: Request,
  config: TulaConfig
): Promise<VerifiedSession | null> {
  const cookies = readRequestCookies(request, config)
  if (cookies.access) {
    const claims = await verifyAccessToken(cookies.access, config)
    if (claims) {
      return { claims, token: cookies.access }
    }
  }
  if (cookies.session && config.secretKey) {
    const sealed = request.headers.get(AUTH_HEADER)
    const known = sealed
      ? await openClaims(config.secretKey, sealed, cookies.session, config)
      : null
    if (known) {
      return { claims: known, token: null }
    }
    const outcome = await verifyStatefulSession(request, config, cookies.session)
    if (outcome.status === 'verified') {
      return { claims: outcome.claims, token: null }
    }
  }
  return null
}

/** What the middleware does with a request once its session is known. */
export interface ResolvedSession {
  session: VerifiedSession | null
  /** `Set-Cookie` lines for the response: rotated cookies, or removals. */
  setCookies: string[]
  /**
   * The request headers the rest of the request must see: the browser's, without
   * {@link AUTH_HEADER}, with the cookies as they are after this resolution.
   */
  requestHeaders: Headers
}

/**
 * Work out a request's session, refreshing it once if its access token is missing, invalid or
 * about to expire and the browser sent a refresh cookie.
 *
 * - A refreshed session's cookies are returned for the response **and** written into the
 *   request's own `Cookie` header, so server components of the same request see the new
 *   token.
 * - A refresh the API refuses ends the session: its cookies are removed from both.
 * - A refresh that could not be made (no answer, 429, 5xx) changes nothing: the request is
 *   signed out, the cookies stay for the next one.
 * - A `stateful` session is verified by the API when a secret key is configured, and its
 *   claims travel in {@link AUTH_HEADER}.
 *
 * @param request - The request to the app.
 * @param config - The configuration.
 * @returns The session, the cookies to set and the headers to pass on.
 *
 * @example
 * ```ts
 * const { session, setCookies, requestHeaders } = await resolveSession(request, config)
 * ```
 */
export async function resolveSession(
  request: Request,
  config: TulaConfig
): Promise<ResolvedSession> {
  const cookies = readRequestCookies(request, config)
  const { names, secure } = cookies
  const requestHeaders = new Headers(request.headers)
  // Whatever the browser sent under this name is not ours.
  requestHeaders.delete(AUTH_HEADER)
  const setCookies: string[] = []
  const jar = new Map(cookies.all)
  const finish = (session: VerifiedSession | null): ResolvedSession => {
    const cookie = formatCookieHeader(jar)
    if (cookie === null) {
      requestHeaders.delete('cookie')
    } else {
      requestHeaders.set('cookie', cookie)
    }
    return { session, setCookies, requestHeaders }
  }
  const drop = (name: string) => {
    jar.delete(name)
    setCookies.push(clearCookieLine(name, secure))
  }

  /** A token that verifies but is about to expire: used only if no newer one can be had. */
  let expiring: VerifiedSession | null = null
  if (cookies.access) {
    const claims = await verifyAccessToken(cookies.access, config)
    if (claims && (hasTimeLeft(claims) || !cookies.refresh)) {
      return finish({ claims, token: cookies.access })
    }
    if (claims) {
      expiring = { claims, token: cookies.access }
    }
  }

  if (cookies.refresh) {
    const outcome = await refreshSession(request, config, cookies.refresh)
    if (outcome.status === 'refused') {
      drop(names.refresh)
      if (cookies.access) {
        drop(names.access)
      }
      return finish(null)
    }
    if (outcome.status === 'refreshed') {
      const { accessToken, accessTokenMaxAge } = outcome.session
      // The answer is verified like any other token before it becomes this request's session.
      const claims = isCookieValue(accessToken)
        ? await verifyAccessToken(accessToken, config)
        : null
      if (outcome.refresh) {
        jar.set(names.refresh, outcome.refresh.value)
        setCookies.push(
          setCookieLine(names.refresh, outcome.refresh.value, {
            secure,
            maxAge: outcome.refresh.maxAge,
          })
        )
      }
      if (claims) {
        jar.set(names.access, accessToken)
        setCookies.push(
          setCookieLine(names.access, accessToken, { secure, maxAge: accessTokenMaxAge })
        )
        return finish({ claims, token: accessToken })
      }
    }
    return finish(expiring)
  }

  if (cookies.session && config.secretKey) {
    const outcome = await verifyStatefulSession(request, config, cookies.session)
    if (outcome.status === 'verified') {
      requestHeaders.set(
        AUTH_HEADER,
        await sealClaims(config.secretKey, outcome.claims, cookies.session)
      )
      return finish({ claims: outcome.claims, token: null })
    }
    if (outcome.status === 'refused') {
      drop(names.session)
    }
  }
  return finish(null)
}
