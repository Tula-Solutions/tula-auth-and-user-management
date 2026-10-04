import { environmentIssuer, jwksUrl } from '@tula/contract/issuer'
import { DEFAULT_HANDLER_PATH } from './paths'

// Server-side configuration: read from options first, then from the process environment.
// THE CLIENT ENTRY POINT MUST NOT IMPORT THIS MODULE: it names the secret key.

/** A `fetch`: the global one, or a function that hands the request to an in-process server. */
export type FetchLike = (input: Request) => Promise<Response>

/**
 * What the server side of `@tula/nextjs` needs to know. Every field can be left out and read
 * from the environment instead; an option wins over the variable.
 *
 * @example
 * ```ts
 * const options: TulaServerOptions = {
 *   apiUrl: 'https://auth.example.com',
 *   publishableKey: 'tula_pk_live_…',
 *   environmentId: '0190…',
 * }
 * ```
 */
export interface TulaServerOptions {
  /** Where the Next.js server reaches the Tula API. `TULA_API_URL`. */
  apiUrl?: string
  /** The environment's publishable key. `NEXT_PUBLIC_TULA_PUBLISHABLE_KEY`. */
  publishableKey?: string
  /** The environment's id: the `aud` of its access tokens. `TULA_ENVIRONMENT_ID`. */
  environmentId?: string
  /**
   * The `iss` of the environment's access tokens, when the API's public URL differs from
   * `apiUrl` (the Next.js server reaches it on an internal address). `TULA_ISSUER`. Defaults
   * to `environmentIssuer(apiUrl, environmentId)`.
   */
  issuer?: string
  /**
   * A secret key (`tula_sk_…`), needed only for `stateful` session profiles: their cookie
   * cannot be verified offline, so the server asks the API. `TULA_SECRET_KEY`. Never give this
   * a `NEXT_PUBLIC_` name.
   */
  secretKey?: string
  /**
   * The app's own public origin, e.g. `https://app.example.com`. `TULA_APP_URL`. When set, it
   * decides whether a request comes from the app itself and whether cookies are `Secure`;
   * otherwise the request's `Host` (or `X-Forwarded-Host`) and scheme do.
   */
  appUrl?: string
  /** Where the route handler is mounted. Defaults to `/api/tula`. */
  path?: string
  /** Seconds a call to the API may take. Defaults to 15. */
  timeoutSeconds?: number
  /**
   * The visitor's IP address, for the API's per-IP rate limits. Defaults to the **last** entry
   * of the request's `X-Forwarded-For` (what the proxy in front of Next.js appended). Return
   * `null` when it is not known.
   */
  clientIp?: (request: Request) => string | null
  /** The `fetch` every call to the API goes through. Tests pass an in-process server. */
  fetch?: FetchLike
}

/** {@link TulaServerOptions} with every default applied and every value checked. */
export interface TulaConfig {
  /** The API's origin (and path prefix, if any), without a trailing slash. */
  apiUrl: string
  publishableKey: string
  environmentId: string
  /** The `iss` an access token must carry. */
  issuer: string
  /** Where the environment's public keys are fetched from (always under `apiUrl`). */
  jwksUrl: string
  secretKey: string | null
  /** The app's origin, when configured. */
  appOrigin: string | null
  /** The handler's mount path, without a trailing slash. */
  path: string
  timeoutMs: number
  clientIp: (request: Request) => string | null
  fetch: FetchLike
}

const DEFAULT_TIMEOUT_SECONDS = 15

/** One function for every default configuration: caches keyed by `fetch` then hold. */
const globalFetch: FetchLike = (request) => fetch(request)

const resolved = new WeakMap<TulaServerOptions, TulaConfig>()

/**
 * {@link resolveConfig}, remembered per options object: the handlers, the middleware and the
 * server helpers each resolve their options once, on first use.
 *
 * @param options - The options object; the same object gives the same configuration.
 * @returns The checked configuration.
 * @throws TypeError as {@link resolveConfig} does.
 *
 * @example
 * ```ts
 * const options = {}
 * configFor(options) === configFor(options) // true
 * ```
 */
export function configFor(options: TulaServerOptions): TulaConfig {
  let config = resolved.get(options)
  if (!config) {
    config = resolveConfig(options)
    resolved.set(options, config)
  }
  return config
}

function env(name: string): string | undefined {
  // Read through `globalThis`: the middleware may run where there is no `process` binding.
  const value = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env?.[name]
  return value === undefined || value === '' ? undefined : value
}

function required(value: string | undefined, option: string, variable: string): string {
  if (!value) {
    throw new TypeError(`@tula/nextjs: \`${option}\` is not set (option, or ${variable})`)
  }
  return value
}

