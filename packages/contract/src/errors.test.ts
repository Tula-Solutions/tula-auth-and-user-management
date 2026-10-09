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

  test.each<[string, number]>([
    ['auth.step_up_required', 403],
    ['mfa.invalid_code', 422],
    ['mfa.already_enabled', 409],
    ['mfa.not_enabled', 409],
    ['mfa.enrolment_expired', 410],
    ['mfa.not_available', 403],
    ['mfa.required_by_policy', 403],
    ['mfa.enrolment_needs_other_sign_in', 403],
  ])('%s is a code with status %d and a message that names no secret', (code, status) => {
    expect(ERROR_CODES).toContain(code as never)
    expect(ErrorCodeSchema.safeParse(code).success).toBe(true)
    const definition = ERROR_DEFINITIONS[code as keyof typeof ERROR_DEFINITIONS]
    expect(definition.status as number).toBe(status)
    expect(definition.message.length).toBeGreaterThan(0)
    expect(definition.message).not.toMatch(/\{|\d{6}/)
  })

  test('the MFA codes are exactly these seven', () => {
    expect(ERROR_CODES.filter((code) => code.startsWith('mfa.')).sort()).toEqual([
      'mfa.already_enabled',
      'mfa.enrolment_expired',
      'mfa.enrolment_needs_other_sign_in',
      'mfa.invalid_code',
      'mfa.not_available',
      'mfa.not_enabled',
      'mfa.required_by_policy',
    ])
  })

  test('a wrong authenticator code has a code of its own, apart from the emailed-code error', () => {
    // An emailed code can be resent; an authenticator code cannot. Clients tell them apart by
    // the code, whatever the wording.
    expect(ERROR_CODES).toContain('mfa.invalid_code')
    expect(ERROR_CODES).toContain('verification.invalid_code')
    expect(ERROR_DEFINITIONS['mfa.invalid_code'].status).toBe(
      ERROR_DEFINITIONS['verification.invalid_code'].status
    )
  })

  test('a step-up error carries its methods as one scalar parameter', () => {
    const envelope: ErrorEnvelope = {
      status: 403,
      code: 'auth.step_up_required',
      detail: 'Confirm it is you to continue.',
      params: { methods: 'totp,backup_code' },
    }
    expect(ErrorEnvelopeSchema.parse(envelope)).toEqual(envelope)
    expect(ErrorEnvelopeSchema.parse({ ...envelope, params: { methods: '' } }).params).toEqual({
      methods: '',
    })
    // A list is not a scalar: the envelope's params stay flat.
    expect(
      ErrorEnvelopeSchema.safeParse({ ...envelope, params: { methods: ['totp'] } }).success
    ).toBe(false)
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
