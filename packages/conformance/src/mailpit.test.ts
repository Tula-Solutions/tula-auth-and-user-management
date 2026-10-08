import { describe, expect, test } from 'bun:test'
import { MAILPIT_TIMEOUT_MS, mailpitCodes, mailpitLinks } from './mailpit'

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

describe('mailpitLinks', () => {
  const LINK = 'https://app.example.com/auth/link#tula_link=l1nk-t0k3n&tula_attempt=attempt-1'

  /** A Mailpit that answers the search with `lists` in turn and a message fetch with `text`. */
  function fakeInbox(lists: (object | number)[], text = `Enter 482913\n\nOr open: ${LINK}\n\nBye`) {
    const urls: string[] = []
    const sleeps: number[] = []
    let searches = 0
    const emailLink = mailpitLinks('http://mailpit.test', {
      fetch: (async (url: string) => {
        urls.push(url)
        if (url.includes('/api/v1/message/')) {
          return new Response(JSON.stringify({ Text: text }))
        }
        const next = lists[Math.min(searches, lists.length - 1)]
        searches += 1
        return typeof next === 'number'
          ? new Response('nope', { status: next })
          : new Response(JSON.stringify(next))
      }) as unknown as typeof fetch,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    })
    return { emailLink, urls, sleeps }
  }

  test('fetches the newest email that leads with a code and returns the link in its text', async () => {
    const { emailLink, urls } = fakeInbox([
      {
        messages: [
          { ID: 'notice-1', Subject: 'New sign-in to your Acme account' },
          { ID: 'code/2', Subject: '482913 is your Acme sign-in code' },
          { ID: 'older-3', Subject: '111111 is your Acme sign-in code' },
        ],
      },
    ])
    expect(await emailLink('maya@example.com')).toBe(LINK)
    expect(urls).toEqual([
      'http://mailpit.test/api/v1/search?query=to%3A%22maya%40example.com%22&limit=10',
      'http://mailpit.test/api/v1/message/code%2F2',
    ])
  })

  test('waits for the email, then gives up naming the address', async () => {
    const waiting = fakeInbox([
      { messages: [] },
      {},
      { messages: [{ ID: 'm1', Subject: '1 no' }] },
      {
        messages: [{ ID: 'm2', Subject: '482913 is your code' }],
      },
    ])
    expect(await waiting.emailLink('maya@example.com')).toBe(LINK)
    expect(waiting.sleeps).toEqual([100, 100, 100])

    const never = fakeInbox([{ messages: [] }])
    await expect(never.emailLink('maya@example.com')).rejects.toThrow(
      'no email with a link arrived for maya@example.com'
    )
    expect(never.sleeps.reduce((total, ms) => total + ms, 0)).toBeGreaterThanOrEqual(
      MAILPIT_TIMEOUT_MS
    )
  })

  test('a code email with no link in it is an error, not a wait', async () => {
    const { emailLink, sleeps } = fakeInbox(
      [{ messages: [{ ID: 'm1', Subject: '482913 is your code' }] }],
      'Enter 482913. No link here: https://app.example.com/help'
    )
    await expect(emailLink('maya@example.com')).rejects.toThrow(
      'the newest code email for maya@example.com holds no link'
    )
    expect(sleeps).toEqual([])
  })

  test('a message with no text at all holds no link', async () => {
    const urls: string[] = []
    const emailLink = mailpitLinks('http://mailpit.test', {
      fetch: (async (url: string) => {
        urls.push(url)
        return new Response(
          JSON.stringify(
            url.includes('/message/') ? {} : { messages: [{ ID: 'm1', Subject: '482913 code' }] }
          )
        )
      }) as unknown as typeof fetch,
    })
    await expect(emailLink('maya@example.com')).rejects.toThrow('holds no link')
  })

  test('a Mailpit error is reported, and a hostile address never reaches the query', async () => {
    const failing = fakeInbox([503])
    await expect(failing.emailLink('maya@example.com')).rejects.toThrow('Mailpit answered 503')
    const { emailLink, urls } = fakeInbox([{ messages: [] }])
    await expect(emailLink('a" OR to:"victim@example.com')).rejects.toThrow(
      'not an address the runner can search for'
    )
    expect(urls).toEqual([])
  })
})
