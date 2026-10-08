import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { testRouteRefusal } from './guard'
import { RECEIVER_HOST, receiverResponse } from './receiver'

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

describe('the fixture’s webhook receiver', () => {
  // Called, not read: the handler is a module of its own that starts nothing.
  function ask(
    path: string,
    init: { method?: string; headers?: Record<string, string> } = {}
  ): number {
    const request = new Request(`http://${RECEIVER_HOST}${path}`, {
      method: init.method ?? 'POST',
      headers: { host: RECEIVER_HOST, ...init.headers },
    })
    return receiverResponse(request).status
  }

  test.each([
    ['/receive/204', 204],
    ['/receive/200', 200],
    ['/receive/410', 410],
    ['/receive/503', 503],
    ['/receive/599', 599],
  ])('the API’s delivery: POST %s is answered %i, with no body', async (path, status) => {
    expect(ask(path)).toBe(status)
    const answer = receiverResponse(
      new Request(`http://${RECEIVER_HOST}${path}`, {
        method: 'POST',
        headers: { host: RECEIVER_HOST },
      })
    )
    expect(await answer.text()).toBe('')
  })

  test.each([
    ['a page (it sends Origin)', { origin: 'http://localhost:4318' }],
    ['a page on the receiver’s own origin', { origin: `http://${RECEIVER_HOST}` }],
    ['another name for the same port', { host: 'localhost:4320' }],
    ['a rebound name', { host: 'evil.example:4320' }],
    ['the API’s port', { host: '127.0.0.1:4318' }],
    ['a cross-site fetch', { 'sec-fetch-site': 'cross-site' }],
    ['a same-site fetch', { 'sec-fetch-site': 'same-site' }],
  ])('%s is refused with 403, whatever status the path names', (_name, headers) => {
    expect(ask('/receive/204', { headers })).toBe(403)
    expect(ask('/receive/500', { headers })).toBe(403)
    // The refusal comes first: not even "no such path" is said to a page.
    expect(ask('/nothing-here', { headers })).toBe(403)
  })

  test('a request with no Host header is refused', () => {
    const bare = new Request(`http://${RECEIVER_HOST}/receive/204`, { method: 'POST' })
    bare.headers.delete('host')
    expect(receiverResponse(bare).status).toBe(403)
  })

  test.each([
    ['GET', '/receive/204'],
    ['PUT', '/receive/204'],
    ['DELETE', '/receive/204'],
    ['POST', '/'],
    ['POST', '/receive'],
    ['POST', '/receive/'],
    ['POST', '/receive/20'],
    ['POST', '/receive/2040'],
    ['POST', '/receive/199'],
    ['POST', '/receive/600'],
    ['POST', '/receive/abc'],
    ['POST', '/receive/204/more'],
    ['POST', '/__test/outbox'],
  ])('%s %s is 404: only a POST to a status it can answer with', (method, path) => {
    expect(ask(path, { method })).toBe(404)
  })

  test('the host it answers on is an argument, and the default is the address it is bound to', () => {
    const elsewhere = new Request('http://127.0.0.1:5000/receive/204', {
      method: 'POST',
      headers: { host: '127.0.0.1:5000' },
    })
    expect(receiverResponse(elsewhere).status).toBe(403)
    expect(receiverResponse(elsewhere, '127.0.0.1:5000').status).toBe(204)
  })
})

/**
 * Whether a source text gives the API outbound settings of its own or teaches a resolver a
 * name. Comments are left out: the fixture explains, in prose, that it does neither.
 */
function outboundTouched(text: string): boolean {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  // `outbound` as a key (`outbound:`), a shorthand (`{ …, outbound }`, `{ outbound, … }`),
  // an assignment, a call or a member; any call of `.point(`; the fake guard by name.
  return /\boutbound\s*[:=(.,}]|[{,]\s*outbound\b|\.point\(|FakeOutbound/.test(code)
}

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

  test('the webhook receiver is served by its handler alone, on the loopback address', () => {
    // The handler is tested below by calling it. What can only be read is that the fixture
    // serves nothing else on that port, and binds it to the address the handler answers on.
    const at = source.indexOf('const receiver = Bun.serve(')
    expect(at).toBeGreaterThan(-1)
    const served = source.slice(at, source.indexOf('process.stdout.write(', at))
    expect(served.replace(/\s+/g, ' ')).toBe(
      "const receiver = Bun.serve({ port: RECEIVER_PORT, hostname: '127.0.0.1', fetch: (request) => receiverResponse(request), }) "
    )
    expect(RECEIVER_HOST).toBe('127.0.0.1:4320')
    expect(routes.map((route) => route[1])).toContain('/__test/webhook-round')
  })

  test.each([
    // No outbound settings of its own, however they are written, and no name taught to a
    // resolver: deliveries pass the same guard a `local` deployment has.
    ['an `outbound` property', 'createTestDeps({ outbound: { tier } })'],
    ['the shorthand in a spread', 'const made = { ...deps, outbound }'],
    ['the shorthand alone', 'createApp({ outbound })'],
    ['the shorthand before another key', 'createApp({ outbound, clock })'],
    ['an assignment', 'deps.outbound = loose'],
    ['a member of it', 'deps.outbound.resolver.point(name, address)'],
    ['a resolver taught a name', 'resolver.point("receiver.test", "127.0.0.1")'],
    ['the fake guard', 'new FakeOutbound("local")'],
  ])('the check that the outbound guard is left alone would catch %s', (_name, line) => {
    expect(outboundTouched(line)).toBe(true)
  })

  test('the fixture leaves the outbound guard alone', () => {
    expect(outboundTouched(source)).toBe(false)
    // The check reads code, not prose: the fixture's comments do speak of the guard.
    expect(source).toContain('outbound guard')
    expect(outboundTouched('// the fixture’s outbound guard is the API’s own')).toBe(false)
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
