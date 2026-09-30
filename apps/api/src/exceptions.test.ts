import { describe, expect, test } from 'bun:test'
import { errorDefinition } from '@tula/contract'
import {
  AuthError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  NotImplementedError,
  RateLimitError,
  ServiceException,
  UnauthorizedError,
  ValidationError,
} from '~/exceptions'

describe('ServiceException subclasses', () => {
  test.each([
    [new BadRequestError(), 'request.malformed', 400],
    [new UnauthorizedError(), 'auth.unauthenticated', 401],
    [new ForbiddenError(), 'auth.forbidden', 403],
    [new NotFoundError(), 'resource.not_found', 404],
    [new ConflictError(), 'resource.conflict', 409],
    [new ValidationError(), 'validation.failed', 422],
    [new RateLimitError(1), 'rate_limited', 429],
    [new InternalError(), 'internal', 500],
    [new NotImplementedError(), 'not_implemented', 501],
  ] as const)('%p maps to %s / %i', (error, code, status) => {
    expect(error).toBeInstanceOf(ServiceException)
    expect(error.code).toBe(code)
    expect(error.status).toBe(status)
    expect(error.detail).toBe(errorDefinition(code).message)
  })
})

describe('toJSON', () => {
  test('never includes the internal message or cause', () => {
    const error = new InternalError({
      internalMessage: 'db password rejected',
      cause: new Error('boom'),
    })
    expect(error.toJSON()).toEqual({
      status: 500,
      code: 'internal',
      detail: errorDefinition('internal').message,
    })
  })

  test('includes params and field errors when present', () => {
    const error = new ValidationError({
      errors: [{ field: 'email', code: 'email.invalid', message: 'Enter a valid email address.' }],
    })
    expect(error.toJSON().errors).toHaveLength(1)
    expect(new AuthError('password.too_short', { min: 10 }).toJSON()).toEqual({
      status: 422,
      code: 'password.too_short',
      detail: 'Password is too short.',
      params: { min: 10 },
    })
  })

  test('allows a message override', () => {
    expect(new NotFoundError({ message: 'No such user.' }).toJSON().detail).toBe('No such user.')
  })
})

describe('RateLimitError', () => {
  test.each([
    [1, 1],
    [999, 1],
    [1001, 2],
    [0, 1],
  ])('rounds %ims up to %is', (ms, seconds) => {
    const error = new RateLimitError(ms)
    expect(error.retryAfter).toBe(seconds)
    expect(error.params).toEqual({ retryAfter: seconds })
  })
})
