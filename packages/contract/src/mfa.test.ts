import { describe, expect, test } from 'bun:test'
import * as contract from './index'
import {
  BACKUP_CODE_COUNT,
  BackupCodesSchema,
  FactorsSchema,
  SmsFactorCodeSchema,
  SmsFactorConfirmRequestSchema,
  StepUpEmailCodeSchema,
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
  test('the methods are the password, an authenticator code, a backup code, an emailed code, a passkey and a texted code', () => {
    // Additive: `email_code`, `passkey` and `sms_code` came after the first three, whose
    // order is kept.
    expect(StepUpMethodSchema.options).toEqual([
      'password',
      'totp',
      'backup_code',
      'email_code',
      'passkey',
      'sms_code',
    ])
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
    ['an emailed code', { method: 'email_code', code: '012345' }],
    ['a texted code', { method: 'sms_code', code: '012345' }],
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
    ['a passkey with a code and no assertion', { method: 'passkey', code: '123456' }],
    ['a five-digit texted code', { method: 'sms_code', code: '12345' }],
    ['a texted code with a letter', { method: 'sms_code', code: '12345a' }],
    ['a texted-code method with no code', { method: 'sms_code' }],
    ['a five-digit emailed code', { method: 'email_code', code: '12345' }],
    ['an emailed code with a letter', { method: 'email_code', code: '12345a' }],
    ['an emailed code with a space', { method: 'email_code', code: '123 456' }],
    ['an emailed-code method with no code', { method: 'email_code' }],
    ['an emailed sign-in link token', { method: 'email_link', token: 'x' }],
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

describe('StepUpEmailCode', () => {
  const receipt = {
    method: 'email_code',
    destination: 'm***@northline.app',
    expiresAt: '2026-01-01T00:10:00.000Z',
  }

  test('is a receipt: the method, a masked destination and an expiry, and never a code', () => {
    expect(StepUpEmailCodeSchema.parse({ ...receipt, code: '123456' })).toEqual(receipt as never)
    expect(Object.keys(StepUpEmailCodeSchema.shape).sort()).toEqual([
      'destination',
      'expiresAt',
      'method',
    ])
  })

  test.each<[string, unknown]>([
    ['another method', { ...receipt, method: 'password' }],
    ['no destination', { method: 'email_code', expiresAt: receipt.expiresAt }],
    ['an expiry that is not a timestamp', { ...receipt, expiresAt: 'soon' }],
  ])('refuses %s', (_, value) => {
    expect(StepUpEmailCodeSchema.safeParse(value).success).toBe(false)
  })
})

describe('a texted code as the second factor', () => {
  const factors = {
    totp: { enabled: false, confirmedAt: null },
    backupCodes: { remaining: 0 },
  }
  const receipt = {
    method: 'sms_code',
    destination: '***42',
    expiresAt: '2026-01-01T00:10:00.000Z',
  }

  test('an answer without it is still a list of factors (an older server)', () => {
    expect(FactorsSchema.safeParse(factors).success).toBe(true)
  })

  test('it says whether it is enrolled, in use and could be enrolled', () => {
    const sms = {
      enabled: true,
      enabledAt: '2026-01-01T00:00:00.000Z',
      inUse: false,
      available: false,
    }
    expect(FactorsSchema.parse({ ...factors, sms }).sms).toEqual(sms)
  })

  test.each<[string, unknown]>([
    ['a missing field', { enabled: true, enabledAt: null, inUse: true }],
    ['a time that is not one', { enabled: true, enabledAt: 'now', inUse: true, available: false }],
    [
      'a switch that is not a boolean',
      { enabled: 'yes', enabledAt: null, inUse: true, available: false },
    ],
  ])('refuses %s', (_, sms) => {
    expect(FactorsSchema.safeParse({ ...factors, sms }).success).toBe(false)
  })

  test('the receipt of a texted code is a method, a masked number and an expiry, never a code', () => {
    expect(SmsFactorCodeSchema.parse({ ...receipt, code: '123456' })).toEqual(receipt as never)
    expect(Object.keys(SmsFactorCodeSchema.shape).sort()).toEqual([
      'destination',
      'expiresAt',
      'method',
    ])
    expect(SmsFactorCodeSchema.safeParse({ ...receipt, method: 'email_code' }).success).toBe(false)
    expect(SmsFactorCodeSchema.safeParse({ ...receipt, expiresAt: 'soon' }).success).toBe(false)
  })

  test.each<[string, unknown, boolean]>([
    ['six digits', { code: '012345' }, true],
    ['five digits', { code: '12345' }, false],
    ['a letter', { code: '12345a' }, false],
    ['a number', { code: 123456 }, false],
    ['nothing', {}, false],
  ])('confirming takes %s', (_, body, ok) => {
    expect(SmsFactorConfirmRequestSchema.safeParse(body).success).toBe(ok)
  })
})
