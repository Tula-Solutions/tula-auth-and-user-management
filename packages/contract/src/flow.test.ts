import { describe, expect, test } from 'bun:test'
import {
  EmailLinkRequestSchema,
  EmailLinkResultSchema,
  FactorEnrolmentMethodSchema,
  FirstFactorAttemptRequestSchema,
  FirstFactorPrepareRequestSchema,
  FirstFactorStrategySchema,
  FlowAttemptSchema,
  FlowStepSchema,
  SecondFactorMethodSchema,
  SecondFactorRequestSchema,
  SignUpRequestSchema,
  VerifyEmailRequestSchema,
} from './flow'
import { EMAIL_LINK_ATTEMPT_PARAM, EMAIL_LINK_TOKEN_PARAM, FLOW_ATTEMPT_HEADER } from './headers'
import { AccessTokenClaimsSchema, JwksSchema } from './tokens'

describe('FlowStep', () => {
  test.each([
    { status: 'needs_identifier' },
    { status: 'needs_password' },
    { status: 'needs_first_factor', strategies: ['password', 'email_code', 'oauth_google'] },
    {
      status: 'needs_email_verification',
      destination: 'm***@northline.app',
      strategies: ['email_code'],
    },
    {
      status: 'needs_new_password',
      destination: 'm***@northline.app',
      strategies: ['email_code'],
    },
    { status: 'needs_second_factor', options: ['totp', 'passkey'] },
    { status: 'needs_second_factor', options: ['totp', 'backup_code'] },
    { status: 'needs_factor_enrolment', methods: ['totp'] },
    { status: 'complete', userId: 'u_1', sessionId: 's_1' },
  ])('accepts $status', (step) => {
    expect(FlowStepSchema.parse(step)).toEqual(step as never)
  })

  test('rejects unknown statuses and empty option lists', () => {
    expect(FlowStepSchema.safeParse({ status: 'show_password_form' }).success).toBe(false)
    expect(FlowStepSchema.safeParse({ status: 'needs_second_factor', options: [] }).success).toBe(
      false
    )
    expect(FlowStepSchema.safeParse({ status: 'needs_first_factor', strategies: [] }).success).toBe(
      false
    )
    expect(
      FlowStepSchema.safeParse({ status: 'needs_first_factor', strategies: ['sms_code'] }).success
    ).toBe(false)
  })

  test('first factors are the password, email, passkeys and the OAuth providers', () => {
    expect(FirstFactorStrategySchema.options).toEqual([
      'password',
      'email_code',
      'email_link',
      'passkey',
      'oauth_google',
      'oauth_github',
      'oauth_apple',
      'oauth_microsoft',
      'oauth_discord',
      'oauth_linkedin',
    ])
  })

  test('an attempt may carry its secret, and the header that presents it has a fixed name', () => {
    const attempt = {
      id: 'fa_1',
      kind: 'sign_in',
      expiresAt: '2026-09-29T12:00:00.000Z',
      step: { status: 'needs_password' },
    }
    expect(FlowAttemptSchema.parse(attempt).attemptSecret).toBeUndefined()
    expect(FlowAttemptSchema.parse({ ...attempt, attemptSecret: 'tula_at_x' }).attemptSecret).toBe(
      'tula_at_x'
    )
    expect(FLOW_ATTEMPT_HEADER).toBe('x-tula-attempt')
  })

  test('attempt carries session tokens only alongside the step', () => {
    const attempt = FlowAttemptSchema.parse({
      id: 'fa_1',
      kind: 'sign_in',
      expiresAt: '2026-09-29T12:00:00.000Z',
      step: { status: 'complete', userId: 'u_1', sessionId: 's_1' },
      session: {
        sessionId: 's_1',
        accessToken: 'jwt',
        accessTokenExpiresAt: '2026-09-29T12:01:00.000Z',
      },
    })
    expect(attempt.session?.refreshToken).toBeUndefined()
  })

  test('verification codes are exactly 6 digits', () => {
    expect(VerifyEmailRequestSchema.safeParse({ code: '123456' }).success).toBe(true)
    expect(VerifyEmailRequestSchema.safeParse({ code: '12345' }).success).toBe(false)
    expect(VerifyEmailRequestSchema.safeParse({ code: '12345a' }).success).toBe(false)
  })
})

