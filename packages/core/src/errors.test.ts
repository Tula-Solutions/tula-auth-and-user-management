import { describe, expect, test } from 'bun:test'
import { ERROR_CODES, ERROR_DEFINITIONS } from '@tula/contract'
import { clientError, EN_MESSAGES, formatMessage, isTulaError, TulaError } from './errors'

describe('EN_MESSAGES', () => {
  test('has the contract’s message for every contract code, and one for each client code', () => {
    for (const code of ERROR_CODES) {
      expect(EN_MESSAGES[code]).toBe(ERROR_DEFINITIONS[code].message)
    }
    for (const code of [
      'network.failed',
      'network.timeout',
      'response.invalid',
      'storage.failed',
    ] as const) {
      expect(EN_MESSAGES[code].length).toBeGreaterThan(10)
    }
    expect(Object.keys(EN_MESSAGES)).toHaveLength(ERROR_CODES.length + 4)
  })
})

describe('formatMessage', () => {
  test.each([
    [
      'uses the locale table first',
      'password.too_short',
      { 'password.too_short': 'Demasiado corta.' },
      undefined,
      undefined,
      'Demasiado corta.',
    ],
    [
      'falls back to English for a code the table lacks',
      'password.common',
      { 'password.too_short': 'x' },
      undefined,
      undefined,
      'This password is too common.',
    ],
    [
      'fills placeholders from params',
      'password.too_short',
      { 'password.too_short': 'Use {min} or more ({min}).' },
      { min: 12 },
      undefined,
      'Use 12 or more (12).',
    ],
    [
      'leaves a placeholder with no param as it is',
      'password.too_short',
      { 'password.too_short': 'Use {min}, not {max}.' },
      { min: 12 },
      undefined,
      'Use 12, not {max}.',
    ],
    [
      'uses the fallback for a code neither table knows',
      'future.code',
      {},
      undefined,
      'From a newer server.',
      'From a newer server.',
    ],
    [
      'ends with the generic message when there is nothing else',
      'future.code',
      {},
      undefined,
      undefined,
      'Something went wrong on our side.',
    ],
  ] as [
    string,
    string,
    Record<string, string>,
    Record<string, number> | undefined,
    string | undefined,
    string,
  ][])('%s', (_name, code, messages, params, fallback, expected) => {
    expect(formatMessage(code, { messages, params, fallback })).toBe(expected)
  })

  test('with no options it is the English message', () => {
    expect(formatMessage('auth.invalid_credentials')).toBe('The email or password is incorrect.')
  })
})

describe('TulaError', () => {
  test('carries code, status, params, field errors and retryAfterMs, and defaults the rest', () => {
    const bare = new TulaError({ code: 'network.failed', message: 'Offline.' })
    expect(bare).toBeInstanceOf(Error)
    expect(bare).toMatchObject({
      name: 'TulaError',
      code: 'network.failed',
      message: 'Offline.',
      status: 0,
      params: {},
      errors: [],
      retryAfterMs: undefined,
    })
    expect(bare.cause).toBeUndefined()

    const cause = new TypeError('fetch failed')
    const full = new TulaError({
      code: 'rate_limited',
      message: 'Slow down.',
      status: 429,
      params: { retryAfter: 3 },
      errors: [
        { field: 'password', code: 'password.too_short', message: 'Short.', params: { min: 10 } },
      ],
      retryAfterMs: 3_000,
      cause,
    })
    expect(full.cause).toBe(cause)
    expect(JSON.parse(JSON.stringify(full))).toEqual({
      name: 'TulaError',
      code: 'rate_limited',
      status: 429,
      message: 'Slow down.',
      params: { retryAfter: 3 },
      errors: [
        { field: 'password', code: 'password.too_short', message: 'Short.', params: { min: 10 } },
      ],
      retryAfterMs: 3_000,
    })
  })

  test('its serialised form has no stack and no cause', () => {
    const error = new TulaError({
      code: 'network.failed',
      message: 'x',
      cause: new Error('secret detail'),
    })
    expect(JSON.stringify(error)).not.toContain('secret detail')
    expect(JSON.stringify(error)).not.toContain('stack')
  })
})

describe('isTulaError', () => {
  test('recognises its own class and a copy from another bundle; nothing else', () => {
    expect(isTulaError(new TulaError({ code: 'internal', message: 'x' }))).toBe(true)
    const foreign = Object.assign(new Error('x'), {
      name: 'TulaError',
      code: 'internal',
      status: 500,
    })
    expect(isTulaError(foreign)).toBe(true)
    expect(isTulaError(Object.assign(new Error('x'), { name: 'TulaError' }))).toBe(false)
    expect(isTulaError(new Error('x'))).toBe(false)
    expect(isTulaError({ name: 'TulaError', code: 'internal', status: 500 })).toBe(false)
    expect(isTulaError(null)).toBe(false)
  })
})

describe('clientError', () => {
  test('builds a status-0 error with the table’s message and the cause', () => {
    const cause = new Error('boom')
    const error = clientError('storage.failed', { 'storage.failed': 'No se pudo guardar.' }, cause)
    expect(error).toMatchObject({
      code: 'storage.failed',
      status: 0,
      message: 'No se pudo guardar.',
    })
    expect(error.cause).toBe(cause)
  })
})
