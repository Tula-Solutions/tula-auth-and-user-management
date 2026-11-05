import { describe, expect, test } from 'bun:test'
import { isHttpsUrl } from './https-url'

describe('isHttpsUrl (H-194)', () => {
  test.each(['https://idp.example.com/sso?x=1'])('accepts %s', (url) => {
    expect(isHttpsUrl(url)).toBe(true)
  })
  test.each([
    'javascript:alert(1)',
    'data:text/html,<script>1</script>',
    'http://idp.example.com',
    '//idp.example.com',
    '/relative',
    'not a url',
    '',
  ])('refuses %s', (url) => {
    expect(isHttpsUrl(url)).toBe(false)
  })
})
