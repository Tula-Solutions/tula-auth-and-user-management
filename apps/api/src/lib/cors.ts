import type { AppConfig } from '~/dependencies'

// Any port on the loopback hosts. Only honoured in the `local` tier.
const LOOPBACK_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/

/**
 * Whether an origin is on a list of allowed origins: the pure check behind every CORS decision.
 *
 * Origins match exactly, never by pattern and never as `*`, because client routes send
 * credentials (session cookies). In the `local` tier any loopback origin is allowed as well.
 * Which list applies to a request (an environment's `urls.allowedOrigins`, or the deployment's
 * `CORS_ORIGINS`) is decided in `~/middleware/cors`.
 *
 * @param origin - The request's `Origin` header (empty for same-origin and server calls).
 * @param config - The tier and the list to check against.
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
