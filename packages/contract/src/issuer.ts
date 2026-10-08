// Where an environment's access tokens come from and where their keys are published. This
// module imports nothing (no Zod), so an SDK that verifies tokens (`@tula/nextjs`) can use it
// without a schema library in its bundle: `@tula/contract/issuer`.

/**
 * The issuer (`iss`) of an environment's access tokens: its URL under the API.
 *
 * Standard JWKS clients fetch keys from a URL with no custom headers, so the environment is part
 * of the path, and the key set lives at {@link jwksUrl} of the issuer (OIDC-style discovery).
 *
 * @param apiUrl - The API's public base URL, e.g. `https://auth.example.com`.
 * @param environmentId - The environment id.
 * @returns The issuer URL, without a trailing slash.
 *
 * @example
 * ```ts
 * environmentIssuer('https://auth.example.com/', 'env_1')
 * // 'https://auth.example.com/v1/environments/env_1'
 * ```
 */
export function environmentIssuer(apiUrl: string, environmentId: string): string {
  return `${apiUrl.replace(/\/+$/, '')}/v1/environments/${encodeURIComponent(environmentId)}`
}

/**
 * Where an issuer publishes its public signing keys.
 *
 * @param issuer - The token's `iss` claim.
 * @returns The JWKS URL.
 *
 * @example
 * ```ts
 * jwksUrl('https://auth.example.com/v1/environments/env_1')
 * // 'https://auth.example.com/v1/environments/env_1/.well-known/jwks.json'
 * ```
 */
export function jwksUrl(issuer: string): string {
  return `${issuer.replace(/\/+$/, '')}/.well-known/jwks.json`
}
