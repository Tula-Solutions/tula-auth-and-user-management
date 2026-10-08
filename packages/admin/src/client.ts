import {
  type AdminErrorParams,
  type AdminFieldError,
  clientError,
  defaultMessage,
  TulaAdminError,
} from './errors'
import {
  INSTANCE_OPERATIONS,
  type InstanceOperations,
  OPERATIONS,
  type OperationRoute,
  type Operations,
} from './generated/api.gen'

/** How long one request may take before it fails with `network.timeout`, by default. */
export const DEFAULT_TIMEOUT_MS = 30_000

// The contract's key prefixes (`@tula/contract`'s `SECRET_KEY_PREFIX` and
// `PUBLISHABLE_KEY_PREFIX`). Repeated here because that module is not one of the contract's
// Zod-free entry points; a test holds the two together.
const SECRET_KEY_PREFIX = 'tula_sk_'
const PUBLISHABLE_KEY_PREFIX = 'tula_pk_'
/** After the prefix: the tier, then the key. Nothing a header value could be split with. */
const SECRET_KEY_PATTERN = /^tula_sk_[a-z]+_[A-Za-z0-9_-]{16,}$/

/**
 * Id of an admin operation in the OpenAPI document, e.g. `getEnvironmentSettings`.
 *
 * @example
 * ```ts
 * const id: AdminOperationId = 'listOAuthProviders'
 * ```
 */
export type AdminOperationId = keyof Operations

/**
 * The `fetch` the client sends requests through: the platform's, or a stand-in (a test, an
 * API mounted in process).
 *
 * @example
 * ```ts
 * const inProcess: AdminFetch = (url, init) => app.request(String(url), init)
 * ```
 */
export type AdminFetch = (url: string, init?: RequestInit) => Promise<Response>

/** One part of a call's input: absent when the operation has none, required when it needs it. */
type Part<Name extends string, Value> =
  Value extends Record<string, never>
    ? { [Key in Name]?: undefined }
    : Record<string, never> extends Value
      ? { [Key in Name]?: Value }
      : { [Key in Name]: Value }

/**
 * What one call takes: the operation's path, query and header parameters and its JSON body,
 * each required exactly when the operation needs it, plus the call's own signal and timeout.
 *
 * @example
 * ```ts
 * const input: AdminCallInput<'listUsers'> = { query: { q: 'maya', page: 1 } }
 * ```
 */
export type AdminCallInput<Id extends AdminOperationId> = Part<'params', Operations[Id]['params']> &
  Part<'query', Operations[Id]['query']> &
  Part<'headers', Operations[Id]['headers']> &
  (Operations[Id]['body'] extends undefined
    ? { body?: undefined }
    : { body: Operations[Id]['body'] }) & {
    /** Cancels the call (`network.aborted`). */
    signal?: AbortSignal
    /** This call's own timeout, in place of the client's. */
    timeoutMs?: number
  }

/**
 * A successful answer.
 *
 * @example
 * ```ts
 * const { data, etag } = await admin.call('getEnvironmentSettings')
 * const revision = etagRevision(etag) ?? data.revision
 * ```
 */
export interface AdminResponse<Id extends AdminOperationId> {
  /** The response body (`undefined` for a 204). */
  readonly data: Operations[Id]['response']
  /** The HTTP status. */
  readonly status: number
  /** The `ETag` header, when the operation answers one (the settings' revision, quoted). */
  readonly etag: string | null
  /** The response's `Date` header: the server's clock when it answered, or `null`. */
  readonly date: string | null
}

/** The arguments after the operation id: optional when nothing in the input is required. */
type CallArguments<Id extends AdminOperationId> =
  Record<string, never> extends AdminCallInput<Id>
    ? [input?: AdminCallInput<Id>]
    : [input: AdminCallInput<Id>]

/**
 * The admin API, as one typed function over every `/v1/admin/*` operation.
 *
 * @example
 * ```ts
 * const { data } = await admin.call('listOAuthProviders')
 * ```
 */
