import { describe, expect, test } from 'bun:test'
import { devSmsCodes, devSmsTexts, SMS_INBOX_TIMEOUT_MS, smsCodeIn } from './sms-inbox'

const NUMBER = '+12025550142'

type Answer = number | { messages: { to?: string; text?: string; sentAt?: string }[] }

/** Inboxes by origin; each answers its list in order and then repeats its last answer. */
function fakeInboxes(inboxes: Record<string, Answer[]>) {
  const urls: string[] = []
  const sleeps: number[] = []
  const asked: Record<string, number> = {}
  const smsCode = devSmsCodes(Object.keys(inboxes), {
    fetch: (async (url: string) => {
      urls.push(url)
      const origin = new URL(url).origin
      const answers = inboxes[origin] ?? []
      const index = asked[origin] ?? 0
      asked[origin] = index + 1
      const answer = answers[Math.min(index, answers.length - 1)] ?? { messages: [] }
      return typeof answer === 'number'
        ? new Response('nope', { status: answer })
        : Response.json(answer)
    }) as unknown as typeof fetch,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
  })
  return { smsCode, urls, sleeps }
}

const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString()

describe('smsCodeIn', () => {
  test.each([
    ['Your Acme verification code is 482913.', '482913'],
    ['Your Acme verification code is 482913.\n\n@app.example.com #482913', '482913'],
    // An app's name may hold digits, even six of them: the code is the last run.
    ['Your Studio 123456 verification code is 000042.', '000042'],
    ['Your 24x7 verification code is 900001.\n\n@localhost #900001', '900001'],
  ])('%j holds %s', (text, code) => {
    expect(smsCodeIn(text)).toBe(code)
  })

  test.each([
    ['', 'nothing'],
    ['Your code is 12345.', 'five digits'],
    ['Call +14155550142 now', 'a longer number'],
    ['Order 1234567 shipped', 'seven digits'],
  ])('%j holds no code (%s)', (text) => {
    expect(smsCodeIn(text)).toBeNull()
  })
})

describe('devSmsCodes', () => {
  test('reads the code of the newest message to the number, asking for that number', async () => {
    const { smsCode, urls } = fakeInboxes({
      'http://one.test': [
        {
          messages: [
            { to: NUMBER, text: 'Your Acme verification code is 111111.', sentAt: at(1) },
            { to: NUMBER, text: 'Your Acme verification code is 482913.', sentAt: at(2) },
          ],
        },
      ],
    })
    expect(await smsCode(NUMBER)).toBe('482913')
    expect(urls).toEqual(['http://one.test/v1/dev/sms/messages?to=%2B12025550142'])
  })

  test('with several instances the newest message across all of them is read', async () => {
    const { smsCode } = fakeInboxes({
      'http://one.test': [{ messages: [{ to: NUMBER, text: 'code is 222222.', sentAt: at(5) }] }],
      'http://two.test': [{ messages: [{ to: NUMBER, text: 'code is 111111.', sentAt: at(3) }] }],
    })
    expect(await smsCode(NUMBER)).toBe('222222')
    const other = fakeInboxes({
      'http://one.test': [{ messages: [] }],
      'http://two.test': [{ messages: [{ to: NUMBER, text: 'code is 333333.', sentAt: at(3) }] }],
    })
    expect(await other.smsCode(NUMBER)).toBe('333333')
  })

  test('a message to another number is never read, even if the inbox returns it', async () => {
    const { smsCode, sleeps } = fakeInboxes({
      'http://one.test': [
        { messages: [{ to: '+12025550199', text: 'code is 999999.', sentAt: at(9) }] },
      ],
    })
    await expect(smsCode(NUMBER)).rejects.toThrow('no text message with a code arrived')
    expect(sleeps.length).toBe(SMS_INBOX_TIMEOUT_MS / 100 + 1)
  })

  test('waits for a message that has not arrived yet', async () => {
    const { smsCode, sleeps } = fakeInboxes({
      'http://one.test': [
        { messages: [] },
        { messages: [] },
        { messages: [{ to: NUMBER, text: 'code is 000042.', sentAt: at(1) }] },
      ],
    })
    expect(await smsCode(NUMBER)).toBe('000042')
    expect(sleeps).toEqual([100, 100])
  })

  test('a server with no inbox is an error at once, and the error holds no number', async () => {
    const { smsCode, urls } = fakeInboxes({ 'http://one.test': [404] })
    const error = await smsCode(NUMBER).catch((thrown: Error) => thrown)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('the SMS inbox at http://one.test answered 404')
    expect(urls).toHaveLength(1)
  })

  test.each(['12025550142', '+1 202 555 0142', '+1202555014&to=x', '', '+123'])(
    'refuses to look for %p',
    async (to) => {
      const { smsCode, urls } = fakeInboxes({ 'http://one.test': [{ messages: [] }] })
      await expect(smsCode(to)).rejects.toThrow('not a phone number the runner can look for')
      expect(urls).toEqual([])
    }
  )
})

describe('devSmsTexts', () => {
  const inbox = (messages: { to: string; text: string; sentAt: string }[]) =>
    devSmsTexts(['http://one.test'], {
      fetch: (async () => Response.json({ messages })) as unknown as typeof fetch,
      sleep: async () => undefined,
    })

  test('returns the whole text of the newest message to the number, its last line included', async () => {
    const text = 'Welcome to Acme. Use 482913 now\n@app.example #482913'
    const smsText = inbox([
      { to: NUMBER, text: 'Your Acme verification code is 111111.', sentAt: at(1) },
      { to: NUMBER, text, sentAt: at(2) },
    ])
    expect(await smsText(NUMBER)).toBe(text)
  })

  test('a message that carries no code is not one it returns', async () => {
    const smsText = inbox([{ to: NUMBER, text: 'Welcome to Acme.', sentAt: at(1) }])
    await expect(smsText(NUMBER)).rejects.toThrow('no text message with a code arrived')
  })

  test('refuses to look for something that is not a number', async () => {
    await expect(inbox([])('+1 202')).rejects.toThrow('not a phone number the runner can look for')
  })
})
