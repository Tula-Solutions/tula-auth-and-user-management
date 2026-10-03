import { describe, expect, test } from 'bun:test'
import { MAILPIT_TIMEOUT_MS, mailpitCodes } from './mailpit'

function fakeMailpit(responses: (object | number)[]) {
  const urls: string[] = []
  const sleeps: number[] = []
  const emailCode = mailpitCodes('http://mailpit.test', {
    fetch: (async (url: string) => {
      urls.push(url)
      const next = responses[Math.min(urls.length - 1, responses.length - 1)]
      return typeof next === 'number'
        ? new Response('nope', { status: next })
        : new Response(JSON.stringify(next))
    }) as unknown as typeof fetch,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
  })
  return { emailCode, urls, sleeps }
}

describe('mailpitCodes', () => {
  test('returns the code that leads the newest message’s subject', async () => {
    const { emailCode, urls } = fakeMailpit([
      { messages: [{ Subject: '482913 is your verification code' }] },
    ])
    expect(await emailCode('maya+test@example.com')).toBe('482913')
    expect(urls).toEqual([
      'http://mailpit.test/api/v1/search?query=to%3A%22maya%2Btest%40example.com%22&limit=10',
    ])
  })

  test('a notice that arrived after the code does not hide it', async () => {
    const { emailCode } = fakeMailpit([
      {
        messages: [
          { Subject: 'New sign-in to your Acme account' },
          { Subject: 'Your Acme password was changed' },
          { Subject: '482913 is your Acme password reset code' },
          { Subject: '111111 is your Acme verification code' },
        ],
      },
    ])
    expect(await emailCode('maya@example.com')).toBe('482913')
  })

  test('waits for a message that has not arrived yet', async () => {
    const { emailCode, sleeps } = fakeMailpit([
      { messages: [] },
      {},
      { messages: [{ Subject: 'Someone tried to sign up with your email' }] },
      { messages: [{ Subject: '000042 is your verification code' }] },
    ])
    expect(await emailCode('maya@example.com')).toBe('000042')
    expect(sleeps).toEqual([100, 100, 100])
  })

  test('gives up after the timeout, naming the address', async () => {
    const { emailCode, sleeps } = fakeMailpit([{ messages: [] }])
    await expect(emailCode('maya@example.com')).rejects.toThrow(
      'no email with a code arrived for maya@example.com'
    )
    expect(sleeps.reduce((total, ms) => total + ms, 0)).toBeGreaterThanOrEqual(MAILPIT_TIMEOUT_MS)
  })

  test('a Mailpit error is reported, not retried forever', async () => {
    const { emailCode, urls } = fakeMailpit([503])
    await expect(emailCode('maya@example.com')).rejects.toThrow('Mailpit answered 503')
    expect(urls).toHaveLength(1)
  })

  test('refuses an address that would break out of the search query', async () => {
    const { emailCode, urls } = fakeMailpit([{ messages: [{ Subject: '111111 code' }] }])
    await expect(emailCode('a" OR to:"victim@example.com')).rejects.toThrow(
      'not an address the runner can search for'
    )
    expect(urls).toEqual([])
  })

  test('every request has a deadline, so a stalled Mailpit cannot hang the run', async () => {
    const signals: (AbortSignal | undefined)[] = []
    const emailCode = mailpitCodes('http://mailpit.test', {
      fetch: (async (_url: string, init?: RequestInit) => {
        signals.push(init?.signal ?? undefined)
        return new Response(JSON.stringify({ messages: [{ Subject: '222222 code' }] }))
      }) as unknown as typeof fetch,
    })
    expect(await emailCode('maya@example.com')).toBe('222222')
    expect(signals[0]).toBeInstanceOf(AbortSignal)
  })
})
