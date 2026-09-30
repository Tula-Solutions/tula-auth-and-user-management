import type { AppConfig } from '~/dependencies'

// Any port on the loopback hosts. Only honoured in the `local` tier.
const LOOPBACK_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/

/**
 * Decide the `Access-Control-Allow-Origin` value for a request.
 *
 * Origins are echoed only on an exact match, never with `*`, because client routes send
 * credentials (session cookies). Per-environment origin lists move to project config in Phase 1.
 *
 * @param origin - The request's `Origin` header (empty for same-origin and server calls).
 * @param config - Tier and allowed origins.
 * @returns The origin to allow, or `null` to send no CORS header (the browser then blocks it).
 */
export function allowedOrigin(
  origin: string,
  config: Pick<AppConfig, 'tier' | 'corsOrigins'>
): string | null {
  if (!origin) {
    return null
  }
  if (config.corsOrigins.includes(origin)) {
    return origin
  }
  if (config.tier === 'local' && LOOPBACK_ORIGIN.test(origin)) {
    return origin
  }
  return null
}
