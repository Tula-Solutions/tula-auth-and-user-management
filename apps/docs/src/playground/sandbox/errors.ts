import { ERROR_DEFINITIONS } from '@tula-tech/contract/error-codes'
import type { Schemas } from './api-types'

/** A contract error code, as the API's error envelope carries it. */
export type ErrorCode = Schemas['ErrorCode']

/**
 * An error the sandbox answers with. Only contract codes: a code the contract does not define
 * does not compile, and its status and message come from the contract's own table, so the
 * sandbox cannot word an error differently from the real service.
 *
 * @example
 * ```ts
 * throw new SandboxError('auth.invalid_credentials')
 * ```
 */
export class SandboxError extends Error {
  /** The contract code. */
  readonly code: ErrorCode
  /** Values the message names (`min`, `retryAfter`, …). */
  readonly params: Record<string, string | number | boolean> | undefined
  /** Per-field errors, for a validation failure. */
  readonly fields: Schemas['FieldError'][] | undefined
  /** Seconds the client should wait, for `rate_limited`. */
  readonly retryAfterSeconds: number | undefined

  /**
   * @param code - The contract code.
   * @param options - Message parameters, per-field errors and a wait.
   */
  constructor(
    code: ErrorCode,
    options: {
      params?: Record<string, string | number | boolean>
      fields?: Schemas['FieldError'][]
      retryAfterSeconds?: number
    } = {}
  ) {
    super(code)
    this.name = 'SandboxError'
    this.code = code
    this.params = options.params
    this.fields = options.fields
    this.retryAfterSeconds = options.retryAfterSeconds
  }
}

function definitionOf(code: string): { status: number; message: string } | undefined {
  return (ERROR_DEFINITIONS as Record<string, { status: number; message: string }>)[code]
}

/**
 * The HTTP status of a code, from the contract's table.
 *
 * @param code - A contract code.
 * @returns Its status.
 */
export function statusOf(code: ErrorCode): number {
  return definitionOf(code)?.status ?? 500
}

/**
 * The error envelope of the contract, as a response.
 *
 * @param error - What the handler threw.
 * @returns A response with the code's status and, for a wait, a `Retry-After` header.
 */
export function errorResponse(error: SandboxError): Response {
  const status = statusOf(error.code)
  const params =
    error.retryAfterSeconds === undefined
      ? error.params
      : { ...error.params, retryAfter: error.retryAfterSeconds }
  const body: Schemas['ErrorEnvelope'] = {
    status,
    code: error.code,
    detail: definitionOf(error.code)?.message ?? error.code,
    ...(params && { params }),
    ...(error.fields && { errors: error.fields }),
  }
  const headers = new Headers({ 'content-type': 'application/json' })
  if (error.retryAfterSeconds !== undefined) {
    headers.set('retry-after', String(error.retryAfterSeconds))
  }
  return new Response(JSON.stringify(body), { status, headers })
}
