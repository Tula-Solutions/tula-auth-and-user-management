import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { clientIp } from '~/lib/client-ip'

function ipFor(headers: Record<string, string>, trustProxy: boolean, env?: unknown) {
  const app = new Hono()
  app.get('/', (c) => c.text(clientIp(c, trustProxy)))
  return Promise.resolve(app.request('/', { headers }, env as never)).then((res) => res.text())
}

const bunServer = { requestIP: () => ({ address: '198.51.100.9' }) }

describe('clientIp', () => {
  test('uses the socket peer when the proxy is not trusted', async () => {
    expect(await ipFor({ 'x-forwarded-for': '1.2.3.4' }, false, bunServer)).toBe('198.51.100.9')
  })

  test('uses the last X-Forwarded-For hop behind a trusted proxy', async () => {
    expect(await ipFor({ 'x-forwarded-for': 'forged, 203.0.113.7 ' }, true, bunServer)).toBe(
      '203.0.113.7'
    )
  })

  test('falls back to the socket peer when the header is missing', async () => {
    expect(await ipFor({}, true, bunServer)).toBe('198.51.100.9')
  })

  test('reports unknown without a Bun server', async () => {
    expect(await ipFor({}, false)).toBe('unknown')
  })
})
