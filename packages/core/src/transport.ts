import { CLIENT_HEADER, FLOW_ATTEMPT_HEADER, PUBLISHABLE_KEY_HEADER } from '@tula/contract/headers'
import {
  clientError,
  type ErrorParams,
  formatMessage,
  type Messages,
  ownString,
  TulaError,
  type TulaFieldError,
} from './errors'
import { OPERATIONS, type Operations } from './generated/api.gen'
import type { ClientKind, FetchLike } from './types'

/** Id of a client operation in the OpenAPI document, e.g. `startSignIn`. */
export type OperationId = keyof Operations

/**
 * What one call takes: the operation's path parameters and JSON body (each required exactly
 * when the operation has one), plus the credentials that travel in headers.
 */
export type CallInput<Id extends OperationId> = (Operations[Id]['params'] extends Record<
  string,
  never
>
  ? { params?: undefined }
  : { params: Operations[Id]['params'] }) &
  (Operations[Id]['body'] extends undefined
    ? { body?: undefined }
    : { body: Operations[Id]['body'] }) & {
    /** Sent as `Authorization: Bearer …`. */
    accessToken?: string
    /** Sent as `x-tula-attempt`. */
    attemptSecret?: string
    /** This call's own timeout, in place of the transport's. */
    timeoutMs?: number
  }

/** Sends one operation and returns its parsed answer. */
export interface Transport {
  /**
   * @param id - The operation.
   * @param input - Its path parameters, body and credentials.
   * @returns The success response's body (`undefined` for a 204).
   * @throws TulaError for every failure: an error answer, no answer, or an unreadable one.
   */
  call<Id extends OperationId>(id: Id, input: CallInput<Id>): Promise<Operations[Id]['response']>
}

/** What a {@link Transport} is built from. */
export interface TransportOptions {
  /** Origin of the API, without a trailing slash. */
  baseUrl: string
  /** The environment's publishable key. */
  publishableKey: string
  /** The client kind, sent as `x-tula-client`. */
  client: ClientKind
  /** The `fetch` to send requests through. */
  fetch: FetchLike
  /** How long one request may take before it fails with `network.timeout`. */
  timeoutMs: number
  /** The current locale table (read per error, so it can change). */
  messages: () => Messages
}

type Json = Record<string, unknown>

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readParams(value: unknown): ErrorParams {
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

function readFieldErrors(value: unknown, messages: Messages): TulaFieldError[] {
  const errors: TulaFieldError[] = []
  for (const entry of Array.isArray(value) ? value : []) {
    if (isRecord(entry) && typeof entry.field === 'string' && typeof entry.code === 'string') {
      const params = readParams(entry.params)
      // A translated message when the app's table has one; otherwise the server's own, which
      // for a validation problem says more than the code's generic message.
      const translated = ownString(messages, entry.code)
      const fallback = typeof entry.message === 'string' ? entry.message : undefined
      errors.push({
        field: entry.field,
        code: entry.code,
        message:
          translated === undefined
            ? (fallback ?? formatMessage(entry.code, { params }))
            : formatMessage(entry.code, { messages, params }),
        params,
      })
    }
  }
  return errors
}

/**
 * How long the server asked the client to wait: the `Retry-After` header (seconds or an HTTP
 * date), or the `retryAfter` param of a `rate_limited` error when the header is not readable
 * (a proxy that drops it, or a cross-origin response that does not expose it).
 */
function readRetryAfterMs(response: Response, params: ErrorParams): number | undefined {
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

function errorFromResponse(response: Response, payload: unknown, messages: Messages): TulaError {
  if (!isRecord(payload) || typeof payload.code !== 'string') {
    // Not the API's error envelope: a proxy's error page, or something that is not this API.
    return new TulaError({
      code: 'response.invalid',
      message: formatMessage('response.invalid', { messages }),
      status: response.status,
      retryAfterMs: readRetryAfterMs(response, {}),
    })
  }
  const params = readParams(payload.params)
  return new TulaError({
    code: payload.code,
    message: formatMessage(payload.code, {
      messages,
      params,
      fallback: typeof payload.detail === 'string' ? payload.detail : undefined,
    }),
    status: response.status,
    params,
    errors: readFieldErrors(payload.errors, messages),
    retryAfterMs: readRetryAfterMs(response, params),
  })
}

function buildUrl(baseUrl: string, path: string, params: Record<string, string>): string {
  return (
    baseUrl +
    path.replace(/\{(\w+)\}/g, (_placeholder, name: string) =>
      encodeURIComponent(params[name] ?? '')
    )
  )
}

/**
 * Build the transport: the one place a request is put together and an answer is read.
 *
 * It adds the publishable key and client kind, sends cookies only for the `web` kind, applies
 * the timeout, and turns every failure into a {@link TulaError}. It never retries.
 *
 * @param options - The API's address, the key, the client kind and the `fetch` to use.
 * @returns The transport.
 */
export function createTransport(options: TransportOptions): Transport {
  async function call<Id extends OperationId>(
    id: Id,
    input: CallInput<Id>
  ): Promise<Operations[Id]['response']> {
    const route = OPERATIONS[id]
    const headers = new Headers({
      accept: 'application/json',
      [PUBLISHABLE_KEY_HEADER]: options.publishableKey,
      [CLIENT_HEADER]: options.client,
    })
    if (input.body !== undefined) {
      headers.set('content-type', 'application/json')
    }
    if (input.accessToken) {
      headers.set('authorization', `Bearer ${input.accessToken}`)
    }
    if (input.attemptSecret) {
      headers.set(FLOW_ATTEMPT_HEADER, input.attemptSecret)
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? options.timeoutMs)
    let response: Response
    let payload: unknown
    try {
      response = await options.fetch(
        new Request(buildUrl(options.baseUrl, route.path, input.params ?? {}), {
          method: route.method,
          headers,
          body: input.body === undefined ? undefined : JSON.stringify(input.body),
          signal: controller.signal,
          // Only a browser client has a cookie to send (and to receive, when a flow
          // completes). The option is left out otherwise: some edge runtimes reject it.
          ...(options.client === 'web' && { credentials: 'include' as const }),
        })
      )
      // Read inside the timeout: a stalled body is the same failure as a stalled request.
      if (response.status === 204) {
        // Nothing to parse, but the (empty) body is still read to its end. A browser records a
        // fetch whose body nobody consumed as cancelled (`net::ERR_ABORTED` in the network
        // panel) when the response is collected, which made every successful sign-out and
        // password change look like a failed request. This client never aborts a request
        // that got its answer; the only abort is the timeout above.
        await response.text().catch((cause: unknown) => {
          if (controller.signal.aborted) {
            throw cause
          }
        })
        payload = undefined
      } else {
        payload = await response.json().catch((cause: unknown) => {
          // Cut off by the timeout: that is a timeout, not an unreadable answer.
          if (controller.signal.aborted) {
            throw cause
          }
          return null
        })
      }
    } catch (cause) {
      throw clientError(
        controller.signal.aborted ? 'network.timeout' : 'network.failed',
        options.messages(),
        cause
      )
    } finally {
      clearTimeout(timer)
    }

    if (!response.ok) {
      throw errorFromResponse(response, payload, options.messages())
    }
    if (payload === null) {
      throw new TulaError({
        code: 'response.invalid',
        message: formatMessage('response.invalid', { messages: options.messages() }),
        status: response.status,
      })
    }
    return payload as Operations[Id]['response']
  }

  return { call }
}
