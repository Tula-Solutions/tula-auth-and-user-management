import { describe, expect, test } from 'bun:test'
import { sessionClaims } from './verify'

const config = { issuer: 'https://api.test/v1/environments/env_1', environmentId: 'env_1' }
const base = { iss: config.issuer, sub: 'u', sid: 's', aud: 'env_1', exp: 9999999999 }

// H-300: `auth_time` and `amr` are not type-checked here; the issuer signs them, and this pins
// that they reach `auth()` as signed, so a change to how they are read is a visible one.
describe('sessionClaims: authentication claims', () => {
  test('auth_time and amr pass through as the issuer signed them', () => {
    const claims = sessionClaims({ ...base, auth_time: 1700000000, amr: ['pwd', 'totp'] }, config)
    expect(claims?.auth_time).toBe(1700000000)
    expect(claims?.amr).toEqual(['pwd', 'totp'])
  })

  test('a token without them has neither', () => {
    const claims = sessionClaims(base, config)
    expect(claims).not.toBeNull()
    expect(claims && 'amr' in claims).toBe(false)
  })
})
