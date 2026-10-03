import { describe, expect, test } from 'bun:test'
import {
  FirstFactorStrategySchema,
  FlowAttemptSchema,
  FlowStepSchema,
  VerifyEmailRequestSchema,
} from './flow'
import { FLOW_ATTEMPT_HEADER } from './headers'
import { DEFAULT_WEB_SESSION_PROFILE, SessionProfileSchema } from './session-profile'
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

  test('first factors are the password, email, passkeys and the three OAuth providers', () => {
    expect(FirstFactorStrategySchema.options).toEqual([
      'password',
      'email_code',
      'email_link',
      'passkey',
      'oauth_google',
      'oauth_github',
      'oauth_apple',
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

describe('session profile', () => {
  test('default web profile matches §5.3', () => {
    expect(SessionProfileSchema.parse(DEFAULT_WEB_SESSION_PROFILE)).toMatchObject({
      type: 'hybrid',
      accessTokenTtl: '60s',
      idleTimeout: '7d',
      absoluteTimeout: '30d',
    })
  })
})

describe('refresh reuse grace window (F8)', () => {
  test('is part of the profile contract with a 10s default', () => {
    expect(DEFAULT_WEB_SESSION_PROFILE.refresh.reuseGracePeriod).toBe('10s')
    const { reuseGracePeriod: _, ...withoutGrace } = DEFAULT_WEB_SESSION_PROFILE.refresh
    expect(
      SessionProfileSchema.safeParse({ ...DEFAULT_WEB_SESSION_PROFILE, refresh: withoutGrace })
        .success
    ).toBe(false)
  })
})
