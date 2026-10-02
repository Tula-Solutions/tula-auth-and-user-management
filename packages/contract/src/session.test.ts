import { describe, expect, test } from 'bun:test'
import {
  REFRESH_TOKEN_PREFIX,
  RefreshTokenRequestSchema,
  SessionClientSchema,
  SessionListSchema,
  SessionSchema,
} from './session'

const session = {
  id: 's_1',
  client: 'web',
  userAgent: 'Mozilla/5.0',
  ipAddress: '203.0.113.7',
  createdAt: '2026-01-01T00:00:00.000Z',
  lastActiveAt: '2026-01-02T00:00:00.000Z',
  expiresAt: '2026-01-09T00:00:00.000Z',
  current: true,
}

describe('Session', () => {
  test('accepts a device and a list of devices', () => {
    expect(SessionSchema.parse(session)).toEqual(session as never)
    expect(SessionListSchema.parse({ data: [session] }).data).toHaveLength(1)
  })

  test('allows unknown user agent and IP, but not token material', () => {
    const parsed = SessionSchema.parse({
      ...session,
      userAgent: null,
      ipAddress: null,
      refreshToken: 'tula_rt_secret',
    })
    expect(parsed.userAgent).toBeNull()
    expect(parsed).not.toHaveProperty('refreshToken')
  })

  test.each(['web', 'ios', 'android', 'server'])('accepts client %s', (client) => {
    expect(SessionClientSchema.parse(client)).toBe(client as never)
  })

  test('rejects unknown clients', () => {
    expect(SessionClientSchema.safeParse('desktop').success).toBe(false)
  })
})

describe('RefreshTokenRequest', () => {
  test('accepts a token (native) or an empty body (browser cookie)', () => {
    const token = `${REFRESH_TOKEN_PREFIX}abc`
    expect(RefreshTokenRequestSchema.parse({ refreshToken: token })).toEqual({
      refreshToken: token,
    })
    expect(RefreshTokenRequestSchema.parse({})).toEqual({})
  })

  test('caps the token length', () => {
    expect(RefreshTokenRequestSchema.safeParse({ refreshToken: 'x'.repeat(513) }).success).toBe(
      false
    )
  })
})
