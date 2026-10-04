import {
  type AdminErrorParams,
  type AdminFieldError,
  clientError,
  defaultMessage,
  TulaAdminError,
} from './errors'
import { OPERATIONS, type Operations } from './generated/api.gen'

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
   * @throws TulaAdminError for every failure: an error answer, no answer, or an unreadable one.
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

function normalizeBaseUrl(baseUrl: string): string {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    throw clientError('client.invalid_url')
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
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

function buildUrl(
  baseUrl: string,
  path: string,
  params: Record<string, string>,
  query: Record<string, unknown>
): string {
  const filled = path.replace(/\{(\w+)\}/g, (_placeholder, name: string) =>
    encodeURIComponent(Object.hasOwn(params, name) ? String(params[name]) : '')
  )
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
 *   for anything else that is not a secret key, `client.invalid_url` for a bad `baseUrl`,
 *   `client.browser` in a browser.
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
  const baseUrl = normalizeBaseUrl(options.baseUrl)
  const secretKey = options.secretKey
  const send: AdminFetch = options.fetch ?? ((url, init) => fetch(url, init))
  const defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const userAgent = options.userAgent

  async function call<Id extends AdminOperationId>(
    id: Id,
    ...rest: CallArguments<Id>
  ): Promise<AdminResponse<Id>> {
    const input = (rest[0] ?? {}) as {
      params?: Record<string, string>
      query?: Record<string, unknown>
      headers?: Record<string, string | undefined>
      body?: unknown
      signal?: AbortSignal
      timeoutMs?: number
    }
    const route = OPERATIONS[id]
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
    headers.set('authorization', `Bearer ${secretKey}`)

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
      response = await send(buildUrl(baseUrl, route.path, input.params ?? {}, input.query ?? {}), {
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
      data: payload as Operations[Id]['response'],
      status: response.status,
      etag: response.headers.get('etag'),
    }
  }

  return { call }
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
