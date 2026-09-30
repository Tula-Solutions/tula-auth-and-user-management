import { describe, expect, test } from 'bun:test'
import { HIBP_TIMEOUT_MS, HibpBreachChecker } from '~/adapters/breach/hibp'

// SHA-1('password') = 5BAA6 1E4C9B93F3F0682250B6CF8331B7EE68FD8
const SUFFIX = '1E4C9B93F3F0682250B6CF8331B7EE68FD8'

interface Call {
  url: string
  init?: RequestInit
}

function fakeFetch(respond: () => Response | Promise<Response>) {
  const calls: Call[] = []
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return respond()
  }) as typeof globalThis.fetch
  return { fetch, calls }
}

const body = (...lines: string[]) => new Response(lines.join('\r\n'))

describe('HibpBreachChecker', () => {
  test('sends only the 5-character SHA-1 prefix, padded, and never the password', async () => {
    const secret = 'Zebra-Quartz-9481'
    const digest = new Bun.CryptoHasher('sha1').update(secret).digest('hex').toUpperCase()
    const { fetch, calls } = fakeFetch(() => body())
    await new HibpBreachChecker({ fetch }).check(secret)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(`https://api.pwnedpasswords.com/range/${digest.slice(0, 5)}`)
    const headers = new Headers(calls[0]?.init?.headers)
    expect(headers.get('add-padding')).toBe('true')
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal)
    const sent = JSON.stringify(calls)
    expect(sent).not.toContain(secret)
    expect(sent).not.toContain(digest.slice(5))
  })

  test('reports breached when the suffix is listed with a positive count', async () => {
    const { fetch } = fakeFetch(() => body('0018A45C4D1DEF81644B54AB7F969B88D65:1', `${SUFFIX}:42`))
    expect(await new HibpBreachChecker({ fetch }).check('password')).toBe('breached')
  })

  test('matches the suffix case-insensitively', async () => {
    const { fetch } = fakeFetch(() => body(`${SUFFIX.toLowerCase()}:3`))
    expect(await new HibpBreachChecker({ fetch }).check('password')).toBe('breached')
  })

  test('treats padding entries (count 0) as clean', async () => {
    const { fetch } = fakeFetch(() => body(`${SUFFIX}:0`))
    expect(await new HibpBreachChecker({ fetch }).check('password')).toBe('clean')
  })

  test('reports clean when the suffix is absent', async () => {
    const { fetch } = fakeFetch(() => body('0018A45C4D1DEF81644B54AB7F969B88D65:12'))
    expect(await new HibpBreachChecker({ fetch }).check('password')).toBe('clean')
  })

  test('hashes the UTF-8 bytes of the password', async () => {
    const { fetch, calls } = fakeFetch(() => body())
    await new HibpBreachChecker({ fetch }).check('pässwörd')
    const expected = new Bun.CryptoHasher('sha1').update('pässwörd').digest('hex').toUpperCase()
    expect(calls[0]?.url.endsWith(expected.slice(0, 5))).toBe(true)
  })

  test.each([
    ['a non-2xx response', () => new Response('nope', { status: 503 })],
    [
      'a network error',
      () => {
        throw new TypeError('fetch failed')
      },
    ],
    [
      'a timeout',
      () => {
        throw new DOMException('The operation timed out.', 'TimeoutError')
      },
    ],
  ])('reports unknown on %s instead of throwing', async (_name, respond) => {
    const { fetch } = fakeFetch(respond)
    expect(await new HibpBreachChecker({ fetch }).check('password')).toBe('unknown')
  })

  test('uses a bounded default timeout', () => {
    expect(HIBP_TIMEOUT_MS).toBeGreaterThan(0)
    expect(HIBP_TIMEOUT_MS).toBeLessThanOrEqual(3_000)
  })
})
