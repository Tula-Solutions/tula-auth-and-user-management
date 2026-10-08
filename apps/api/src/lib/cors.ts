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

/**
 * Whether an origin is one of the deployment's own: the API's (`PUBLIC_URL`, which serves the
 * dashboard) or on `CORS_ORIGINS`. The rule of the operator routes (`/v1/admin/*`,
 * `/v1/instance/*`), for the CORS answer and for the dashboard's cookie alike (ADR 0032).
 *
 * Exact in every tier. The `local` tier's "any loopback origin" rule of {@link allowedOrigin}
 * is deliberately absent: cookies are not scoped by port, so any other web app on the
 * developer's machine could otherwise use a signed-in dashboard session.
 *
 * @param origin - The request's `Origin` header.
 * @param config - The deployment's public URL and its list of origins.
 * @returns Whether the origin is the deployment's.
 */
export function isDeploymentOrigin(
  origin: string,
  config: Pick<AppConfig, 'publicUrl' | 'corsOrigins'>
): boolean {
  return origin === new URL(config.publicUrl).origin || config.corsOrigins.includes(origin)
}
