import { describe, expect, test } from 'bun:test'
import { isHttpsUrl } from './https-url'

describe('isHttpsUrl (H-194)', () => {
  test.each([
    'https://idp.example.com/sso?x=1',
    // A local stack's identity provider (the server allows it in the `local` tier only).
    'http://127.0.0.1:38227/v1/dev/sso/authorize',
    'http://localhost:3003/a',
    'http://[::1]:3003/a',
  ])('accepts %s', (url) => {
    expect(isHttpsUrl(url)).toBe(true)
  })
  test.each([
    'javascript:alert(1)',
    'data:text/html,<script>1</script>',
    'http://idp.example.com',
    'http://127.0.0.1.example.com',
    'http://10.0.2.2:3003',
    '//idp.example.com',
    '/relative',
    'not a url',
    '',
  ])('refuses %s', (url) => {
    expect(isHttpsUrl(url)).toBe(false)
  })
})
