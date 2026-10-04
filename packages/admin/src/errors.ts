import { ERROR_DEFINITIONS, type ErrorCode } from '@tula/contract/error-codes'

/**
 * Codes for failures that happen in the client, before or instead of an API answer. `status` is
 * `0` for the ones raised before a request is sent.
 */
const CLIENT_MESSAGES = {
  'network.failed': 'Could not reach the Tula API.',
  'network.timeout': 'The Tula API took too long to answer.',
  'network.aborted': 'The request was cancelled.',
  'response.invalid': 'The server sent a response that is not the Tula API’s.',
  'client.invalid_key': 'The secret key is not a Tula secret key (tula_sk_…).',
  'client.publishable_key':
    'That is a publishable key (tula_pk_…). The admin API takes a secret key (tula_sk_…).',
  'client.invalid_url': 'The API URL must be an http(s) URL without credentials.',
  'client.browser':
    '@tula/admin holds a secret key and must not run in a browser. Call it from your server.',
} as const

/**
 * A code the admin client itself raises: no answer (`network.failed`, `network.timeout`,
 * `network.aborted`), an answer that is not the API's (`response.invalid`), or a client that
 * was refused before any request (`client.invalid_key`, `client.publishable_key`,
 * `client.invalid_url`, `client.browser`).
 *
 * @example
 * ```ts
 * if (error.code === 'network.timeout') {
 *   retryLater()
 * }
 * ```
 */
export type AdminClientErrorCode = keyof typeof CLIENT_MESSAGES

/**
 * Every code a {@link TulaAdminError} can carry: the API's contract codes plus the client's own.
 *
 * @example
 * ```ts
 * const code: TulaAdminErrorCode = 'precondition.failed'
 * ```
 */
export type TulaAdminErrorCode = ErrorCode | AdminClientErrorCode

/**
 * Values that give an error its specifics, e.g. `{ retryAfter: 30 }` for `rate_limited`.
 *
 * @example
 * ```ts
 * const params: AdminErrorParams = error.params
 * ```
 */
export type AdminErrorParams = Readonly<Record<string, string | number | boolean>>

/**
 * One field-level problem of a refused request: which field of the body, and why.
 *
 * @example
 * ```ts
 * for (const problem of error.errors) {
 *   report(`${problem.field}: ${problem.message}`) // 'password.minLength: must be at least 8'
 * }
 * ```
 */
export interface AdminFieldError {
  /** Path of the field in the request, dot-separated, e.g. `password.minLength`. */
  readonly field: string
  /** The problem's code. */
  readonly code: TulaAdminErrorCode | (string & {})
  /** The server's message for the problem. */
  readonly message: string
  /** The problem's params. */
  readonly params: AdminErrorParams
}

/** What a {@link TulaAdminError} is built from. */
export interface TulaAdminErrorInit {
  /** The error code. */
  code: TulaAdminErrorCode | (string & {})
  /** The message. */
  message: string
  /** HTTP status of the answer; `0` when there was none. */
  status?: number
  /** The operation that failed, when one was being called. */
  operation?: string
  /** The error's params. */
  params?: AdminErrorParams
  /** Field-level problems. */
  errors?: readonly AdminFieldError[]
  /** How long to wait before trying again, when the server said. */
  retryAfterMs?: number
  /** What kind of failure a missing answer was (an error's name, never its message). */
  reason?: string
}

/**
 * The one error every failed admin call throws.
 *
 * `code` is a contract code (`precondition.failed`, `validation.failed`, `rate_limited`, …) or
 * one of the client's own. It never contains the secret key: the error of a request that got
 * no answer keeps the underlying failure's **name** only (`reason`), not its message or the
 * error itself, because a runtime's network error may quote the request it could not send.
 *
 * @example
 * ```ts
 * try {
 *   await admin.call('replaceEnvironmentSettings', { headers: { 'If-Match': ifMatch(3) }, body })
 * } catch (error) {
 *   if (isTulaAdminError(error) && error.code === 'precondition.failed') {
 *     // Someone else changed the settings: read them again.
 *   }
 * }
 * ```
 */