describe('email first factors', () => {
  const ATTEMPT = '0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b'

  test('needs_first_factor may say which email was sent, and where to, masked', () => {
    const step = {
      status: 'needs_first_factor',
      strategies: ['password', 'email_code', 'email_link'],
      prepared: { strategy: 'email_link', destination: 'm***@northline.app' },
    }
    expect(FlowStepSchema.parse(step)).toEqual(step as never)
    // Only the email strategies can be "prepared".
    expect(
      FlowStepSchema.safeParse({ ...step, prepared: { strategy: 'password', destination: 'x' } })
        .success
    ).toBe(false)
    expect(
      FlowStepSchema.safeParse({ ...step, prepared: { strategy: 'email_code' } }).success
    ).toBe(false)
  })

  test('an attempt may carry a link binding next to its step', () => {
    const attempt = {
      id: ATTEMPT,
      kind: 'sign_in',
      expiresAt: '2026-10-03T12:10:00.000Z',
      step: { status: 'needs_first_factor', strategies: ['email_link'] },
      linkBinding: 'tula_lb_x',
    }
    expect(FlowAttemptSchema.parse(attempt)).toEqual(attempt as never)
  })

  test('asking for an email names an email strategy, and a link may name where it leads', () => {
    expect(FirstFactorPrepareRequestSchema.parse({ strategy: 'email_code' })).toEqual({
      strategy: 'email_code',
    })
    expect(
      FirstFactorPrepareRequestSchema.parse({
        strategy: 'email_link',
        redirectUrl: 'https://app.example.com/auth/link',
      })
    ).toEqual({ strategy: 'email_link', redirectUrl: 'https://app.example.com/auth/link' })
    for (const body of [
      {},
      { strategy: 'password' },
      { strategy: 'email_link', redirectUrl: `https://a.example/${'x'.repeat(2048)}` },
    ]) {
      expect(FirstFactorPrepareRequestSchema.safeParse(body).success).toBe(false)
    }
  })

  test('proving one submits a 6-digit code, or nothing at all for a link', () => {
    expect(FirstFactorAttemptRequestSchema.parse({ strategy: 'email_link' })).toEqual({
      strategy: 'email_link',
    })
    expect(
      FirstFactorAttemptRequestSchema.parse({ strategy: 'email_code', code: '004271' })
    ).toEqual({ strategy: 'email_code', code: '004271' })
    for (const body of [
      { strategy: 'email_code' },
      { strategy: 'email_code', code: '12345' },
      { strategy: 'email_code', code: '12345a' },
      { strategy: 'password', password: 'x' },
      { code: '123456' },
    ]) {
      expect(FirstFactorAttemptRequestSchema.safeParse(body).success).toBe(false)
    }
  })

  test('a link is presented with its token and attempt id; the binding may be missing', () => {
    expect(EmailLinkRequestSchema.parse({ token: 't', attemptId: ATTEMPT })).toEqual({
      token: 't',
      attemptId: ATTEMPT,
    })
    expect(
      EmailLinkRequestSchema.parse({ token: 't', attemptId: ATTEMPT, binding: 'tula_lb_x' }).binding
    ).toBe('tula_lb_x')
    for (const body of [
      { attemptId: ATTEMPT },
      { token: '', attemptId: ATTEMPT },
      { token: 't', attemptId: 'not-a-uuid' },
      { token: 'x'.repeat(2049), attemptId: ATTEMPT },
    ]) {
      expect(EmailLinkRequestSchema.safeParse(body).success).toBe(false)
    }
  })

  test('an accepted link is answered with a status and nothing else', () => {
    expect(EmailLinkResultSchema.parse({ status: 'verified' })).toEqual({ status: 'verified' })
    expect(Object.keys(EmailLinkResultSchema.shape)).toEqual(['status'])
    expect(EmailLinkResultSchema.safeParse({ status: 'complete' }).success).toBe(false)
  })

  test('the link’s fragment parameters have fixed names', () => {
    expect(EMAIL_LINK_TOKEN_PARAM).toBe('tula_link')
    expect(EMAIL_LINK_ATTEMPT_PARAM).toBe('tula_attempt')
  })

  test('a sign-up request may leave the password out', () => {
    expect(SignUpRequestSchema.parse({ email: 'maya@northline.app' })).toEqual({
      email: 'maya@northline.app',
    })
    expect(SignUpRequestSchema.parse({ email: 'a@b.co', password: 'pw' }).password).toBe('pw')
  })
})

describe('tokens', () => {
  test('claims require the current version', () => {
    const claims = { iss: 'i', sub: 'u', aud: 'e', sid: 's', pid: 'p', eid: 'e', iat: 1, exp: 2 }
    expect(AccessTokenClaimsSchema.safeParse({ ...claims, v: 1 }).success).toBe(true)
    expect(AccessTokenClaimsSchema.safeParse({ ...claims, v: 2 }).success).toBe(false)
  })

  test('JWKS only admits Ed25519 signing keys', () => {
    const key = { kty: 'OKP', crv: 'Ed25519', x: 'abc', kid: 'k1', alg: 'EdDSA', use: 'sig' }
    expect(JwksSchema.safeParse({ keys: [key] }).success).toBe(true)
    expect(JwksSchema.safeParse({ keys: [{ ...key, alg: 'RS256' }] }).success).toBe(false)
  })
})

