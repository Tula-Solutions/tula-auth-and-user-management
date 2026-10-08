import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Tier } from '~/env'
import {
  isPublicAddress,
  type OutboundDeps,
  OutboundError,
  type OutboundFailure,
  request,
} from '~/lib/outbound'

const REFUSED_ADDRESSES: ReadonlyArray<readonly [address: string, range: string]> = [
  // IPv4
  ['0.0.0.0', 'this network'],
  ['0.1.2.3', 'this network'],
  ['10.0.0.1', 'private'],
  ['10.255.255.255', 'private'],
  ['100.64.0.1', 'carrier-grade NAT'],
  ['100.127.255.255', 'carrier-grade NAT'],
  ['127.0.0.1', 'loopback'],
  ['127.255.255.254', 'loopback'],
  ['169.254.0.1', 'link-local'],
  ['169.254.169.254', 'cloud metadata'],
  ['169.254.170.2', 'container credentials'],
  ['172.16.0.1', 'private'],
  ['172.31.255.255', 'private'],
  ['192.0.0.1', 'protocol assignments'],
  ['192.0.0.192', 'cloud metadata (Oracle)'],
  ['192.0.2.1', 'documentation'],
  ['192.88.99.1', '6to4 relay'],
  ['192.168.0.1', 'private'],
  ['192.168.255.255', 'private'],
  ['198.18.0.1', 'benchmarking'],
  ['198.19.255.255', 'benchmarking'],
  ['198.51.100.1', 'documentation'],
  ['203.0.113.1', 'documentation'],
  ['224.0.0.1', 'multicast'],
  ['239.255.255.255', 'multicast'],
  ['240.0.0.1', 'reserved'],
  ['255.255.255.255', 'broadcast'],
  // IPv6
  ['::', 'unspecified'],
  ['::1', 'loopback'],
  ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
  ['::ffff:7f00:1', 'IPv4-mapped loopback, hex form'],
  ['::ffff:10.0.0.1', 'IPv4-mapped private'],
  ['::ffff:169.254.169.254', 'IPv4-mapped metadata'],
  ['::ffff:a9fe:a9fe', 'IPv4-mapped metadata, hex form'],
  ['::ffff:100.64.0.1', 'IPv4-mapped carrier-grade NAT'],
  ['0:0:0:0:0:ffff:c0a8:1', 'IPv4-mapped private, uncompressed'],
  ['::127.0.0.1', 'IPv4-compatible'],
  ['::ffff:0:127.0.0.1', 'IPv4-translated'],
  ['64:ff9b::7f00:1', 'NAT64 to loopback'],
  ['64:ff9b::a9fe:a9fe', 'NAT64 to metadata'],
  ['64:ff9b:1::1', 'local-use NAT64'],
  ['100::1', 'discard'],
  ['2001::1', 'Teredo'],
  ['2001:db8::1', 'documentation'],
  ['2002:7f00:1::1', '6to4 to loopback'],
  ['2002:c0a8:1::1', '6to4 to private'],
  ['3fff::1', 'documentation (RFC 9637)'],
  ['fc00::1', 'unique local'],
  ['fd00:ec2::254', 'cloud metadata (AWS, IPv6)'],
  ['fdff:ffff::1', 'unique local'],
  ['fe80::1', 'link-local'],
  ['febf::1', 'link-local'],
  ['fec0::1', 'site-local'],
  ['ff02::1', 'multicast'],
  ['4000::1', 'outside global unicast'],
]

describe('isPublicAddress', () => {
  test.each(REFUSED_ADDRESSES)('refuses %s (%s)', (address) => {
    expect(isPublicAddress(address)).toBe(false)
  })

  test.each([
    ['', 'empty'],
    ['example.com', 'a name'],
    ['fe80::1%eth0', 'a zone id'],
    ['1.2.3', 'short IPv4'],
    ['1.2.3.4.5', 'long IPv4'],
    ['256.1.1.1', 'octet out of range'],
    ['01.2.3.4', 'leading zero (octal in some parsers)'],
    ['0x7f.0.0.1', 'hex octet'],
    ['1:2:3:4:5:6:7', 'short IPv6'],
    ['1:2:3:4:5:6:7:8:9', 'long IPv6'],
    ['1::2::3', 'two compressions'],
    ['12345::1', 'group too long'],
    ['[::1]', 'brackets'],
  ])('refuses %s, which is not an address (%s)', (address) => {
    expect(isPublicAddress(address)).toBe(false)
  })

  test.each([
    ['1.1.1.1'],
    ['8.8.8.8'],
    ['93.184.216.34'],
    ['100.63.255.255'],
    ['100.128.0.1'],
    ['172.15.255.255'],
    ['172.32.0.1'],
    ['192.167.255.255'],
    ['198.17.255.255'],
    ['198.20.0.1'],
    ['223.255.255.255'],
    ['2606:4700:4700::1111'],
    ['2a00:1450:4001:81b::200e'],
    ['::ffff:8.8.8.8'],
    ['::ffff:808:808'],
    ['64:ff9b::808:808'],
  ])('allows %s', (address) => {
    expect(isPublicAddress(address)).toBe(true)
  })
})

