import { describe, expect, test } from 'bun:test'
import {
  AccessTokenClaimsSchema,
  AUTHENTICATION_METHODS,
  environmentIssuer,
  jwksUrl,
  STEP_UP_MAX_AGE_SECONDS,
} from './tokens'

describe('environmentIssuer', () => {
  test.each([
    ['https://auth.example.com', 'https://auth.example.com/v1/environments/e1'],
    ['https://auth.example.com/', 'https://auth.example.com/v1/environments/e1'],
    ['http://localhost:3003//', 'http://localhost:3003/v1/environments/e1'],
    ['https://example.com/auth', 'https://example.com/auth/v1/environments/e1'],
  ])('%s', (apiUrl, expected) => {
    expect(environmentIssuer(apiUrl, 'e1')).toBe(expected)
  })

  test('escapes the environment id', () => {
    expect(environmentIssuer('https://a.test', '../x')).toBe(
      'https://a.test/v1/environments/..%2Fx'
    )
  })
})

describe('jwksUrl', () => {
  test('appends the well-known path to the issuer', () => {
    expect(jwksUrl(environmentIssuer('https://a.test', 'e1'))).toBe(
      'https://a.test/v1/environments/e1/.well-known/jwks.json'
    )
    expect(jwksUrl('https://a.test/x/')).toBe('https://a.test/x/.well-known/jwks.json')
  })
})

describe('access token claims about how the session was authenticated', () => {
  const claims = {
    iss: 'i',
    sub: 'u',
    aud: 'e',
    sid: 's',
    pid: 'p',
    eid: 'e',
    iat: 1,
    exp: 2,
    v: 1,
  }

  test('a token with auth_time and amr parses with both', () => {
    const parsed = AccessTokenClaimsSchema.parse({
      ...claims,
      auth_time: 1_767_225_600,
      amr: ['pwd', 'otp', 'mfa'],
    })
    expect(parsed.auth_time).toBe(1_767_225_600)
    expect(parsed.amr).toEqual(['pwd', 'otp', 'mfa'])
  })

  test('a token issued before they existed still parses, with neither', () => {
    const parsed = AccessTokenClaimsSchema.parse(claims)
    expect(parsed.auth_time).toBeUndefined()
    expect(parsed.amr).toBeUndefined()
  })

  test('an empty amr and a method a later server added are accepted', () => {
    expect(AccessTokenClaimsSchema.parse({ ...claims, auth_time: 1, amr: [] }).amr).toEqual([])
    expect(
      AccessTokenClaimsSchema.parse({ ...claims, auth_time: 1, amr: ['pwd', 'hwk', 'mfa'] }).amr
    ).toEqual(['pwd', 'hwk', 'mfa'])
  })

  test.each<[string, Record<string, unknown>]>([
    ['auth_time as a string', { auth_time: '1767225600' }],
    ['auth_time as a fraction', { auth_time: 1.5 }],
    ['auth_time as null', { auth_time: null }],
    ['amr as a string', { amr: 'pwd' }],
    ['amr holding a number', { amr: ['pwd', 1] }],
    ['amr as null', { amr: null }],
  ])('refuses %s', (_, change) => {
    expect(AccessTokenClaimsSchema.safeParse({ ...claims, ...change }).success).toBe(false)
  })

  test('the methods this version issues, and how long a proof counts as recent', () => {
    expect(AUTHENTICATION_METHODS).toEqual([
      'pwd',
      'email',
      'otp',
      'backup_code',
      'mfa',
      'hwk',
      'swk',
      'user',
    ])
    expect(new Set(AUTHENTICATION_METHODS).size).toBe(AUTHENTICATION_METHODS.length)
    expect(STEP_UP_MAX_AGE_SECONDS).toBe(600)
  })
})