describe('second factors and enrolment inside an attempt', () => {
  const attempt = { id: 'a_1', kind: 'sign_in', expiresAt: '2026-01-01T00:10:00.000Z' }

  test('needs_factor_enrolment names at least one method, and only ones that can be enrolled', () => {
    expect(FactorEnrolmentMethodSchema.options).toEqual(['totp'])
    for (const step of [
      { status: 'needs_factor_enrolment' },
      { status: 'needs_factor_enrolment', methods: [] },
      { status: 'needs_factor_enrolment', methods: ['backup_code'] },
      { status: 'needs_factor_enrolment', methods: ['sms_code'] },
      { status: 'needs_factor_enrolment', methods: ['totp', 'passkey'] },
    ]) {
      expect([step, FlowStepSchema.safeParse(step).success]).toEqual([step, false])
    }
  })

  test('the step carries nothing but its methods: no secret, no options, no session', () => {
    const parsed = FlowStepSchema.parse({
      status: 'needs_factor_enrolment',
      methods: ['totp'],
      secret: 'GEZDGNBVGY3TQOJQ',
      options: ['totp'],
    })
    expect(parsed).toEqual({ status: 'needs_factor_enrolment', methods: ['totp'] })
  })

  test('the second-factor methods a step can offer', () => {
    expect(SecondFactorMethodSchema.options).toEqual(['totp', 'passkey', 'backup_code', 'sms_code'])
  })

  test.each<[string, unknown]>([
    ['an authenticator code', { method: 'totp', code: '012345' }],
    ['a backup code', { method: 'backup_code', code: 'abcde-fghjk' }],
    ['a backup code typed loosely', { method: 'backup_code', code: ' ABCDE FGHJK ' }],
    ['a backup code of 64 characters', { method: 'backup_code', code: 'a'.repeat(64) }],
  ])('a second-factor request accepts %s', (_, body) => {
    expect(SecondFactorRequestSchema.parse(body)).toEqual(body as never)
  })

  test.each<[string, unknown]>([
    ['nothing', {}],
    ['a code with no method', { code: '123456' }],
    ['a method with no code', { method: 'totp' }],
    ['a five-digit code', { method: 'totp', code: '12345' }],
    ['a seven-digit code', { method: 'totp', code: '1234567' }],
    ['a code with a letter', { method: 'totp', code: '12345a' }],
    ['a code as a number', { method: 'totp', code: 123456 }],
    ['an empty backup code', { method: 'backup_code', code: '' }],
    ['a backup code of 65 characters', { method: 'backup_code', code: 'a'.repeat(65) }],
    ['a passkey with a code and no assertion', { method: 'passkey', code: '123456' }],
    ['an SMS code', { method: 'sms_code', code: '123456' }],
    ['a password', { method: 'password', password: 'x' }],
  ])('a second-factor request refuses %s', (_, body) => {
    expect(SecondFactorRequestSchema.safeParse(body).success).toBe(false)
  })

  test('a completed attempt may carry the backup codes, or how many are left', () => {
    const step = { status: 'complete', userId: 'u_1', sessionId: 's_1' }
    const codes = ['abcde-fghjk', 'mnpqr-stuvw']
    expect(FlowAttemptSchema.parse({ ...attempt, step, backupCodes: codes }).backupCodes).toEqual(
      codes
    )
    expect(
      FlowAttemptSchema.parse({ ...attempt, step, backupCodesRemaining: 0 }).backupCodesRemaining
    ).toBe(0)
    const plain = FlowAttemptSchema.parse({ ...attempt, step })
    expect(plain).not.toHaveProperty('backupCodes')
    expect(plain).not.toHaveProperty('backupCodesRemaining')
    for (const bad of [
      { backupCodesRemaining: -1 },
      { backupCodesRemaining: 1.5 },
      { backupCodes: [1] },
    ]) {
      expect(FlowAttemptSchema.safeParse({ ...attempt, step, ...bad }).success).toBe(false)
    }
  })

  test('an attempt waiting on an enrolment carries no session', () => {
    const waiting = FlowAttemptSchema.parse({
      ...attempt,
      step: { status: 'needs_factor_enrolment', methods: ['totp'] },
    })
    expect(waiting).not.toHaveProperty('session')
  })
})
