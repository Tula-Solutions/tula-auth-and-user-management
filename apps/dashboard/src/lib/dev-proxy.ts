/**
 * The `Origin` the dev server's proxy presents to the API for one request (`vite dev` only).
 *
 * The API honours a dashboard request from its own origin or the deployment's `CORS_ORIGINS`
 * and from nowhere else, in every tier (ADR 0032): cookies are not scoped by port, so "any
 * loopback origin" would let every other local web app use a signed-in session. The dev page
 * is served on another port than the API, so its own calls are presented as the API's origin.
 * Only its own: a request that reached the dev server from any other origin keeps that
 * origin and is refused by the API, so the proxy cannot be used to launder one.
 *
 * @param origin - The request's `Origin` header, if it has one.
 * @param devPort - The port the dev server listens on.
 * @param apiOrigin - The API's origin (its `PUBLIC_URL`).
 * @returns The origin to send to the API.
 */
export function originForApi(
  origin: string | undefined,
  devPort: number,
  apiOrigin: string
): string | undefined {
  const own = ['localhost', '127.0.0.1', '[::1]'].map((host) => `http://${host}:${devPort}`)
  return origin !== undefined && own.includes(origin) ? apiOrigin : origin
}
