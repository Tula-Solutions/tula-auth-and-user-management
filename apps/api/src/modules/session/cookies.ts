import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { AppConfig } from '~/dependencies'

/**
 * Path the refresh cookie is sent to: only the endpoints under `/v1/client/sessions` (refresh,
 * sign-out and the device list, which ignores it), never the rest of the API.
 */
export const REFRESH_COOKIE_PATH = '/v1/client/sessions'

type CookieConfig = Pick<AppConfig, 'publicUrl'>

/** Cookies are `Secure` whenever the API is served over https (always, outside local dev). */
function isSecure(config: CookieConfig): boolean {
  return new URL(config.publicUrl).protocol === 'https:'
}

/**
 * Name of the refresh-token cookie for an environment.
 *
 * One API host can serve several environments, so the environment id is part of the name. Over
 * https it carries the `__Secure-` prefix, which browsers only accept from secure origins, so a
 * plain-http sibling subdomain cannot overwrite it.
 *
 * @param config - Public URL of the API.
 * @param environmentId - The environment the session belongs to.
 * @returns The cookie name.
 */
export function refreshCookieName(config: CookieConfig, environmentId: string): string {
  return `${isSecure(config) ? '__Secure-' : ''}tula_rt_${environmentId}`
}

/**
 * Deliver a refresh token to a browser as a cookie JavaScript cannot read.
 *
 * `SameSite=Lax` keeps it off cross-site POSTs (CSRF), and the narrow path keeps it off every
 * request that doesn't need it. It lives as long as the idle timeout of the session's profile
 * (`maxAge`), and is set again at every rotation.
 *
 * @param c - The request context.
 * @param config - Public URL of the API.
 * @param environmentId - The session's environment.
 * @param refreshToken - The token to store.
 * @param maxAge - How long the browser keeps it, in seconds: the profile's idle timeout.
 */
export function setRefreshCookie(
  c: Context,
  config: CookieConfig,
  environmentId: string,
  refreshToken: string,
  maxAge: number
): void {
  setCookie(c, refreshCookieName(config, environmentId), refreshToken, {
    httpOnly: true,
    secure: isSecure(config),
    sameSite: 'Lax',
    path: REFRESH_COOKIE_PATH,
    maxAge,
  })
}

/**
 * Remove the refresh cookie (sign-out, or the token turned out to be unusable).
 *
 * @param c - The request context.
 * @param config - Public URL of the API.
 * @param environmentId - The session's environment.
 */
export function clearRefreshCookie(c: Context, config: CookieConfig, environmentId: string): void {
  deleteCookie(c, refreshCookieName(config, environmentId), {
    secure: isSecure(config),
    path: REFRESH_COOKIE_PATH,
  })
}

/**
 * @param c - The request context.
 * @param config - Public URL of the API.
 * @param environmentId - The environment the request resolved to.
 * @returns The refresh token from that environment's cookie, if present.
 */
export function readRefreshCookie(
  c: Context,
  config: CookieConfig,
  environmentId: string
): string | undefined {
  return getCookie(c, refreshCookieName(config, environmentId)) || undefined
}

/**
 * Path of a `stateful` session's cookie: the whole host.
 *
 * Unlike the refresh cookie it must reach every `/v1/client/*` route, because it is what
 * authenticates them. It is not narrowed to `/v1/client` for two reasons: the `__Host-` prefix
 * requires `Path=/`, and a deployment that serves the API under the application's own host (a
 * reverse proxy) needs the application's backend to receive the cookie, so that it can check
 * it with `POST /v1/admin/sessions/verify` (ADR 0028).
 */
export const SESSION_COOKIE_PATH = '/'

/**
 * Name of the cookie that holds a `stateful` session's token, for an environment.
 *
 * Over https it carries the `__Host-` prefix: browsers then accept it only from a secure
 * origin, with `Path=/` and **no `Domain`**, so no sibling subdomain can set or overwrite it
 * (which the weaker `__Secure-` prefix of the refresh cookie would allow).
 *
 * @param config - Public URL of the API.
 * @param environmentId - The environment the session belongs to.
 * @returns The cookie name.
 */
export function sessionCookieName(config: CookieConfig, environmentId: string): string {
  return `${isSecure(config) ? '__Host-' : ''}tula_session_${environmentId}`
}

/**
 * Give a browser its `stateful` session: a cookie JavaScript cannot read, and the only thing
 * the browser holds of the session.
 *
 * `SameSite=Lax` keeps it off every cross-site request except a top-level navigation; what
 * else stops another site from using it is in `requestMayUseSessionCookie`
 * (`~/middleware/cors`). The cookie is not set again while the session lives, so it is kept
 * until the session's absolute limit; the server's idle timeout ends the session before that.
 *
 * @param c - The request context.
 * @param config - Public URL of the API.
 * @param environmentId - The session's environment.
 * @param sessionToken - The session's token.
 * @param maxAge - How long the browser keeps it, in seconds.
 */
export function setSessionCookie(
  c: Context,
  config: CookieConfig,
  environmentId: string,
  sessionToken: string,
  maxAge: number
): void {
  setCookie(c, sessionCookieName(config, environmentId), sessionToken, {
    httpOnly: true,
    secure: isSecure(config),
    sameSite: 'Lax',
    path: SESSION_COOKIE_PATH,
    maxAge,
  })
}

/**
 * Remove the session cookie (sign-out, or the session it names has ended).
 *
 * @param c - The request context.
 * @param config - Public URL of the API.
 * @param environmentId - The session's environment.
 */
export function clearSessionCookie(c: Context, config: CookieConfig, environmentId: string): void {
  deleteCookie(c, sessionCookieName(config, environmentId), {
    secure: isSecure(config),
    path: SESSION_COOKIE_PATH,
  })
}

/**
 * @param c - The request context.
 * @param config - Public URL of the API.
 * @param environmentId - The environment the request resolved to.
 * @returns The session token from that environment's session cookie, if present.
 */
export function readSessionCookie(
  c: Context,
  config: CookieConfig,
  environmentId: string
): string | undefined {
  return getCookie(c, sessionCookieName(config, environmentId)) || undefined
}
