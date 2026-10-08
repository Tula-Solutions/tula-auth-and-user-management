import { describe, expect, test } from 'bun:test'
import { allowedOrigin } from '~/lib/cors'

const configured = { tier: 'prod' as const, corsOrigins: ['https://app.example.com'] }
const local = { tier: 'local' as const, corsOrigins: [] }

describe('allowedOrigin', () => {
  test.each([
    ['no origin', '', configured, null],
    [
      'an exact configured origin',
      'https://app.example.com',
      configured,
      'https://app.example.com',
    ],
    ['a suffix-lookalike origin', 'https://app.example.com.evil.test', configured, null],
    ['a different scheme', 'http://app.example.com', configured, null],
    ['loopback outside local', 'http://localhost:5173', configured, null],
    ['localhost in local', 'http://localhost:5173', local, 'http://localhost:5173'],
    ['127.0.0.1 in local', 'http://127.0.0.1:3000', local, 'http://127.0.0.1:3000'],
    ['IPv6 loopback in local', 'http://[::1]:3000', local, 'http://[::1]:3000'],
    ['a localhost lookalike in local', 'http://localhost.evil.test', local, null],
    ['https loopback in local', 'https://localhost:5173', local, null],
  ])('%s', (_, origin, config, expected) => {
    expect(allowedOrigin(origin, config)).toBe(expected)
  })
})
