import { ERROR_DEFINITIONS, type ErrorCode } from '@tula/contract/error-codes'

/**
 * Codes for failures that happen in the client, before or instead of an API answer. They sit
 * next to the contract's codes so that callers have one thing to catch and one field to switch
 * on. `status` is `0` for all of them.
 */
const CLIENT_MESSAGES = {
  'network.failed': 'Could not reach the server. Check your connection and try again.',
  'network.timeout': 'The server took too long to answer. Try again.',
  'response.invalid': 'The server sent a response this app could not read.',
  'storage.failed': 'Your session could not be saved on this device.',
} as const

/**
 * A code the client itself raises: the request never got an answer, the answer could not be
 * read, or the storage adapter failed.
 *
 * @example
 * ```ts
 * if (error.code === 'network.failed') {
 *   showOfflineBanner()
 * }
 * ```
 */
export type ClientErrorCode = keyof typeof CLIENT_MESSAGES

/**
 * Every code a {@link TulaError} can carry: the API's contract codes plus the client's own.
 *
 * @example
 * ```ts
 * const code: TulaErrorCode = 'auth.invalid_credentials'
 * ```
 */
export type TulaErrorCode = ErrorCode | ClientErrorCode

/**
 * Values that give an error its specifics, e.g. `{ min: 10 }` for `password.too_short`.
 *
 * @example
 * ```ts
 * const params: ErrorParams = error.params // { min: 10 }
 * ```
 */
export type ErrorParams = Readonly<Record<string, string | number | boolean>>

/**
 * Messages by error code, for one language. A table may cover only some codes; the rest fall
 * back to English. A message can use an error's params as `{name}` placeholders.
 *
 * @example
 * ```ts
 * const es: Messages = {
 *   'auth.invalid_credentials': 'El correo o la contraseña no son correctos.',
 *   'password.too_short': 'Usa al menos {min} caracteres.',
 * }
 * createTulaClient({ publishableKey, baseUrl, messages: es })
 * ```
 */
export type Messages = { readonly [Code in TulaErrorCode]?: string }

function englishMessages(): Record<TulaErrorCode, string> {
  const messages: Record<string, string> = { ...CLIENT_MESSAGES }
  for (const [code, definition] of Object.entries(ERROR_DEFINITIONS)) {
    messages[code] = definition.message
  }
  return messages as Record<TulaErrorCode, string>
}

/**
 * The English message of every code: the contract's default messages plus the client's own.
 * The starting point for a translation, and the fallback for any code a table leaves out.
 *
 * @example
 * ```ts
 * EN_MESSAGES['auth.invalid_credentials'] // 'The email or password is incorrect.'
 * ```
 */
export const EN_MESSAGES: Readonly<Record<TulaErrorCode, string>> = englishMessages()

/**
 * The message for an error code in a locale table, with `{name}` placeholders filled from
 * `params`. A placeholder with no matching param is left as it is.
 *
 * @param code - The error code.
 * @param options - `messages`: the locale table (codes it lacks use English). `params`: the
 *   error's params. `fallback`: used when neither table knows the code (a newer server).
 * @returns The message.
 *
 * @example
 * ```ts
 * formatMessage('password.too_short', {
 *   messages: { 'password.too_short': 'Use at least {min} characters.' },
 *   params: { min: 10 },
 * }) // 'Use at least 10 characters.'
 * ```
 */
export function formatMessage(
  code: string,
  options: { messages?: Messages; params?: ErrorParams; fallback?: string } = {}
): string {
  const tables: Record<string, string | undefined>[] = [options.messages ?? {}, EN_MESSAGES]
  const template =
    tables.map((table) => table[code]).find((message) => message !== undefined) ??
    options.fallback ??
    EN_MESSAGES.internal
  const params = options.params ?? {}
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    name in params ? String(params[name]) : placeholder
  )
}

/**
 * One field-level problem of a failed request, e.g. each password rule that was not met.
 *
 * @example
 * ```ts
 * for (const problem of error.errors) {
 *   showUnder(problem.field, problem.message)
 * }
 * ```
 */
