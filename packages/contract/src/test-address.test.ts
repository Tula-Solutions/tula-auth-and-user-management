import { describe, expect, test } from 'bun:test'
import { SignInTestReportSchema } from './sign-in-test'
import {
  isTestAddress,
  SIGN_IN_TEST_STEPS,
  TEST_ADDRESS_DOMAIN,
  testAddress,
  testSignInAllowed,
} from './test-address'

const HEX = '0123456789abcdef0123456789abcdef'

describe('isTestAddress', () => {
  test.each([
    testAddress(HEX),
    `anything@${TEST_ADDRESS_DOMAIN}`,
    `Anything@${TEST_ADDRESS_DOMAIN.toUpperCase()}`,
    `a@sub.${TEST_ADDRESS_DOMAIN}`,
    `a@${TEST_ADDRESS_DOMAIN}.`,
    ` a@${TEST_ADDRESS_DOMAIN} `,
    `"odd@local"@${TEST_ADDRESS_DOMAIN}`,
  ])('%p is one', (address) => {
    expect(isTestAddress(address)).toBe(true)
  })

  test.each([
    'maya@northline.app',
    'a@tula.invalid',
    'a@test.tula.invalid.example.com',
    `a@not${TEST_ADDRESS_DOMAIN}`,
    `${TEST_ADDRESS_DOMAIN}@example.com`,
    TEST_ADDRESS_DOMAIN,
    '',
    '+15551234567',
  ])('%p is not', (address) => {
    expect(isTestAddress(address)).toBe(false)
  })
})

describe('testAddress', () => {
  test('is in the reserved domain, lower case, with the prefix', () => {
    expect(testAddress(HEX)).toBe(`tula-test-${HEX}@test.tula.invalid`)
  })

  test.each(['', 'abc', HEX.toUpperCase(), `${HEX}0`, `${HEX.slice(1)}g`])('refuses %p', (hex) => {
    expect(() => testAddress(hex)).toThrow()
  })

  test('the reserved top-level domain is .invalid (RFC 2606)', () => {
    expect(TEST_ADDRESS_DOMAIN.endsWith('.invalid')).toBe(true)
  })
})

describe('testSignInAllowed', () => {
  test.each([
    [null, 'development', true],
    [null, 'production', false],
    [true, 'production', true],
    [true, 'development', true],
    [false, 'development', false],
    [false, 'production', false],
  ] as const)('%p in a %s environment: %p', (setting, kind, allowed) => {
    expect(testSignInAllowed(setting, kind)).toBe(allowed)
  })
})

describe('SignInTestReportSchema', () => {
  const steps = SIGN_IN_TEST_STEPS.map((step) => ({ step, outcome: 'passed', durationMs: 1 }))
  const report = { outcome: 'passed', steps, userId: null, cleanup: 'none' }

  test('takes a report with every step', () => {
    expect(SignInTestReportSchema.safeParse(report).success).toBe(true)
  })

  test('refuses a key it does not name, on the report and on a step', () => {
    expect(SignInTestReportSchema.safeParse({ ...report, email: 'a@b.c' }).success).toBe(false)
    const withToken = [{ ...steps[0], accessToken: 'x' }, ...steps.slice(1)]
    expect(SignInTestReportSchema.safeParse({ ...report, steps: withToken }).success).toBe(false)
  })

  test('refuses a report with a step missing, and a code that is not the contract’s', () => {
    expect(SignInTestReportSchema.safeParse({ ...report, steps: steps.slice(1) }).success).toBe(
      false
    )
    const odd = [{ ...steps[0], outcome: 'failed', code: 'made.up' }, ...steps.slice(1)]
    expect(SignInTestReportSchema.safeParse({ ...report, steps: odd }).success).toBe(false)
  })
})
