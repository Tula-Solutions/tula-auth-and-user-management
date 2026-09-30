import { describe, expect, test } from 'bun:test'
import {
  ERROR_CODES,
  ERROR_DEFINITIONS,
  ErrorCodeSchema,
  type ErrorEnvelope,
  ErrorEnvelopeSchema,
  errorDefinition,
} from './errors'

describe('error codes', () => {
  test('use area.reason snake_case naming', () => {
    for (const code of ERROR_CODES) {
      expect(code).toMatch(/^[a-z_]+(\.[a-z_]+)?$/)
    }
  })

  test('map to 4xx/5xx statuses', () => {
    for (const code of ERROR_CODES) {
      const { status } = ERROR_DEFINITIONS[code]
      expect(status).toBeGreaterThanOrEqual(400)
      expect(status).toBeLessThan(600)
    }
  })

  test('sign-in failures are a single generic code (no enumeration)', () => {
    expect(ERROR_CODES.filter((code) => code.startsWith('auth.invalid_'))).toEqual([
      'auth.invalid_credentials',
      'auth.invalid_key',
    ])
    expect(ERROR_CODES).not.toContain('auth.user_not_found' as never)
  })

  test('errorDefinition returns status and message', () => {
    expect(errorDefinition('rate_limited')).toEqual({
      status: 429,
      message: 'Too many requests. Try again shortly.',
    })
  })

  test('schema rejects unknown codes', () => {
    expect(ErrorCodeSchema.safeParse('password.too_short').success).toBe(true)
    expect(ErrorCodeSchema.safeParse('password.nope').success).toBe(false)
  })

  test('envelope accepts params and field errors', () => {
    const envelope: ErrorEnvelope = {
      status: 422,
      code: 'validation.failed',
      detail: 'Some fields are invalid.',
      errors: [
        {
          field: 'password',
          code: 'password.too_short',
          message: 'Too short',
          params: { min: 10 },
        },
      ],
    }
    expect(ErrorEnvelopeSchema.parse(envelope)).toEqual(envelope)
  })
})