export interface AdminClient {
  /**
   * Call one operation.
   *
   * @param id - The operation's id in the OpenAPI document.
   * @param input - Its parameters and body.
   * @returns The answer's body, status and `ETag`.
   * @throws TulaAdminError for every failure: an error answer, no answer, an unreadable one, or
   *   a path parameter that is not a single path segment (`client.invalid_param`, before any
   *   request).
   */
  call<Id extends AdminOperationId>(id: Id, ...input: CallArguments<Id>): Promise<AdminResponse<Id>>
}

/**
 * What an {@link AdminClient} is built from.
 *
 * @example
 * ```ts
 * const options: AdminClientOptions = {
 *   baseUrl: 'https://auth.example.com',
 *   secretKey: process.env.TULA_SECRET_KEY ?? '',
 * }
 * ```
 */
export interface AdminClientOptions {
  /** Where the Tula API is served, e.g. `https://auth.example.com`. */
  baseUrl: string
  /** The environment's secret key (`tula_sk_<env>_…`). It decides the environment. */
  secretKey: string
  /** The `fetch` to use. Defaults to the platform's. */
  fetch?: AdminFetch
  /** How long one request may take. Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number
  /** Sent as `User-Agent`, so the API's logs say which tool called. */
  userAgent?: string
  /**
   * Allow a plain `http:` `baseUrl` for a host that is not this machine. Off by default: over
   * http the secret key, and every provider secret a call carries, cross the network in clear
   * text. For a private network you trust (a service mesh, a cluster-internal address) only.
   * Loopback hosts (`localhost`, `*.localhost`, `127.0.0.1`, `[::1]`) never need it.
   */
  allowInsecureHttp?: boolean
}

type Json = Record<string, unknown>

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readParams(value: unknown): AdminErrorParams {
  const params: Record<string, string | number | boolean> = {}
  if (isRecord(value)) {
    for (const [name, param] of Object.entries(value)) {
      if (typeof param === 'string' || typeof param === 'number' || typeof param === 'boolean') {
        params[name] = param
      }
    }
  }
  return params
}

function readFieldErrors(value: unknown): AdminFieldError[] {
  const errors: AdminFieldError[] = []
  for (const entry of Array.isArray(value) ? value : []) {
    if (isRecord(entry) && typeof entry.field === 'string' && typeof entry.code === 'string') {
      errors.push({
        field: entry.field,
        code: entry.code,
        // The server's own message says which rule the field broke; the code's default is the
        // fallback for an entry without one.
        message:
          typeof entry.message === 'string'
            ? entry.message
            : (defaultMessage(entry.code) ?? entry.code),
        params: readParams(entry.params),
      })
    }
  }
  return errors
}

/**
 * How long the server asked the caller to wait: the `Retry-After` header (seconds or an HTTP
 * date), or the `retryAfter` param of the error when a proxy dropped the header.
 */
function readRetryAfterMs(response: Response, params: AdminErrorParams): number | undefined {
  const header = response.headers.get('retry-after')?.trim()
  if (header && /^\d+$/.test(header)) {
    return Number(header) * 1000
  }
  const date = header ? Date.parse(header) : Number.NaN
  if (!Number.isNaN(date)) {
    return Math.max(0, date - Date.now())
  }
  return typeof params.retryAfter === 'number' ? params.retryAfter * 1000 : undefined
}

function errorFromResponse(
  operation: string,
  response: Response,
  payload: unknown
): TulaAdminError {
  if (!isRecord(payload) || typeof payload.code !== 'string') {
    // Not the API's error envelope: a proxy's error page, a redirect, or not this API at all.
    return clientError('response.invalid', { operation, status: response.status })
  }
  const params = readParams(payload.params)
  return new TulaAdminError({
    code: payload.code,
    message:
      typeof payload.detail === 'string'
        ? payload.detail
        : (defaultMessage(payload.code) ?? payload.code),
    status: response.status,
    operation,
    params,
    errors: readFieldErrors(payload.errors),
    retryAfterMs: readRetryAfterMs(response, params),
  })
}

/** Hosts that are this machine: plain http to them never leaves it. */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return (
    host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]'
  )
}