export interface TulaFieldError {
  /** The request field the problem is about, e.g. `password`. */
  readonly field: string
  /** The problem's code, e.g. `password.too_short`. */
  readonly code: TulaErrorCode | (string & {})
  /** A message for the user, from the locale table. */
  readonly message: string
  /** The problem's params, e.g. `{ min: 10 }`. */
  readonly params: ErrorParams
}

/** What a {@link TulaError} is built from. */
export interface TulaErrorInit {
  /** The error code. */
  code: TulaErrorCode | (string & {})
  /** The message for the user. */
  message: string
  /** HTTP status of the answer; `0` when there was none. */
  status?: number
  /** The error's params. */
  params?: ErrorParams
  /** Field-level problems. */
  errors?: readonly TulaFieldError[]
  /** How long to wait before trying again, when the server said. */
  retryAfterMs?: number
  /** The underlying error, for a network or storage failure. */
  cause?: unknown
}

/**
 * The one error every failed call throws.
 *
 * `code` is a contract code (`auth.invalid_credentials`, `password.too_short`, `rate_limited`,
 * …) or one of the client's own (`network.failed`, `network.timeout`, `response.invalid`,
 * `storage.failed`). `message` is ready to show, taken from the client's locale table. An error
 * never contains a token, an attempt's secret or a password.
 *
 * @example
 * ```ts
 * try {
 *   await flow.submitPassword({ password })
 * } catch (error) {
 *   if (isTulaError(error) && error.code === 'rate_limited') {
 *     retryIn(error.retryAfterMs)
 *   }
 * }
 * ```
 */
export class TulaError extends Error {
  /** A contract error code, or one of the client's own. */
  readonly code: TulaErrorCode | (string & {})
  /** HTTP status of the API's answer; `0` when the request got none. */
  readonly status: number
  /** Values that give the error its specifics, e.g. `{ min: 10 }`. */
  readonly params: ErrorParams
  /** Field-level problems (`validation.failed`, password rules). Empty when there are none. */
  readonly errors: readonly TulaFieldError[]
  /**
   * How long to wait before trying again, in milliseconds, when the server said (`Retry-After`
   * on a 429 or 503). The client never retries on its own.
   */
  readonly retryAfterMs: number | undefined

  /** @param init - The error's code, message and details. */
  constructor(init: TulaErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause })
    this.name = 'TulaError'
    this.code = init.code
    this.status = init.status ?? 0
    this.params = init.params ?? {}
    this.errors = init.errors ?? []
    this.retryAfterMs = init.retryAfterMs
  }

  /**
   * A plain, serialisable copy of the error (no stack, no cause).
   *
   * @returns The error's fields.
   */
  toJSON(): {
    name: string
    code: string
    status: number
    message: string
    params: ErrorParams
    errors: readonly TulaFieldError[]
    retryAfterMs: number | undefined
  } {
    return {
      name: this.name,
      code: this.code,
      status: this.status,
      message: this.message,
      params: this.params,
      errors: this.errors,
      retryAfterMs: this.retryAfterMs,
    }
  }
}

/**
 * Whether a caught value is a {@link TulaError}.
 *
 * Checks the error's name as well as its class, so it also recognises an error thrown by
 * another copy of this package in the same page.
 *
 * @param value - The caught value.
 * @returns `true` for a `TulaError`.
 *
 * @example
 * ```ts
 * if (isTulaError(error)) {
 *   show(error.message)
 * }
 * ```
 */
export function isTulaError(value: unknown): value is TulaError {
  return (
    value instanceof TulaError ||
    (value instanceof Error && value.name === 'TulaError' && 'code' in value && 'status' in value)
  )
}

/**
 * Build one of the client's own errors.
 *
 * @param code - The client error code.
 * @param messages - The locale table.
 * @param cause - The underlying error.
 * @returns The error.
 */
export function clientError(code: ClientErrorCode, messages: Messages, cause?: unknown): TulaError {
  return new TulaError({ code, message: formatMessage(code, { messages }), cause })
}
