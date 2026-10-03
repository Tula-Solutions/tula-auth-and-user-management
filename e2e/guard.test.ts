import { describe, expect, test } from 'bun:test'
import { testRouteRefusal } from './guard'

// Run with the harness tests (`bun run test:harness`, part of verify): the browser suite
// itself is not, and this guard is what keeps the fixture's test routes away from web pages.

const HOST = 'localhost:4318'

function request(headers: Record<string, string>, path = '/__test/outbox'): Request {
  return new Request(`http://${HOST}${path}`, { headers })
}

describe('who may call the e2e fixture’s test routes', () => {
  test('the test process: the bound host, no Origin, no fetch metadata', () => {
    expect(testRouteRefusal(request({ host: HOST }), HOST)).toBeNull()
  })

  test.each(['none', 'same-origin'])('Sec-Fetch-Site: %s is allowed', (site) => {
    expect(testRouteRefusal(request({ host: HOST, 'sec-fetch-site': site }), HOST)).toBeNull()
  })

  test('a page on another origin (it sends Origin)', () => {
    expect(
      testRouteRefusal(request({ host: HOST, origin: 'http://localhost:4317' }), HOST)
    ).not.toBeNull()
  })

  test.each([
    'evil.example:4318',
    'evil.example',
    'localhost',
    'localhost:4317',
    '127.0.0.1:4318',
    'LOCALHOST:4318.evil.example',
    '',
  ])('a rebound name: Host %p is not the host the server bound to', (host) => {
    // A DNS-rebinding page is same-origin with itself, so its GET carries no Origin; the Host
    // header still names the attacker's domain.
    expect(testRouteRefusal(request({ host }), HOST)).not.toBeNull()
  })

  test('a request with no Host header at all', () => {
    const bare = new Request(`http://${HOST}/__test/outbox`)
    bare.headers.delete('host')
    expect(testRouteRefusal(bare, HOST)).not.toBeNull()
  })

  test.each(['cross-site', 'same-site', 'anything-else'])(
    'Sec-Fetch-Site: %s is refused even with the right Host',
    (site) => {
      expect(testRouteRefusal(request({ host: HOST, 'sec-fetch-site': site }), HOST)).not.toBeNull()
    }
  )
})
