import {
  type ErrorCode,
  type ErrorEnvelope,
  type ErrorParams,
  errorDefinition,
  type FieldError,
} from '@tula/contract'

/** Options shared by every service exception. */
export interface ServiceExceptionOptions {
  /** Client-facing message; defaults to the contract's message for the code. */
  message?: string
  /** Typed specifics sent to the client, e.g. `{ min: 10 }`. Never secrets. */
  params?: ErrorParams
  /** Per-field problems (validation errors). */
  errors?: FieldError[]
  /** Logged server-side only, never sent to the client. */
  internalMessage?: string
  /** The underlying error, kept for logs. */
  cause?: unknown
}

/**
 * Base class for every error a service or middleware throws on purpose.
 *
 * The HTTP status comes from the contract definition of `code`, so status and code can never
 * disagree. `~/handlers` turns it into the contract error envelope.
 */
export class ServiceException extends Error {
  readonly code: ErrorCode
  readonly status: number
  readonly detail: string
  readonly params?: ErrorParams
  readonly errors?: FieldError[]
  readonly internalMessage?: string

  /**
   * @param code - Contract error code.
   * @param options - Message override, params, field errors and log-only details.
   */
  constructor(code: ErrorCode, options: ServiceExceptionOptions = {}) {
    const definition = errorDefinition(code)
    const detail = options.message ?? definition.message
    super(detail, { cause: options.cause })
    this.name = 'ServiceException'
    this.code = code
    this.status = definition.status
    this.detail = detail
    this.params = options.params
    this.errors = options.errors
    this.internalMessage = options.internalMessage
  }

  /**
   * The client-facing body. `internalMessage` and `cause` are deliberately left out.
   *
   * @returns The contract error envelope.
   */
  toJSON(): ErrorEnvelope {
    return {
      status: this.status,
      code: this.code,
      detail: this.detail,
      ...(this.params && { params: this.params }),
      ...(this.errors && { errors: this.errors }),
    }
  }
}

/**
 * An authentication or domain error identified by its contract code.
 *
 * @example
 * ```ts
 * throw new AuthError('auth.invalid_credentials')
 * throw new AuthError('password.too_short', { min: 10 })
 * ```
 */
export class AuthError extends ServiceException {
  /**
   * @param code - Contract error code.
   * @param params - Typed specifics for the client.
   * @param options - Log-only details.
   */
  constructor(
    code: ErrorCode,
    params?: ErrorParams,
    options: Omit<ServiceExceptionOptions, 'params'> = {}
  ) {
    super(code, { ...options, params })
    this.name = 'AuthError'
  }
}

/** 400: the request body or headers could not be parsed. */
export class BadRequestError extends ServiceException {
  /** @param options - Message and log-only details. */
  constructor(options: ServiceExceptionOptions = {}) {
    super('request.malformed', options)
    this.name = 'BadRequestError'
  }
}

/** 401: no valid credentials were presented. */
export class UnauthorizedError extends ServiceException {
  /** @param options - Message and log-only details. */
  constructor(options: ServiceExceptionOptions = {}) {
    super('auth.unauthenticated', options)
    this.name = 'UnauthorizedError'
  }
}

/** 403: authenticated, but not allowed. */
export class ForbiddenError extends ServiceException {
  /** @param options - Message and log-only details. */
  constructor(options: ServiceExceptionOptions = {}) {
    super('auth.forbidden', options)
    this.name = 'ForbiddenError'
  }
}

/** 404: the resource does not exist in this environment. */
export class NotFoundError extends ServiceException {
  /** @param options - Message and log-only details. */
  constructor(options: ServiceExceptionOptions = {}) {
    super('resource.not_found', options)
    this.name = 'NotFoundError'
  }
}

/** 409: the change conflicts with existing data. */
export class ConflictError extends ServiceException {
  /** @param options - Message and log-only details. */
  constructor(options: ServiceExceptionOptions = {}) {
    super('resource.conflict', options)
    this.name = 'ConflictError'
  }
}

/** 422: the input is well-formed but invalid; `errors` lists each field. */
export class ValidationError extends ServiceException {
  /** @param options - Field errors, message and log-only details. */
  constructor(options: ServiceExceptionOptions = {}) {
    super('validation.failed', options)
    this.name = 'ValidationError'
  }
}

/** 429: a rate limit was hit. `retryAfter` (seconds) is sent in params and `Retry-After`. */
export class RateLimitError extends ServiceException {
  /** Whole seconds until the client may retry. */
  readonly retryAfter: number

  /**
   * @param retryAfterMs - Time until the limit resets, in milliseconds.
   * @param options - Log-only details.
   */
  constructor(retryAfterMs: number, options: Omit<ServiceExceptionOptions, 'params'> = {}) {
    const retryAfter = Math.max(1, Math.ceil(retryAfterMs / 1000))
    super('rate_limited', { ...options, params: { retryAfter } })
    this.name = 'RateLimitError'
    this.retryAfter = retryAfter
  }
}

/** 500: an unexpected failure. The client only ever sees the generic message. */
export class InternalError extends ServiceException {
  /** @param options - Log-only details. */
  constructor(options: Omit<ServiceExceptionOptions, 'message' | 'params' | 'errors'> = {}) {
    super('internal', options)
    this.name = 'InternalError'
  }
}

/** 501: the capability is on the roadmap but not built (e.g. a non-hybrid session type). */
export class NotImplementedError extends ServiceException {
  /** @param options - Message and log-only details. */
  constructor(options: ServiceExceptionOptions = {}) {
    super('not_implemented', options)
    this.name = 'NotImplementedError'
  }
}