function normalizeBaseUrl(baseUrl: string, allowInsecureHttp: boolean): string {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    throw clientError('client.invalid_url')
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
    throw clientError('client.invalid_url')
  }
  // Every request carries the secret key, and some carry a provider's secret: over http to
  // another machine both are readable on the way. A mistyped scheme must fail, not leak.
  if (url.protocol === 'http:' && !allowInsecureHttp && !isLoopbackHost(url.hostname)) {
    throw clientError('client.invalid_url')
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

function checkSecretKey(secretKey: string): void {
  if (typeof secretKey === 'string' && secretKey.startsWith(PUBLISHABLE_KEY_PREFIX)) {
    throw clientError('client.publishable_key')
  }
  if (
    typeof secretKey !== 'string' ||
    !secretKey.startsWith(SECRET_KEY_PREFIX) ||
    !SECRET_KEY_PATTERN.test(secretKey)
  ) {
    throw clientError('client.invalid_key')
  }
}

/**
 * Whether a value can stand as one path segment. `encodeURIComponent` leaves `.` and `..`
 * as they are, and `fetch` then resolves them: `/users/../ban` is sent as `/ban`, another
 * route. A slash or backslash would be encoded, but a proxy that decodes `%2F` before routing
 * splits the segment again, and no id of this API has one. Control characters have no place
 * in a path at all.
 */
function isPathSegment(value: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
  return value !== '' && value !== '.' && value !== '..' && !/[/\\\u0000-\u001f\u007f]/.test(value)
}

function buildUrl(
  operation: string,
  baseUrl: string,
  path: string,
  params: Record<string, string>,
  query: Record<string, unknown>
): string {
  const filled = path.replace(/\{(\w+)\}/g, (_placeholder, name: string) => {
    const value = Object.hasOwn(params, name) ? params[name] : undefined
    if (typeof value !== 'string' || !isPathSegment(value)) {
      // The parameter's name, never its value: what was passed may be anything.
      throw clientError('client.invalid_param', { operation, param: name })
    }
    return encodeURIComponent(value)
  })
  const search = new URLSearchParams()
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) {
      search.set(name, String(value))
    }
  }
  const text = search.toString()
  return `${baseUrl}${filled}${text === '' ? '' : `?${text}`}`
}

/** The name of whatever a failed `fetch` threw: enough to tell DNS from TLS, never a message. */
function failureName(cause: unknown): string | undefined {
  if (cause instanceof Error) {
    const code = (cause as { code?: unknown }).code
    return typeof code === 'string' ? code : cause.name
  }
  return undefined
}

interface RawResponse {
  data: unknown
  status: number
  etag: string | null
  date: string | null
}

/** What both clients share: one request, one answer, the credential as a bearer token. */
function createCaller(
  routes: Readonly<Record<string, OperationRoute>>,
  bearer: string,
  options: Pick<
    AdminClientOptions,
    'baseUrl' | 'fetch' | 'timeoutMs' | 'userAgent' | 'allowInsecureHttp'
  >
): (id: string, input: unknown) => Promise<RawResponse> {
  const globals = globalThis as { window?: unknown; document?: unknown }
  if (globals.window !== undefined && globals.document !== undefined) {
    throw clientError('client.browser')
  }
  const baseUrl = normalizeBaseUrl(options.baseUrl, options.allowInsecureHttp === true)
  const send: AdminFetch = options.fetch ?? ((url, init) => fetch(url, init))
  const defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const userAgent = options.userAgent

  return async function call(id: string, rest: unknown): Promise<RawResponse> {
    const input = (rest ?? {}) as {
      params?: Record<string, string>
      query?: Record<string, unknown>
      headers?: Record<string, string | undefined>
      body?: unknown
      signal?: AbortSignal
      timeoutMs?: number
    }
    const route = Object.hasOwn(routes, id) ? routes[id] : undefined
    if (!route) {
      throw clientError('client.invalid_param', { operation: id, param: 'operation' })
    }
    // Before anything is sent or timed: a refused parameter is the caller's mistake, not a
    // network failure.
    const url = buildUrl(id, baseUrl, route.path, input.params ?? {}, input.query ?? {})
    const headers = new Headers({ accept: 'application/json' })
    for (const [name, value] of Object.entries(input.headers ?? {})) {
      if (value !== undefined) {
        headers.set(name, value)
      }
    }
    if (userAgent) {
      headers.set('user-agent', userAgent)
    }
    if (input.body !== undefined) {
      headers.set('content-type', 'application/json')
    }
    // Last, so that nothing a caller passes as a header can stand in for the key.
    headers.set('authorization', `Bearer ${bearer}`)

    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, input.timeoutMs ?? defaultTimeoutMs)
    const abort = () => controller.abort()
    if (input.signal?.aborted) {
      controller.abort()
    }
    input.signal?.addEventListener('abort', abort)

    let response: Response
    let payload: unknown
    try {
      response = await send(url, {
        method: route.method,
        headers,
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
        signal: controller.signal,
        // The key is for `baseUrl` alone. A redirect comes back as the 3xx it is, which is
        // not an answer of this API.
        redirect: 'manual',
      })
      // Read inside the timeout: a stalled body is the same failure as a stalled request.
      const text = await response.text()
      payload = response.status === 204 || text === '' ? undefined : parseJson(text)
    } catch (cause) {
      const code = timedOut
        ? 'network.timeout'
        : controller.signal.aborted
          ? 'network.aborted'
          : 'network.failed'
      throw clientError(code, { operation: id, reason: failureName(cause) })
    } finally {
      clearTimeout(timer)
      input.signal?.removeEventListener('abort', abort)
    }

    if (!response.ok) {
      throw errorFromResponse(id, response, payload)
    }
    if (payload === null) {
      throw clientError('response.invalid', { operation: id, status: response.status })
    }
    return {
      data: payload,
      status: response.status,
      etag: response.headers.get('etag'),
      date: response.headers.get('date'),
    }
  }
}

