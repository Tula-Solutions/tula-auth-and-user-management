import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { clientIp, ipBucket } from '~/lib/client-ip'

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

describe('ipBucket', () => {
  test.each([
    ['203.0.113.7', '203.0.113.7'],
    // An IPv4 address written as IPv6 is the same client.
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['::FFFF:cb00:7107', '203.0.113.7'],
    ['0:0:0:0:0:ffff:203.0.113.7', '203.0.113.7'],
    // One subscriber normally holds a whole /64: every address in it is one bucket.
    ['2001:db8:1:2::1', '2001:db8:1:2::/64'],
    ['2001:db8:1:2:ffff:ffff:ffff:ffff', '2001:db8:1:2::/64'],
    ['2001:0DB8:0001:0002:0:0:0:9', '2001:db8:1:2::/64'],
    ['2001:db8:1:3::1', '2001:db8:1:3::/64'],
    ['::1', '0:0:0:0::/64'],
    ['fe80::1%eth0', 'fe80:0:0:0::/64'],
    // Not an address: left as it is, so it still gets a bucket of its own.
    ['unknown', 'unknown'],
    ['', ''],
    ['1:2:3', '1:2:3'],
    ['2001:db8::g', '2001:db8::g'],
    ['1::2::3', '1::2::3'],
  ])('%p is counted as %p', (address, bucket) => {
    expect(ipBucket(address)).toBe(bucket)
  })
})
