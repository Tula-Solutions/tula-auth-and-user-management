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

  test('the webhook receiver is guarded on its own address, and the outbound guard is left alone', () => {
    const receiver = '127.0.0.1:4320'
    expect(source).toContain('export const RECEIVER_PORT = 4320')
    // Bound to the loopback address and guarded for exactly that host: a page cannot post
    // to it (an `Origin`), nor reach it under another name.
    const at = source.indexOf('const receiver = Bun.serve(')
    const body = source.slice(at, source.indexOf('process.stdout.write(', at))
    expect(body).toContain("hostname: '127.0.0.1'")
    expect(body).toContain('testRouteRefusal(request, `127.0.0.1:${RECEIVER_PORT}`)')
    expect(body.indexOf('testRouteRefusal(')).toBeLessThan(body.indexOf('new URL(request.url)'))
    expect(body.indexOf('new URL(request.url)')).toBeGreaterThan(-1)
    const post = (headers: Record<string, string>) =>
      new Request(`http://${receiver}/receive/204`, { method: 'POST', headers })
    expect(testRouteRefusal(post({ host: receiver }), receiver)).toBeNull()
    expect(
      testRouteRefusal(post({ host: receiver, origin: 'http://localhost:4318' }), receiver)
    ).not.toBeNull()
    expect(testRouteRefusal(post({ host: 'localhost:4320' }), receiver)).not.toBeNull()
    // The fixture gives the API no outbound settings of its own and teaches its resolver no
    // name: deliveries pass the same guard a `local` deployment has.
    expect(source).not.toMatch(/\boutbound\s*[:=(.]/)
    expect(source).not.toContain('.point(')
    expect(source).not.toContain('FakeOutbound')
    expect(routes.map((route) => route[1])).toContain('/__test/webhook-round')
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