/**
 * Create a client for the admin API (`/v1/admin/*`).
 *
 * The secret key is kept in a closure: it is not a property of the client, and no error, log
 * line or `JSON.stringify` of anything this package returns contains it. It is sent only to
 * `baseUrl` (redirects are not followed). The client never retries: a `rate_limited` error
 * carries `retryAfterMs`, and what to do with it is the caller's decision.
 *
 * **Server-side only.** A secret key can do anything in its environment. The client refuses to
 * be created where `window` and `document` exist, and the package's `browser` export condition
 * resolves to a module that throws, so a web bundle fails instead of shipping the key.
 *
 * @param options - The API's address, the secret key and, optionally, `fetch`, a timeout and a
 *   user agent.
 * @returns The client.
 * @throws TulaAdminError `client.publishable_key` for a publishable key, `client.invalid_key`
 *   for anything else that is not a secret key, `client.invalid_url` for a bad `baseUrl`
 *   (not http(s), with credentials, or plain http to a host other than this machine without
 *   `allowInsecureHttp`), `client.browser` in a browser.
 *
 * @example
 * ```ts
 * import { createAdminClient, ifMatch } from '@tula/admin'
 *
 * const admin = createAdminClient({
 *   baseUrl: 'https://auth.example.com',
 *   secretKey: process.env.TULA_SECRET_KEY ?? '',
 * })
 * const { data } = await admin.call('getEnvironmentSettings')
 * await admin.call('replaceEnvironmentSettings', {
 *   headers: { 'If-Match': ifMatch(data.revision) },
 *   body: { ...data.settings, app: { name: 'Northline', supportEmail: null } },
 * })
 * ```
 */
export function createAdminClient(options: AdminClientOptions): AdminClient {
  const globals = globalThis as { window?: unknown; document?: unknown }
  if (globals.window !== undefined && globals.document !== undefined) {
    throw clientError('client.browser')
  }
  checkSecretKey(options.secretKey)
  const send = createCaller(OPERATIONS, options.secretKey, options)
  return {
    call: <Id extends AdminOperationId>(id: Id, ...rest: CallArguments<Id>) =>
      send(id, rest[0]) as Promise<AdminResponse<Id>>,
  }
}

/** The id of an instance operation, e.g. `getInstanceDiagnostics`. */
export type InstanceOperationId = keyof InstanceOperations

/**
 * The answer of an instance call.
 *
 * @example
 * ```ts
 * const { data, date } = await instance.call('getInstanceDiagnostics')
 * ```
 */
export interface InstanceResponse<Id extends InstanceOperationId> {
  /** The response body. */
  readonly data: InstanceOperations[Id]['response']
  /** The HTTP status. */
  readonly status: number
  /** The response's `Date` header: the server's clock when it answered, or `null`. */
  readonly date: string | null
}

