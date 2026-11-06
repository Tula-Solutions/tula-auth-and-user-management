import { describe, expect, test } from 'bun:test'
import { isHttpsUrl } from './format'
import { isSignInPopupUrl } from './https-url'

describe('isSignInPopupUrl (H-194): the SSO test pop-up, not a link (links use format.ts isHttpsUrl)', () => {
  test.each([
    'https://idp.example.com/sso?x=1',
    // A local stack's identity provider (the server allows it in the `local` tier only).
    'http://127.0.0.1:38227/v1/dev/sso/authorize',
    'http://localhost:3003/a',
    'http://[::1]:3003/a',
    'http://LOCALHOST:3003/a',
  ])('accepts %s', (url) => {
    expect(isSignInPopupUrl(url)).toBe(true)
  })
  test.each([
    'javascript:alert(1)',
    'data:text/html,<script>1</script>',
    'http://idp.example.com',
    'http://127.0.0.1.example.com',
    'http://10.0.2.2:3003',
    // The host is what follows the userinfo.
    'http://127.0.0.1@evil.example.com',
    'http://localhost.',
    'http://foo.localhost',
    '//idp.example.com',
    '/relative',
    'not a url',
    '',
  ])('refuses %s', (url) => {
    expect(isSignInPopupUrl(url)).toBe(false)
  })
})

test('a link stays https only: the pop-up rule does not reach format.ts isHttpsUrl', () => {
  expect(isSignInPopupUrl('http://localhost:3003')).toBe(true)
  expect(isHttpsUrl('http://localhost:3003')).toBe(false)
})
