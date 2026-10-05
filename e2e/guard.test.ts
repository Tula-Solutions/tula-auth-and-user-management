import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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

describe('the fixture’s test routes', () => {
  // The fixture cannot be imported here (it refuses to start without E2E=1 and binds ports),
  // so its source is read: a test route answered before the guard would be open to any page.
  const source = readFileSync(join(import.meta.dir, 'server.ts'), 'utf8')
  const guardAt = source.indexOf('testRouteRefusal(request,')
  const routes = [...source.matchAll(/url\.pathname === '(\/__test\/[a-z-]+)'/g)]

  test('every one is answered only after the guard has let the request through', () => {
    expect(guardAt).toBeGreaterThan(-1)
    expect(routes.length).toBeGreaterThan(0)
    for (const route of routes) {
      expect(`${route[1]}: ${(route.index ?? -1) > guardAt}`).toBe(`${route[1]}: true`)
    }
    // No test route is matched any other way (a prefix, a pattern) outside that function.
    expect(source.match(/\/__test\/[a-z-]+'/g)?.length).toBe(routes.length)
  })

  test('the clock a scenario moved forward can be put back, behind the same guard', () => {
    const names = routes.map((route) => route[1])
    expect(names).toContain('/__test/advance-clock')
    expect(names).toContain('/__test/reset-clock')
    for (const path of ['/__test/advance-clock', '/__test/reset-clock']) {
      const page = request({ host: HOST, origin: 'http://localhost:4319' }, path)
      expect(testRouteRefusal(page, HOST)).not.toBeNull()
      const rebound = request({ host: 'evil.example:4318' }, path)
      expect(testRouteRefusal(rebound, HOST)).not.toBeNull()
    }
  })
})
