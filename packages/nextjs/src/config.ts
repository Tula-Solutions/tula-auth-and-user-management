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
   * Allow `secretKey` to be sent to an `apiUrl` that is plain `http:` and not this machine.
   * `TULA_ALLOW_INSECURE_HTTP=true`. Off by default: over http the key crosses the network in
   * clear text, so a mistyped scheme must fail instead. For a private network you trust (a
   * cluster-internal address) only; `localhost`, `*.localhost`, `127.0.0.1` and `[::1]`
   * never need it.
   */
  allowInsecureHttp?: boolean
  /**
   * The app's own public origin, e.g. `https://app.example.com`. `TULA_APP_URL`. When set, it
   * decides whether a request comes from the app itself and whether cookies are `Secure`;
   * otherwise the request's `Host` (or `X-Forwarded-Host`) and scheme do.
   */
  appUrl?: string
  /** Where the route handler is mounted. Defaults to `/api/tula`. */
  path?: string
  /**
   * Seconds a call to the API may take. Defaults to 15. A session refresh never waits longer
   * than 8 seconds, whatever this says: it has to give up, and be repeated once, inside the
   * API's refresh reuse grace window (10 seconds at the least).
   */
  timeoutSeconds?: number
  /**
   * How many proxies in front of this server append the address they received the request
   * from to `X-Forwarded-For` (a load balancer, a CDN, the platform's router).
   * `TULA_TRUSTED_PROXY_HOPS`. Defaults to `0`.
   *
   * With `0` no forwarding header is believed, because anyone who can reach this server
   * directly can write one, and **no visitor address is sent to the API**: it sees this
   * server's address for every visitor, so they share one per-IP rate limit. With `N` the
   * visitor's address is the `N`th entry from the right, the one the outermost trusted proxy
   * appended; entries to its left are whatever the visitor sent and are ignored. Set it too
   * high and a visitor chooses their own address: per-IP rate limits, lockout and the
   * addresses in the audit log then mean nothing.
   */
  trustedProxyHops?: number
  /**
   * The visitor's IP address, for the API's per-IP rate limits, on a platform that states it
   * in a header of its own. Replaces `trustedProxyHops`. Return `null` when it is not known.
   * Only read a header the platform itself sets or overwrites.
   */
  clientIp?: (request: Request) => string | null
  /**
   * Where this package's warnings go: one line each, about a likely misconfiguration, never
   * with a token, a key or a cookie in it. Defaults to `console.warn`.
   */
  onWarning?: (message: string) => void
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
  /**
   * Report a likely misconfiguration, once per `key` for the life of the process: these are
   * found on the request path, and a line per request would bury everything else.
   */
  warn: (key: string, message: string) => void
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

/** Hosts that are this machine: plain http to them never leaves it. */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return (
    host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]'
  )
}

/**
 * How the visitor's address is read from `X-Forwarded-For` behind `hops` trusted proxies.
 *
 * Each proxy appends the address it received the request from, so the entry `hops` from the
 * right is the one the outermost trusted proxy wrote. Everything to its left arrived with the
 * request and is the visitor's to choose; with no trusted proxy that is the whole header.
 */
function forwardedFor(hops: number): (request: Request) => string | null {
  if (hops === 0) {
    return () => null
  }
  return (request) => {
    const entries = request.headers.get('x-forwarded-for')?.split(',') ?? []
    const entry = entries.at(-hops)?.trim()
    return entry && /^[0-9a-fA-F:.]{2,45}$/.test(entry) ? entry : null
  }
}

function proxyHops(option: number | undefined): number {
  const variable = env('TULA_TRUSTED_PROXY_HOPS')
  const hops =
    option ?? (variable !== undefined && /^\d+$/.test(variable) ? Number(variable) : variable)
  if (hops === undefined) {
    return 0
  }
  if (typeof hops !== 'number' || !Number.isSafeInteger(hops) || hops < 0) {
    throw new TypeError(
      '@tula/nextjs: `trustedProxyHops` must be a whole number, 0 or more (option, or TULA_TRUSTED_PROXY_HOPS)'
    )
  }
  return hops
}