export class TulaAdminError extends Error {
  /** A contract error code, or one of the client's own. */
  readonly code: TulaAdminErrorCode | (string & {})
  /** HTTP status of the API's answer; `0` when the request got none. */
  readonly status: number
  /** The operation that failed (`replaceEnvironmentSettings`), or `undefined` before any call. */
  readonly operation: string | undefined
  /** Values that give the error its specifics. */
  readonly params: AdminErrorParams
  /** Field-level problems (`validation.failed`). Empty when there are none. */
  readonly errors: readonly AdminFieldError[]
  /**
   * How long to wait before trying again, in milliseconds, when the server said (`Retry-After`
   * on a 429 or 503). The client never retries on its own.
   */
  readonly retryAfterMs: number | undefined
  /** The name of the underlying failure when the request got no answer, e.g. `TypeError`. */
  readonly reason: string | undefined

  /** @param init - The error's code, message and details. */
  constructor(init: TulaAdminErrorInit) {
    super(init.message)
    this.name = 'TulaAdminError'
    this.code = init.code
    this.status = init.status ?? 0
    this.operation = init.operation
    this.params = init.params ?? {}
    this.errors = init.errors ?? []
    this.retryAfterMs = init.retryAfterMs
    this.reason = init.reason
  }

  /**
   * A plain, serialisable copy of the error (no stack).
   *
   * @returns The error's fields.
   */
  toJSON(): {
    name: string
    code: string
    status: number
    message: string
    operation: string | undefined
    params: AdminErrorParams
    errors: readonly AdminFieldError[]
    retryAfterMs: number | undefined
    reason: string | undefined
  } {
    return {
      name: this.name,
      code: this.code,
      status: this.status,
      message: this.message,
      operation: this.operation,
      params: this.params,
      errors: this.errors,
      retryAfterMs: this.retryAfterMs,
      reason: this.reason,
    }
  }
}

/**
 * Whether a caught value is a {@link TulaAdminError}.
 *
 * Checks the error's name as well as its class, so it also recognises an error thrown by
 * another copy of this package in the same process.
 *
 * @param value - The caught value.
 * @returns `true` for a `TulaAdminError`.
 *
 * @example
 * ```ts
 * if (isTulaAdminError(error)) {
 *   log(error.code, error.status)
 * }
 * ```
 */
export function isTulaAdminError(value: unknown): value is TulaAdminError {
  return (
    value instanceof TulaAdminError ||
    (value instanceof Error &&
      value.name === 'TulaAdminError' &&
      'code' in value &&
      'status' in value)
  )
}

/**
 * The default message of a code: the client's own, or the contract's.
 *
 * Codes come from the server, so the table is read with `Object.hasOwn`: a code such as
 * `constructor` must not find what every object inherits.
 *
 * @param code - The error code.
 * @returns The message, or `undefined` for a code neither table knows (a newer server).
 */
export function defaultMessage(code: string): string | undefined {
  if (Object.hasOwn(CLIENT_MESSAGES, code)) {
    return CLIENT_MESSAGES[code as AdminClientErrorCode]
  }
  return Object.hasOwn(ERROR_DEFINITIONS, code)
    ? ERROR_DEFINITIONS[code as ErrorCode].message
    : undefined
}

/**
 * Build one of the client's own errors.
 *
 * @param code - The client code.
 * @param details - The operation being called and, for a missing answer, the failure's name.
 * @returns The error.
 */
export function clientError(
  code: AdminClientErrorCode,
  details: { operation?: string; reason?: string; status?: number } = {}
): TulaAdminError {
  return new TulaAdminError({ code, message: CLIENT_MESSAGES[code], ...details })
}