/**
 * The instance client: the routes about a deployment as a whole (`/v1/instance/*`).
 *
 * @example
 * ```ts
 * const { data } = await instance.call('getInstanceDiagnostics')
 * ```
 */
export interface InstanceClient {
  /**
   * Call an instance operation by its id.
   *
   * @param id - The operation id.
   * @param input - A signal and a timeout, both optional.
   * @returns The answer.
   * @throws TulaAdminError for a refused or failed call.
   */
  call<Id extends InstanceOperationId>(
    id: Id,
    input?: { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<InstanceResponse<Id>>
}

/**
 * What {@link createInstanceClient} takes.
 *
 * @example
 * ```ts
 * const options: InstanceClientOptions = { baseUrl: 'https://auth.example.com', adminToken }
 * ```
 */
export interface InstanceClientOptions
  extends Pick<
    AdminClientOptions,
    'baseUrl' | 'fetch' | 'timeoutMs' | 'userAgent' | 'allowInsecureHttp'
  > {
  /** The instance admin token: the server's `TULA_ADMIN_TOKEN`. */
  adminToken: string
}

/** The server refuses a shorter `TULA_ADMIN_TOKEN` at boot, so a shorter one is a mistake. */
const MIN_ADMIN_TOKEN_LENGTH = 32

/**
 * Create the instance client: the deployment's diagnostics, with the instance admin token
 * (`TULA_ADMIN_TOKEN`). Like the admin client it is for servers and tools only, sends the
 * token to `baseUrl` alone (no redirect is followed), refuses plain http to another machine,
 * and never puts the token in an error.
 *
 * @param options - The API's URL and the admin token.
 * @returns The client.
 * @throws TulaAdminError `client.browser` in a browser, `client.invalid_url` for an unusable
 *   URL, `client.invalid_token` for a value that cannot be an admin token (an API key, or
 *   too short).
 *
 * @example
 * ```ts
 * const instance = createInstanceClient({ baseUrl: process.env.TULA_API_URL, adminToken })
 * const { data } = await instance.call('getInstanceDiagnostics')
 * ```
 */
export function createInstanceClient(options: InstanceClientOptions): InstanceClient {
  // A browser is refused before the token is judged, as the admin client does.
  const globals = globalThis as { window?: unknown; document?: unknown }
  if (globals.window !== undefined && globals.document !== undefined) {
    throw clientError('client.browser')
  }
  const token = options.adminToken
  if (
    typeof token !== 'string' ||
    token.length < MIN_ADMIN_TOKEN_LENGTH ||
    // Printable ASCII without spaces: anything else cannot be a header value either.
    !/^[\x21-\x7e]+$/.test(token) ||
    token.startsWith(SECRET_KEY_PREFIX) ||
    token.startsWith(PUBLISHABLE_KEY_PREFIX)
  ) {
    throw clientError('client.invalid_token')
  }
  const send = createCaller(INSTANCE_OPERATIONS, token, options)
  return {
    call: <Id extends InstanceOperationId>(
      id: Id,
      input?: { signal?: AbortSignal; timeoutMs?: number }
    ) => send(id, input) as Promise<InstanceResponse<Id>>,
  }
}

/** The parsed text, or `null` when it is not JSON. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

/**
 * The `If-Match` value for a settings revision: the revision, quoted.
 *
 * @param revision - The revision that was read (`0` for an environment that saved nothing).
 * @returns The header value, e.g. `"3"`.
 *
 * @example
 * ```ts
 * await admin.call('replaceEnvironmentSettings', {
 *   headers: { 'If-Match': ifMatch(state.revision) },
 *   body,
 * })
 * ```
 */
export function ifMatch(revision: number): string {
  return `"${revision}"`
}

/**
 * The revision an `ETag` carries.
 *
 * @param etag - The header's value (`"3"`, or the weak form `W/"3"`), or `null`.
 * @returns The revision, or `null` when the value is not a quoted revision.
 *
 * @example
 * ```ts
 * etagRevision('"3"') // 3
 * ```
 */
export function etagRevision(etag: string | null): number | null {
  const match = /^(?:W\/)?"(\d+)"$/.exec(etag ?? '')
  return match ? Number(match[1]) : null
}
