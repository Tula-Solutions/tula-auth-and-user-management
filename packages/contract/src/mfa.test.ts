import { describe, expect, test } from 'bun:test'
import * as contract from './index'
import {
  BACKUP_CODE_COUNT,
  BackupCodesSchema,
  FactorsSchema,
  StepUpMethodSchema,
  StepUpRequestSchema,
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
  TotpConfirmRequestSchema,
  TotpEnrolmentSchema,
} from './mfa'

describe('the constants every authenticator app assumes', () => {
  test('six digits, thirty seconds, ten backup codes', () => {
    expect(TOTP_DIGITS).toBe(6)
    expect(TOTP_PERIOD_SECONDS).toBe(30)
    expect(BACKUP_CODE_COUNT).toBe(10)
  })

  test('the package exports the MFA schemas from its root', () => {
    for (const name of [
      'FactorsSchema',
      'TotpEnrolmentSchema',
      'TotpConfirmRequestSchema',
      'BackupCodesSchema',
      'StepUpMethodSchema',
      'StepUpRequestSchema',
      'TOTP_DIGITS',
      'TOTP_PERIOD_SECONDS',
      'BACKUP_CODE_COUNT',
    ] as const) {
      expect([name, contract[name] === undefined]).toEqual([name, false])
    }
  })
})

describe('Factors', () => {
  test('says what is enrolled, since when, and how many backup codes are left', () => {
    const enrolled = {
      totp: { enabled: true, confirmedAt: '2026-01-01T00:00:00.000Z' },
      backupCodes: { remaining: 9 },
    }
    expect(FactorsSchema.parse(enrolled)).toEqual(enrolled)
    const nothing = { totp: { enabled: false, confirmedAt: null }, backupCodes: { remaining: 0 } }
    expect(FactorsSchema.parse(nothing)).toEqual(nothing)
  })

  test('never carries a secret: anything else is stripped', () => {
    const parsed = FactorsSchema.parse({
      totp: { enabled: true, confirmedAt: null, secret: 'GEZDGNBVGY3TQOJQ' },
      backupCodes: { remaining: 1, codes: ['abcde-fghjk'] },
      secret: 'GEZDGNBVGY3TQOJQ',
    })
    expect(JSON.stringify(parsed)).not.toContain('GEZDGNBVGY3TQOJQ')
    expect(JSON.stringify(parsed)).not.toContain('abcde-fghjk')
  })

  test.each<[string, unknown]>([
    [
      'a negative count',
      { totp: { enabled: false, confirmedAt: null }, backupCodes: { remaining: -1 } },
    ],
    [
      'a fractional count',
      { totp: { enabled: false, confirmedAt: null }, backupCodes: { remaining: 1.5 } },
    ],
    [
      'a date that is not ISO',
      { totp: { enabled: true, confirmedAt: 'yesterday' }, backupCodes: { remaining: 0 } },
    ],
    ['a missing section', { totp: { enabled: false, confirmedAt: null } }],
    ['a missing flag', { totp: { confirmedAt: null }, backupCodes: { remaining: 0 } }],
  ])('refuses %s', (_, input) => {
    expect(FactorsSchema.safeParse(input).success).toBe(false)
  })
})

describe('TotpEnrolment and BackupCodes', () => {
  test('an enrolment is the secret and its URI', () => {
    const enrolment = { secret: 'GEZDGNBVGY3TQOJQ', uri: 'otpauth://totp/Acme:a%40b.co?secret=X' }
    expect(TotpEnrolmentSchema.parse(enrolment)).toEqual(enrolment)
    expect(TotpEnrolmentSchema.safeParse({ secret: 'X' }).success).toBe(false)
    expect(TotpEnrolmentSchema.safeParse({ uri: 'otpauth://x' }).success).toBe(false)
  })

  test('backup codes are a list of strings', () => {
    expect(BackupCodesSchema.parse({ codes: ['abcde-fghjk', 'mnpqr-stuvw'] }).codes).toHaveLength(2)
    expect(BackupCodesSchema.safeParse({ codes: [1, 2] }).success).toBe(false)
    expect(BackupCodesSchema.safeParse({}).success).toBe(false)
  })
})

describe('TotpConfirmRequest', () => {
  test('a code is exactly six digits', () => {
    expect(TotpConfirmRequestSchema.parse({ code: '012345' })).toEqual({ code: '012345' })
    for (const code of ['12345', '1234567', 'abcdef', '123 456', ' 123456', '12345a', '', 123456]) {
      expect([code, TotpConfirmRequestSchema.safeParse({ code }).success]).toEqual([code, false])
    }
    expect(TotpConfirmRequestSchema.safeParse({}).success).toBe(false)
  })
})

describe('StepUpRequest', () => {
  test('the methods are the password, an authenticator code and a backup code', () => {
    expect(StepUpMethodSchema.options).toEqual(['password', 'totp', 'backup_code'])
  })

  test.each<[string, unknown]>([
    ['a password', { method: 'password', password: 'correct horse battery staple' }],
    [
      'an empty password (refused by the server, not the schema)',
      { method: 'password', password: '' },
    ],
    ['an authenticator code', { method: 'totp', code: '012345' }],
    ['a backup code', { method: 'backup_code', code: 'abcde-fghjk' }],
    [
      'a backup code typed with spaces and capitals',
      { method: 'backup_code', code: ' ABCDE FGHJK ' },
    ],
  ])('accepts %s', (_, proof) => {
    expect(StepUpRequestSchema.parse(proof)).toEqual(proof as never)
  })

  test.each<[string, unknown]>([
    ['nothing', {}],
    ['a method alone', { method: 'password' }],
    ['a password over 1024 characters', { method: 'password', password: 'x'.repeat(1025) }],
    ['a five-digit code', { method: 'totp', code: '12345' }],
    ['a code with letters', { method: 'totp', code: '12345a' }],
    ['a code as a number', { method: 'totp', code: 123456 }],
    ['a password where a code belongs', { method: 'totp', password: 'x' }],
    ['an empty backup code', { method: 'backup_code', code: '' }],
    ['a backup code over 64 characters', { method: 'backup_code', code: 'a'.repeat(65) }],
    ['a passkey', { method: 'passkey', code: '123456' }],
    ['an SMS code', { method: 'sms_code', code: '123456' }],
    ['an emailed code', { method: 'email_code', code: '123456' }],
  ])('refuses %s', (_, proof) => {
    expect(StepUpRequestSchema.safeParse(proof).success).toBe(false)
  })

  test('a proof carries only its own field', () => {
    expect(StepUpRequestSchema.parse({ method: 'totp', code: '123456', password: 'x' })).toEqual({
      method: 'totp',
      code: '123456',
    })
  })
})
