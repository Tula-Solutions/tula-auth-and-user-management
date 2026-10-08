import { isTulaAdminError } from '@tula/admin'

/**
 * What a failed tool call answers: a stable code and one short sentence. Never a stack, a URL,
 * a credential or the API's own error body.
 *
 * @example
 * ```ts
 * const failure: ToolFailure = { code: 'rate_limited', status: 429, message: '…', retryAfterSeconds: 30 }
 * ```
 */
export interface ToolFailure {
  /** A contract error code (`resource.not_found`), a client code (`network.timeout`) or one of this server's own (`not_configured`, `path.outside_root`, …). */
  code: string
  /** One sentence, written here. */
  message: string
  /** The API's HTTP status, when it answered. */
  status?: number
  /** For `rate_limited`: how long to wait before trying again. */
  retryAfterSeconds?: number
}

/**
 * A failure a tool raises on purpose, with the code and sentence to answer.
 *
 * @example
 * ```ts
 * throw new ToolError('not_configured', 'No secret key is configured.')
 * ```
 */
export class ToolError extends Error {
  /** The code to answer. */
  readonly code: string

  /**
   * @param code - The code to answer.
   * @param message - The sentence to answer. It must not contain anything from the API or the
   *   environment.
   */
  constructor(code: string, message: string) {
    super(message)
    this.name = 'ToolError'
    this.code = code
  }
}

/** One sentence per kind of failure. The API's own `detail` is never repeated. */
function sentence(code: string, status: number): string {
  if (code === 'rate_limited') {
    return 'The API is rate limiting this key. Try again later.'
  }
  if (code === 'resource.not_found') {
    return 'Nothing was found.'
  }
  if (code === 'auth.invalid_key' || code === 'auth.unauthenticated') {
    return 'The API refused the configured credential.'
  }
  if (code === 'auth.forbidden') {
    return 'The configured credential may not read this.'
  }
  if (code === 'validation.failed' || code === 'request.malformed') {
    return 'The API refused the request’s parameters.'
  }
  if (code === 'service.unavailable') {
    return 'The API is temporarily unavailable.'
  }
  if (code === 'network.timeout') {
    return 'The API took too long to answer.'
  }
  if (code.startsWith('network.')) {
    return 'The API could not be reached.'
  }
  if (code === 'response.invalid') {
    return 'The answer was not the Tula API’s.'
  }
  if (code.startsWith('client.')) {
    return 'The request could not be made.'
  }
  return status >= 500 ? 'The API failed.' : 'The API refused the request.'
}

/**
 * Turn whatever a tool threw into what it answers.
 *
 * @param error - What was thrown.
 * @returns The failure. Nothing of an unforeseen error is kept but the fact that it happened.
 *
 * @example
 * ```ts
 * try {
 *   return await run()
 * } catch (error) {
 *   return { error: toolFailure(error) }
 * }
 * ```
 */
export function toolFailure(error: unknown): ToolFailure {
  if (error instanceof ToolError) {
    return { code: error.code, message: error.message }
  }
  if (isTulaAdminError(error)) {
    // The code is the contract's (or the client's): a fixed vocabulary, checked all the same.
    const code = /^[a-z_]+(\.[a-z_]+)?$/.test(error.code) ? error.code : 'internal'
    return {
      code,
      ...(error.status > 0 ? { status: error.status } : {}),
      message: sentence(code, error.status),
      ...(error.retryAfterMs !== undefined
        ? { retryAfterSeconds: Math.max(1, Math.ceil(error.retryAfterMs / 1000)) }
        : {}),
    }
  }
  return { code: 'internal', message: 'The tool failed unexpectedly.' }
}