function httpUrl(value: string, option: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new TypeError(`@tula/nextjs: \`${option}\` must be an absolute URL`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new TypeError(`@tula/nextjs: \`${option}\` must be an http(s) URL`)
  }
  return url
}

/** What a proxy appended last is the only `X-Forwarded-For` entry a client cannot write. */
function lastForwardedFor(request: Request): string | null {
  const last = request.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim()
  return last && /^[0-9a-fA-F:.]{2,45}$/.test(last) ? last : null
}

/**
 * Resolve the server configuration from options and the environment.
 *
 * @param options - Explicit values; anything left out is read from its variable.
 * @returns The checked configuration.
 * @throws TypeError when the API URL, the publishable key or the environment id is missing,
 *   when a URL is not http(s), or when a key is of the wrong kind.
 *
 * @example
 * ```ts
 * const config = resolveConfig({ apiUrl: 'http://localhost:3003', publishableKey, environmentId })
 * config.jwksUrl // 'http://localhost:3003/v1/environments/<id>/.well-known/jwks.json'
 * ```
 */
export function resolveConfig(options: TulaServerOptions = {}): TulaConfig {
  const api = httpUrl(
    required(options.apiUrl ?? env('TULA_API_URL'), 'apiUrl', 'TULA_API_URL'),
    'apiUrl'
  )
  const apiUrl = `${api.origin}${api.pathname.replace(/\/+$/, '')}`
  const publishableKey = required(
    options.publishableKey ?? env('NEXT_PUBLIC_TULA_PUBLISHABLE_KEY'),
    'publishableKey',
    'NEXT_PUBLIC_TULA_PUBLISHABLE_KEY'
  )
  if (!publishableKey.startsWith('tula_pk_')) {
    throw new TypeError('@tula/nextjs: `publishableKey` must be a publishable key (tula_pk_…)')
  }
  const environmentId = required(
    options.environmentId ?? env('TULA_ENVIRONMENT_ID'),
    'environmentId',
    'TULA_ENVIRONMENT_ID'
  )
  const secretKey = options.secretKey ?? env('TULA_SECRET_KEY') ?? null
  if (secretKey !== null && !secretKey.startsWith('tula_sk_')) {
    throw new TypeError('@tula/nextjs: `secretKey` must be a secret key (tula_sk_…)')
  }
  const appUrl = options.appUrl ?? env('TULA_APP_URL')
  const path = `/${(options.path ?? DEFAULT_HANDLER_PATH).replace(/^\/+|\/+$/g, '')}`
  if (!/^(\/[A-Za-z0-9._~-]+)+$/.test(path)) {
    throw new TypeError('@tula/nextjs: `path` must be a plain path such as /api/tula')
  }
  const issuerOption = options.issuer ?? env('TULA_ISSUER')
  const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS
  return {
    apiUrl,
    publishableKey,
    environmentId,
    issuer: issuerOption
      ? httpUrl(issuerOption, 'issuer').href.replace(/\/+$/, '')
      : environmentIssuer(apiUrl, environmentId),
    // Keys are always fetched from where this server reaches the API, whatever `iss` says.
    jwksUrl: jwksUrl(environmentIssuer(apiUrl, environmentId)),
    secretKey,
    appOrigin: appUrl ? httpUrl(appUrl, 'appUrl').origin : null,
    path,
    timeoutMs: Math.max(1, timeoutSeconds) * 1000,
    clientIp: options.clientIp ?? lastForwardedFor,
    fetch: options.fetch ?? globalFetch,
  }
}

/**
 * The origin the app is served on, as this request shows it.
 *
 * The configured `appUrl` when there is one. Otherwise the request's `X-Forwarded-Host` or
 * `Host` with its scheme: a page on another site cannot choose either for a visitor's browser,
 * which is what makes them usable for a same-origin check.
 *
 * @param request - The incoming request.
 * @param config - The configuration.
 * @returns The app's origin, e.g. `https://app.example.com`.
 *
 * @example
 * ```ts
 * appOrigin(new Request('http://localhost:3000/dashboard'), config) // 'http://localhost:3000'
 * ```
 */
export function appOrigin(request: Request, config: Pick<TulaConfig, 'appOrigin'>): string {
  if (config.appOrigin) {
    return config.appOrigin
  }
  const url = new URL(request.url)
  const first = (name: string) => request.headers.get(name)?.split(',')[0]?.trim() || undefined
  const host = first('x-forwarded-host') ?? first('host') ?? url.host
  const forwarded = first('x-forwarded-proto')
  const protocol =
    forwarded === 'https' || forwarded === 'http' ? forwarded : url.protocol.slice(0, -1)
  try {
    return new URL(`${protocol}://${host}`).origin
  } catch {
    return url.origin
  }
}
