import { describe, expect, test } from 'bun:test'
import { environmentIssuer, jwksUrl } from './tokens'

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