/** A resolver that answers every name with `addresses` and records what it was asked. */
function fakeResolver(...addresses: string[]) {
  const asked: string[] = []
  const resolve = async (hostname: string) => {
    asked.push(hostname)
    return addresses
  }
  return { resolve, asked }
}

/** The reason `work` was refused for, or `null` when it was not refused. */
async function refusal(work: Promise<unknown>): Promise<OutboundFailure | null> {
  try {
    await work
    return null
  } catch (error) {
    if (error instanceof OutboundError) {
      return error.reason
    }
    throw error
  }
}

const LIVE_TIERS: Tier[] = ['dev', 'staging', 'prod']

describe('request', () => {
  /** What the loopback listener was asked: the proof that a refused request was never sent. */
  let received: Array<{ method: string; url: string; host: string | null; body: string }> = []
  let respond: (req: Request) => Response | Promise<Response> = () => new Response('ok')
  const listener = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url)
      received.push({
        method: req.method,
        url: `${url.pathname}${url.search}`,
        host: req.headers.get('host'),
        body: await req.text(),
      })
      return respond(req)
    },
  })
  const port = listener.port

  beforeEach(() => {
    received = []
    respond = () => new Response('ok')
  })
  afterAll(() => listener.stop(true))

  const local = (resolve: OutboundDeps['resolve']): OutboundDeps => ({ tier: 'local', resolve })

  test('connects to the resolved address, once, and sends the name as Host', async () => {
    const { resolve, asked } = fakeResolver('127.0.0.1')
    const answer = await request(local(resolve), `http://hook.example.test:${port}/in?x=1`, {
      headers: { 'content-type': 'application/json' },
      body: '{"a":1}',
    })

    expect(answer.status).toBe(200)
    expect(new TextDecoder().decode(answer.body)).toBe('ok')
    expect(asked).toEqual(['hook.example.test'])
    expect(received).toEqual([
      { method: 'POST', url: '/in?x=1', host: `hook.example.test:${port}`, body: '{"a":1}' },
    ])
  })

  test.each(LIVE_TIERS)('refuses a loopback listener in the %s tier', async (tier) => {
    const { resolve } = fakeResolver('127.0.0.1')
    const urls = [
      `https://hook.example.test:${port}/in`,
      `https://127.0.0.1:${port}/in`,
      `https://localhost:${port}/in`,
    ]
    for (const url of urls) {
      expect(await refusal(request({ tier, resolve }, url))).toBe('address_not_allowed')
    }
    expect(received).toEqual([])
  })

  test('refuses localhost through the system resolver', async () => {
    // No injected resolver: the name is looked up as the server would look it up.
    expect(await refusal(request({ tier: 'prod' }, `https://localhost:${port}/in`))).toBe(
      'address_not_allowed'
    )
    expect(received).toEqual([])
  })

  test.each(LIVE_TIERS)('refuses http in the %s tier, before resolving', async (tier) => {
    const { resolve, asked } = fakeResolver('93.184.216.34')
    expect(await refusal(request({ tier, resolve }, 'http://hook.example.test/in'))).toBe(
      'scheme_not_allowed'
    )
    expect(asked).toEqual([])
  })

  test.each(REFUSED_ADDRESSES)('refuses a name that resolves to %s (%s)', async (address) => {
    const { resolve } = fakeResolver(address)
    expect(await refusal(request({ tier: 'prod', resolve }, 'https://hook.example.test/'))).toBe(
      'address_not_allowed'
    )
  })

  test.each(REFUSED_ADDRESSES)('refuses %s written in the URL (%s)', async (address) => {
    const { resolve, asked } = fakeResolver('93.184.216.34')
    const host = address.includes(':') ? `[${address}]` : address
    expect(await refusal(request({ tier: 'prod', resolve }, `https://${host}/`))).toBe(
      'address_not_allowed'
    )
    expect(asked).toEqual([])
  })

  test.each([
    ['https://2130706433/', 'a decimal number'],
    ['https://0x7f000001/', 'a hex number'],
    ['https://0x7f.1/', 'hex and short'],
    ['https://127.1/', 'short'],
    ['https://0177.0.0.1/', 'octal'],
    ['https://[::ffff:127.0.0.1]/', 'IPv4-mapped'],
    ['https://[0:0:0:0:0:0:0:1]/', 'uncompressed IPv6'],
  ])('refuses loopback spelled as %s (%s)', async (url) => {
    const { resolve, asked } = fakeResolver('93.184.216.34')
    expect(await refusal(request({ tier: 'prod', resolve }, url))).toBe('address_not_allowed')
    expect(asked).toEqual([])
  })

  test('refuses a name when any of its addresses is refused', async () => {
    const { resolve } = fakeResolver('93.184.216.34', '10.0.0.5')
    expect(await refusal(request({ tier: 'prod', resolve }, 'https://hook.example.test/'))).toBe(
      'address_not_allowed'
    )
  })

  test.each([['10.0.0.5'], ['192.168.1.10'], ['169.254.169.254'], ['fd00:ec2::254']])(
    'the local tier still refuses %s',
    async (address) => {
      const { resolve } = fakeResolver(address)
      expect(await refusal(request(local(resolve), 'http://hook.example.test/'))).toBe(
        'address_not_allowed'
      )
    }
  )

  test.each([
    ['not a url', 'invalid_url'],
    ['', 'invalid_url'],
    ['/relative', 'invalid_url'],
    ['ftp://hook.example.test/', 'invalid_url'],
    ['file:///etc/passwd', 'invalid_url'],
    ['https://user:secret@hook.example.test/', 'invalid_url'],
    ['https://user@hook.example.test/', 'invalid_url'],
  ] as const)('refuses %s as %s', async (url, reason) => {
    const { resolve, asked } = fakeResolver('93.184.216.34')
    expect(await refusal(request({ tier: 'prod', resolve }, url))).toBe(reason)
    expect(asked).toEqual([])
  })

  test('a name that does not resolve is resolve_failed', async () => {
    const failing = async () => {
      throw new Error('getaddrinfo ENOTFOUND canary-host')
    }
    const empty = fakeResolver()
    const url = 'https://hook.example.test/'
    expect(await refusal(request({ tier: 'prod', resolve: failing }, url))).toBe('resolve_failed')
    expect(await refusal(request({ tier: 'prod', resolve: empty.resolve }, url))).toBe(
      'resolve_failed'
    )
  })

  test('an error says nothing of the URL, the address or the transport', async () => {
    const { resolve } = fakeResolver('10.11.12.13')
    const error = await request(
      { tier: 'prod', resolve },
      'https://canary-host.example.test/canary-path?canary-query'
    ).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(OutboundError)
    const text = `${String(error)} ${JSON.stringify(error)} ${(error as Error).stack}`
    expect(text).not.toContain('canary')
    expect(text).not.toContain('10.11.12.13')
  })

  test('a redirect is returned, not followed', async () => {
    respond = (req) =>
      new URL(req.url).pathname === '/moved'
        ? new Response('followed')
        : new Response(null, {
            status: 302,
            headers: { location: `http://127.0.0.1:${port}/moved` },
          })
    const { resolve } = fakeResolver('127.0.0.1')
    const answer = await request(local(resolve), `http://hook.example.test:${port}/in`)

    expect(answer.status).toBe(302)
    expect(answer.headers.get('location')).toBe(`http://127.0.0.1:${port}/moved`)
    expect(received.map((r) => r.url)).toEqual(['/in'])
  })

  test('an answer larger than the cap is refused, declared or streamed', async () => {
    const { resolve } = fakeResolver('127.0.0.1')
    const url = `http://hook.example.test:${port}/in`

    respond = () => new Response('x'.repeat(2048))
    expect(await refusal(request(local(resolve), url, { maxResponseBytes: 1024 }))).toBe(
      'response_too_large'
    )

    respond = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (let i = 0; i < 8; i++) {
              controller.enqueue(new TextEncoder().encode('x'.repeat(512)))
            }
            controller.close()
          },
        })
      )
    expect(await refusal(request(local(resolve), url, { maxResponseBytes: 1024 }))).toBe(
      'response_too_large'
    )

    respond = () => new Response('x'.repeat(1024))
    const atTheCap = await request(local(resolve), url, { maxResponseBytes: 1024 })
    expect(atTheCap.body.length).toBe(1024)
  })

  test('an endpoint that does not answer in time is a timeout', async () => {
    respond = () => new Promise<Response>(() => {})
    const { resolve } = fakeResolver('127.0.0.1')
    const started = performance.now()
    const reason = await refusal(
      request(local(resolve), `http://hook.example.test:${port}/in`, { timeoutMs: 100 })
    )

    expect(reason).toBe('timeout')
    expect(performance.now() - started).toBeLessThan(2000)
  })

  test('the deadline covers a resolver that never answers', async () => {
    const never = () => new Promise<readonly string[]>(() => {})
    const reason = await refusal(
      request({ tier: 'prod', resolve: never }, 'https://hook.example.test/', { timeoutMs: 50 })
    )
    expect(reason).toBe('timeout')
  })

  test.each([
    ['a line break in a header value', { headers: { 'x-canary': 'a\r\nx-injected: b' } }],
    ['a header name that is not a token', { headers: { 'canary name': 'a' } }],
    ['a deadline that is not a number', { timeoutMs: Number.NaN }],
    ['a negative deadline', { timeoutMs: -1 }],
    ['a cap that is not a number', { maxResponseBytes: Number.NaN }],
  ])('refuses %s as invalid_request, and sends nothing', async (_name, init) => {
    const { resolve } = fakeResolver('127.0.0.1')
    const error = await request(local(resolve), `http://hook.example.test:${port}/in`, init).catch(
      (caught: unknown) => caught
    )

    expect(error).toBeInstanceOf(OutboundError)
    expect((error as OutboundError).reason).toBe('invalid_request')
    expect(`${String(error)} ${(error as Error).stack}`).not.toContain('canary')
    expect(received).toEqual([])
  })

  test('tries the next resolved address when one cannot be reached, without resolving again', async () => {
    // The listener is on 127.0.0.1 only: nothing answers on ::1 at its port.
    const { resolve, asked } = fakeResolver('::1', '127.0.0.1')
    const answer = await request(local(resolve), `http://hook.example.test:${port}/in`)

    expect(answer.status).toBe(200)
    expect(asked).toEqual(['hook.example.test'])
    expect(received.map((r) => r.host)).toEqual([`hook.example.test:${port}`])
  })

  test('does not send the request again once an address has received it', async () => {
    // The first address takes the request and hangs up without answering; the second would
    // answer. Delivering there too would run the receiver's side effects twice.
    let taken = 0
    const hangsUp = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        data(socket) {
          taken++
          socket.end()
        },
      },
    })
    let answered = 0
    const answers = Bun.serve({
      hostname: '::1',
      port: hangsUp.port,
      fetch() {
        answered++
        return new Response('ok')
      },
    })
    try {
      const { resolve } = fakeResolver('127.0.0.1', '::1')
      const reason = await refusal(
        request(local(resolve), `http://hook.example.test:${hangsUp.port}/in`, { body: '{}' })
      )
      expect(reason).toBe('connection_failed')
      expect(taken).toBe(1)
      expect(answered).toBe(0)
    } finally {
      hangsUp.stop(true)
      await answers.stop(true)
    }
  })

  test.each([
    ['content-length'],
    ['Content-Length'],
    ['transfer-encoding'],
    ['connection'],
    ['upgrade'],
    ['host'],
  ])("refuses a caller-set %s header: the framing is the transport's", async (name) => {
    const { resolve } = fakeResolver('127.0.0.1')
    const sent = request(local(resolve), `http://hook.example.test:${port}/in`, {
      headers: { [name]: '1' },
    })
    expect(await refusal(sent)).toBe('invalid_request')
    expect(received).toEqual([])
  })

  test('a refused connection is connection_failed', async () => {
    const closed = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() })
    const closedPort = closed.port
    await closed.stop(true)
    const { resolve } = fakeResolver('127.0.0.1')
    expect(await refusal(request(local(resolve), `http://hook.example.test:${closedPort}/`))).toBe(
      'connection_failed'
    )
  })

  describe('with a proxy in the environment', () => {
    const NAMES = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY']
    const saved = new Map<string, string | undefined>()
    beforeAll(() => {
      for (const name of NAMES) {
        saved.set(name, process.env[name])
        // The discard port: a request that went to the proxy fails.
        process.env[name] = 'http://127.0.0.1:9'
      }
    })
    afterAll(() => {
      for (const [name, value] of saved) {
        if (value === undefined) {
          delete process.env[name]
        } else {
          process.env[name] = value
        }
      }
    })

    test('the request goes straight to the endpoint', async () => {
      const { resolve } = fakeResolver('127.0.0.1')
      const answer = await request(local(resolve), `http://hook.example.test:${port}/direct`)
      expect(answer.status).toBe(200)
      expect(received.map((r) => r.url)).toEqual(['/direct'])
    })
  })

  describe('over TLS', () => {
    let directory = ''
    let ca = ''
    let secure: ReturnType<typeof Bun.serve> | undefined

    beforeAll(() => {
      directory = mkdtempSync(join(tmpdir(), 'tula-outbound-'))
      const key = join(directory, 'key.pem')
      const cert = join(directory, 'cert.pem')
      const made = Bun.spawnSync(
        [
          'openssl',
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-days',
          '2',
          '-keyout',
          key,
          '-out',
          cert,
          '-subj',
          '/CN=hook.example.test',
          '-addext',
          'subjectAltName=DNS:hook.example.test',
        ],
        // A spawn blocks the thread the runner's own timeout runs on.
        { timeout: 15_000, stdout: 'ignore', stderr: 'ignore' }
      )
      if (made.exitCode !== 0) {
        throw new Error('openssl could not make the test certificate')
      }
      ca = readFileSync(cert, 'utf8')
      secure = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        tls: { key: readFileSync(key, 'utf8'), cert: ca },
        fetch: (req) => new Response(`host=${req.headers.get('host')}`),
      })
    })
    afterAll(async () => {
      await secure?.stop(true)
      rmSync(directory, { recursive: true, force: true })
    })

    test('the certificate is checked against the name, on the resolved address', async () => {
      const { resolve } = fakeResolver('127.0.0.1')
      const answer = await request(
        { tier: 'local', resolve, ca },
        `https://hook.example.test:${secure?.port}/in`
      )
      expect(new TextDecoder().decode(answer.body)).toBe(`host=hook.example.test:${secure?.port}`)
    })

    test('a certificate for another name is refused', async () => {
      const { resolve } = fakeResolver('127.0.0.1')
      const urls = [
        `https://other.example.test:${secure?.port}/in`,
        `https://127.0.0.1:${secure?.port}/in`,
      ]
      for (const url of urls) {
        expect(await refusal(request({ tier: 'local', resolve, ca }, url))).toBe(
          'connection_failed'
        )
      }
    })

    describe('with the environment set against it', () => {
      const SET: Record<string, string> = {
        // Switches certificate checks off for anything that does not ask for them itself.
        NODE_TLS_REJECT_UNAUTHORIZED: '0',
        // The discard port: a request that went to the proxy fails.
        HTTPS_PROXY: 'http://127.0.0.1:9',
        https_proxy: 'http://127.0.0.1:9',
        ALL_PROXY: 'http://127.0.0.1:9',
      }
      const saved = new Map<string, string | undefined>()
      beforeAll(() => {
        for (const [name, value] of Object.entries(SET)) {
          saved.set(name, process.env[name])
          process.env[name] = value
        }
      })
      afterAll(() => {
        for (const [name, value] of saved) {
          if (value === undefined) {
            delete process.env[name]
          } else {
            process.env[name] = value
          }
        }
      })

      test('the request goes straight to the endpoint', async () => {
        const { resolve } = fakeResolver('127.0.0.1')
        const answer = await request(
          { tier: 'local', resolve, ca },
          `https://hook.example.test:${secure?.port}/in`
        )
        expect(answer.status).toBe(200)
      })

      test('a certificate is still checked', async () => {
        const { resolve } = fakeResolver('127.0.0.1')
        const otherName = `https://other.example.test:${secure?.port}/in`
        const rightName = `https://hook.example.test:${secure?.port}/in`
        expect(await refusal(request({ tier: 'local', resolve, ca }, otherName))).toBe(
          'connection_failed'
        )
        expect(await refusal(request(local(resolve), rightName))).toBe('connection_failed')
      })
    })

    test('a certificate from an unknown authority is refused', async () => {
      const { resolve } = fakeResolver('127.0.0.1')
      expect(
        await refusal(request(local(resolve), `https://hook.example.test:${secure?.port}/in`))
      ).toBe('connection_failed')
    })
  })
})