function consoleWarning(message: string): void {
  // biome-ignore lint/suspicious/noConsole: a library has no logger of its own; `onWarning` replaces this.
  console.warn(message)
}

/** Which warnings have been given: by the default sink, and by each `onWarning`. */
interface Warned {
  console: Set<string>
  custom: WeakMap<(message: string) => void, Set<string>>
}

const WARNED = Symbol.for('@tula/nextjs:warned')

/**
 * The record of warnings given, kept on `globalThis`: Next.js loads the handler, the
 * interceptor and the server helpers as separate bundles, each with its own copy of this
 * module, and "once per process" has to hold across them.
 */
function warned(): Warned {
  const store = globalThis as { [WARNED]?: Warned }
  if (!store[WARNED]) {
    store[WARNED] = { console: new Set(), custom: new WeakMap() }
  }
  return store[WARNED]
}

function warnOnce(custom: ((message: string) => void) | undefined): TulaConfig['warn'] {
  return (key, message) => {
    const record = warned()
    let keys = custom ? record.custom.get(custom) : record.console
    if (!keys) {
      keys = new Set()
      if (custom) {
        record.custom.set(custom, keys)
      }
    }
    if (!keys.has(key)) {
      keys.add(key)
      ;(custom ?? consoleWarning)(`@tula/nextjs: ${message}`)
    }
  }
}

/**
 * Resolve the server configuration from options and the environment.
 *
 * @param options - Explicit values; anything left out is read from its variable.
 * @returns The checked configuration.
 * @throws TypeError when the API URL, the publishable key or the environment id is missing,
 *   when a URL is not http(s), when a key is of the wrong kind, when a secret key would be
 *   sent over plain http to a host other than this machine without `allowInsecureHttp`, or
 *   when `trustedProxyHops` is not a whole number of 0 or more.
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
  // The key is sent to `apiUrl` on every request of a stateful session. Over http to another
  // machine it is readable on the way.
  const insecureHttp = options.allowInsecureHttp ?? env('TULA_ALLOW_INSECURE_HTTP') === 'true'
  if (
    secretKey !== null &&
    api.protocol === 'http:' &&
    !isLoopbackHost(api.hostname) &&
    !insecureHttp
  ) {
    throw new TypeError(
      '@tula/nextjs: `apiUrl` is plain http and `secretKey` is set: the key would cross the ' +
        'network in clear text. Use an https URL, or, on a private network you trust, set ' +
        '`allowInsecureHttp` (TULA_ALLOW_INSECURE_HTTP=true)'
    )
  }
  const appUrl = options.appUrl ?? env('TULA_APP_URL')
  const path = `/${(options.path ?? DEFAULT_HANDLER_PATH).replace(/^\/+|\/+$/g, '')}`
  if (!/^(\/[A-Za-z0-9._~-]+)+$/.test(path)) {
    throw new TypeError('@tula/nextjs: `path` must be a plain path such as /api/tula')
  }
  const issuerOption = options.issuer ?? env('TULA_ISSUER')
  const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS
  const hops = proxyHops(options.trustedProxyHops)
  const warn = warnOnce(options.onWarning)
  // NODE_ENV, not a tier of ours: it is the one thing a Next.js server knows about where it
  // runs, and it only decides whether to say this. In development it would be noise.
  if (hops === 0 && !options.clientIp && env('NODE_ENV') === 'production') {
    warn(
      'no-visitor-address',
      'no visitor address is sent to the Tula API (trustedProxyHops is 0 and there is no ' +
        "clientIp), so every visitor shares this server's address there and one per-IP rate " +
        'limit. If a proxy in front of this server appends to X-Forwarded-For, set ' +
        'TULA_TRUSTED_PROXY_HOPS to the number of such proxies.'
    )
  }
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
    clientIp: options.clientIp ?? forwardedFor(hops),
    warn,
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
