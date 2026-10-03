import { durationToMs } from '@tula/contract'
import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { AppConfig } from '~/dependencies'
import { profile } from '~/modules/session/service'

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
 * request that doesn't need it. It lives as long as the session's idle timeout.
 *
 * @param c - The request context.
 * @param config - Public URL of the API.
 * @param environmentId - The session's environment.
 * @param refreshToken - The token to store.
 */
export function setRefreshCookie(
  c: Context,
  config: CookieConfig,
  environmentId: string,
  refreshToken: string
): void {
  setCookie(c, refreshCookieName(config, environmentId), refreshToken, {
    httpOnly: true,
    secure: isSecure(config),
    sameSite: 'Lax',
    path: REFRESH_COOKIE_PATH,
    maxAge: durationToMs(profile().idleTimeout) / 1000,
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
