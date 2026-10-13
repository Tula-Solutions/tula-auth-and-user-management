import type { Hook } from '@hono/standard-validator'
import { DPOP_NONCE_HEADER, type ErrorCode, type FieldError } from '@tula/contract'
import type { Context, Env } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { AppEnv } from '~/dependencies'
import {
  BadRequestError,
  InternalError,
  NonceRequiredError,
  NotFoundError,
  RateLimitError,
  ServiceException,
  ValidationError,
} from '~/exceptions'
import * as logger from '~/lib/logger'
import { describeError } from '~/lib/safe-error'

/** Contract code for errors Hono itself raises (e.g. malformed JSON), by status. */
const HTTP_EXCEPTION_CODES: Partial<Record<number, ErrorCode>> = {
  401: 'auth.unauthenticated',
  403: 'auth.forbidden',
  404: 'resource.not_found',
  409: 'resource.conflict',
  // Raised by Hono's bodyLimit; kept distinct so clients know to shrink the payload, not fix it.
  413: 'request.too_large',
  429: 'rate_limited',
}

/**
 * SQLSTATEs Postgres raises for a NUL character in text (22021) or in JSON (22P05). The value
 * came from the request, so this is the client's malformed input, not a server fault; answering
 * 500 would also let anyone fill the error log at will.
 */
const UNSTORABLE_INPUT: ReadonlySet<string> = new Set(['22021', '22P05'])

function fromHttpException(err: HTTPException): ServiceException {
  const code = HTTP_EXCEPTION_CODES[err.status]
  if (code) {
    return new ServiceException(code, { internalMessage: err.message })
  }
  // Any other 4xx from the framework (bad JSON, oversized body) means we could not read the
  // request. Hono's message can quote the parser error, so it goes to logs only.
  return err.status < 500
    ? new BadRequestError({ internalMessage: err.message })
    : new InternalError({ internalMessage: err.message, cause: err })
}

/**
 * Format every thrown error as the contract error envelope.
 *
 * - `ServiceException`: sent as-is (its `internalMessage` is logged, never sent).
 * - Hono `HTTPException`: mapped to a contract code.
 * - A database error caused by input Postgres cannot store (a NUL character): `request.malformed`.
 * - Anything else: logged (through `describeError`, which drops query parameters) and returned
 *   as a generic `internal` 500.
 *
 * @param err - The thrown error.
 * @param c - The request context.
 * @returns The JSON error response.
 */
export function onError(err: Error, c: Context<AppEnv>): Response {
  const exception =
    err instanceof ServiceException
      ? err
      : err instanceof HTTPException
        ? fromHttpException(err)
        : UNSTORABLE_INPUT.has(describeError(err).code ?? '')
          ? new BadRequestError({ internalMessage: 'input contains a character Postgres rejects' })
          : new InternalError({ cause: err })

  const context = {
    requestId: c.get('requestId'),
    method: c.req.method,
    path: c.req.path,
    code: exception.code,
    ...(exception.internalMessage && { internalMessage: exception.internalMessage }),
  }
  if (exception.status >= 500) {
    const cause = exception.cause instanceof Error ? exception.cause : exception
    // Never the raw message: a failed query's message contains its parameters.
    logger.error('request failed', { ...context, err: describeError(cause) })
  } else {
    logger.debug('request rejected', context)
  }

  if (exception instanceof RateLimitError) {
    c.header('Retry-After', String(exception.retryAfter))
  }
  if (exception instanceof NonceRequiredError) {
    // The challenge of RFC 9449 §8: the nonce travels in a header, and no cache keeps it.
    c.header(DPOP_NONCE_HEADER, exception.nonce)
    c.header('Cache-Control', 'no-store')
  }
  return c.json(exception.toJSON(), exception.status as ContentfulStatusCode)
}

/**
 * Respond to unmatched routes with the contract `resource.not_found` envelope.
 *
 * @param c - The request context.
 * @returns The 404 response.
 */
export function notFound(c: Context<AppEnv>): Response {
  return onError(new NotFoundError(), c)
}

function fieldName(path: ReadonlyArray<PropertyKey | { key: PropertyKey }> | undefined): string {
  const parts = (path ?? []).map((segment) =>
    String(typeof segment === 'object' ? segment.key : segment)
  )
  return parts.join('.') || '(root)'
}

/**
 * Validation hook for `validator(target, schema, validationHook)`.
 *
 * Turns schema issues into a `validation.failed` error with one entry per field. Messages come
 * from the schema and never echo the submitted value.
 *
 * @param result - The validator's result.
 * @throws ValidationError when validation failed.
 */
export const validationHook: Hook<unknown, Env, string> = (result) => {
  if (result.success) {
    return
  }
  const errors: FieldError[] = result.error.map((issue) => ({
    field: fieldName(issue.path),
    code: 'validation.failed',
    message: issue.message,
  }))
  throw new ValidationError({ errors })
}
