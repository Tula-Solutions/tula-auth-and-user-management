import { afterEach, describe, expect, type Mock, spyOn, test } from 'bun:test'
import { PROVIDER_TIMEOUT_MS } from '~/adapters/oauth/id-token'
import { smsSenderSuite } from '~/adapters/sms-sender.suite'
import * as logger from '~/lib/logger'
import { SmsSendError } from '~/ports/sms-sender'
import {
  createTwilioSmsSender,
  maskProviderMessage,
  TWILIO_API_ORIGIN,
  TWILIO_MAX_LOGGED_MESSAGE,
  TWILIO_MAX_RESPONSE_BYTES,
  type TwilioSmsOptions,
} from './twilio'

// Nothing here reaches Twilio: `fetch` is stubbed in every test, and a test that forgot to
// would fail on the stub's absence, not send a message.

const ACCOUNT_SID = `AC${'0a1b2c3d'.repeat(4)}`
const API_KEY_SID = `SK${'9f8e7d6c'.repeat(4)}`
const API_KEY_SECRET = 'KeySecret-canary-Zq7Lm2Xw9Rt4Vb6Ny8Pd'
const AUTH_TOKEN = 'AuthToken-canary-5f3a9c1e7b2d4f6a8c0e'
const SERVICE_SID = `MG${'1122aabb'.repeat(4)}`
const FROM_NUMBER = '+15005550006'
const MESSAGE_SID = `SM${'abcdef01'.repeat(4)}`
const TO = '+14155550142'
const MESSAGE = { to: TO, text: 'Your Northline verification code is 739204.' }

const WITH_API_KEY: TwilioSmsOptions = {
  accountSid: ACCOUNT_SID,
  credentials: { kind: 'api_key', sid: API_KEY_SID, secret: API_KEY_SECRET },
  sender: { kind: 'messaging_service', sid: SERVICE_SID },
}
const WITH_AUTH_TOKEN: TwilioSmsOptions = {
  accountSid: ACCOUNT_SID,
  credentials: { kind: 'auth_token', token: AUTH_TOKEN },
  sender: { kind: 'number', number: FROM_NUMBER },
}

type FetchStub = (input: unknown, init?: RequestInit) => Promise<Response>
// Typed loosely on purpose: the stub stands in for `fetch`, whose own type has overloads
// (and Bun's `preconnect`) a test double has no use for.
type FetchSpy = Mock<FetchStub>

let fetchSpy: FetchSpy | undefined
const spies: { mockRestore: () => void }[] = []

function stubFetch(stub: FetchStub): FetchSpy {
  fetchSpy?.mockRestore()
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
    stub as unknown as typeof fetch
  ) as unknown as FetchSpy
  return fetchSpy
}

function accepted(): Response {
  return Response.json({ sid: MESSAGE_SID, status: 'queued', to: TO }, { status: 201 })
}

function quiet(level: 'warn' | 'debug') {
  const spy = spyOn(logger, level).mockImplementation(() => {})
  spies.push(spy)
  return spy
}

afterEach(() => {
  fetchSpy?.mockRestore()
  fetchSpy = undefined
  for (const spy of spies.splice(0)) {
    spy.mockRestore()
  }
})

/** The one request a send made: where to, and with what. */
function requestOf(spy: FetchSpy) {
  expect(spy).toHaveBeenCalledTimes(1)
  const [input, init] = spy.mock.calls[0] ?? []
  const headers = new Headers(init?.headers)
  return { url: String(input), init: init ?? {}, headers, body: String(init?.body) }
}

smsSenderSuite(
  'Twilio',
  () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => {})
    const debug = spyOn(logger, 'debug').mockImplementation(() => {})
    let failing = false
    const stub = spyOn(globalThis, 'fetch').mockImplementation((async () =>
      failing
        ? Response.json({ code: 20003, message: 'Authenticate', status: 401 }, { status: 401 })
        : accepted()) as unknown as typeof fetch)
    return {
      sender: createTwilioSmsSender(WITH_API_KEY),
      fail: () => {
        failing = true
      },
      cleanup: () => {
        stub.mockRestore()
        warn.mockRestore()
        debug.mockRestore()
      },
    }
  },
  { configured: true }
)

describe('the request', () => {
  test('is one POST to the account’s Messages resource on Twilio’s own host', async () => {
    quiet('debug')
    const spy = stubFetch(async () => accepted())
    await createTwilioSmsSender(WITH_API_KEY).send(MESSAGE)
    const { url, init, headers } = requestOf(spy)
    expect(TWILIO_API_ORIGIN).toBe('https://api.twilio.com')
    expect(url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`)
    expect(init.method).toBe('POST')
    expect(headers.get('content-type')).toBe('application/x-www-form-urlencoded;charset=UTF-8')
    expect(headers.get('accept')).toBe('application/json')
  })

  test('follows no redirect, checks the certificate and carries a signal', async () => {
    quiet('debug')
    const spy = stubFetch(async () => accepted())
    await createTwilioSmsSender(WITH_API_KEY).send(MESSAGE)
    const { init } = requestOf(spy)
    // A redirect would carry the credentials to wherever it points.
    expect(init.redirect).toBe('error')
    expect((init as { tls?: unknown }).tls).toEqual({ rejectUnauthorized: true })
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  test('an API key authenticates as the key and its secret', async () => {
    quiet('debug')
    const spy = stubFetch(async () => accepted())
    await createTwilioSmsSender(WITH_API_KEY).send(MESSAGE)
    expect(requestOf(spy).headers.get('authorization')).toBe(
      `Basic ${btoa(`${API_KEY_SID}:${API_KEY_SECRET}`)}`
    )
  })

  test('an auth token authenticates as the account and the token', async () => {
    quiet('debug')
    const spy = stubFetch(async () => accepted())
    await createTwilioSmsSender(WITH_AUTH_TOKEN).send(MESSAGE)
    expect(requestOf(spy).headers.get('authorization')).toBe(
      `Basic ${btoa(`${ACCOUNT_SID}:${AUTH_TOKEN}`)}`
    )
  })

  test('a Messaging Service is named by its field, and no number beside it', async () => {
    quiet('debug')
    const spy = stubFetch(async () => accepted())
    await createTwilioSmsSender(WITH_API_KEY).send(MESSAGE)
    const form = new URLSearchParams(requestOf(spy).body)
    expect(form.get('MessagingServiceSid')).toBe(SERVICE_SID)
    expect(form.has('From')).toBe(false)
  })

  test('a number is sent as From, and no service beside it', async () => {
    quiet('debug')
    const spy = stubFetch(async () => accepted())
    await createTwilioSmsSender(WITH_AUTH_TOKEN).send(MESSAGE)
    const form = new URLSearchParams(requestOf(spy).body)
    expect(form.get('From')).toBe(FROM_NUMBER)
    expect(form.has('MessagingServiceSid')).toBe(false)
  })

  test('sends the recipient, the sender and the text, and no option that changes either', async () => {
    quiet('debug')
    const spy = stubFetch(async () => accepted())
    await createTwilioSmsSender(WITH_API_KEY).send(MESSAGE)
    const form = new URLSearchParams(requestOf(spy).body)
    // No shortening, scheduling, callback, validity period or risk setting: the names here
    // are the whole request.
    expect([...form.keys()].sort()).toEqual(['Body', 'MessagingServiceSid', 'To'])
    expect(form.get('To')).toBe(TO)
    expect(form.get('Body')).toBe(MESSAGE.text)
  })

  test.each([
    ['a plus sign', '+4915112345678', 'code 123456'],
    ['a name that is not ASCII', TO, 'Ihr Zürich-Café „Ærø“ 東京 Code ist 123456.'],
    [
      'the line break before the origin line',
      TO,
      'Your Acme verification code is 123456.\n\n@app.example.com #123456',
    ],
    ['what a form would take for a separator', TO, 'a&b=c+d %2B e;f#g?h 100%'],
    ['an emoji', TO, 'Code 123456 🔐'],
  ])('the number and the text arrive unchanged: %s', async (_name, to, text) => {
    quiet('debug')
    const spy = stubFetch(async () => accepted())
    await createTwilioSmsSender(WITH_AUTH_TOKEN).send({ to, text })
    const { body } = requestOf(spy)
    const form = new URLSearchParams(body)
    expect(form.get('To')).toBe(to)
    expect(form.get('Body')).toBe(text)
    // On the wire: a literal `+` would be read as a space, and nothing is left raw that a
    // form parser gives a meaning to.
    expect(body).toContain(`To=${encodeURIComponent(to)}`)
    expect(body).not.toMatch(/[\n\r #?;]/)
    expect(body.split('&')).toHaveLength(3)
    // Bytes, not characters: the text is UTF-8 whatever it holds.
    expect(body).toMatch(/^[\x21-\x7e]+$/)
  })

  test('the deadline is the providers’ ten seconds unless said', () => {
    expect(PROVIDER_TIMEOUT_MS).toBe(10_000)
  })
})

describe('what counts as sent', () => {
  test.each([200, 201, 202])('a %d whose body carries a message sid', async (status) => {
    const debug = quiet('debug')
    const warn = quiet('warn')
    stubFetch(async () => Response.json({ sid: MESSAGE_SID, status: 'accepted' }, { status }))
    expect(await createTwilioSmsSender(WITH_API_KEY).send(MESSAGE)).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
    // Twilio's identifier of the message, and nothing that names the recipient.
    expect(debug.mock.calls).toEqual([
      ['twilio accepted a text message', { messageSid: MESSAGE_SID }],
    ])
  })

  test('an MMS identifier is a message too', async () => {
    quiet('debug')
    stubFetch(async () => Response.json({ sid: `MM${'0'.repeat(32)}` }, { status: 201 }))
    expect(await createTwilioSmsSender(WITH_API_KEY).send(MESSAGE)).toBeUndefined()
  })
})

describe('what is a failed send', () => {
  const oversized = `{"sid":"${MESSAGE_SID}","padding":"${'x'.repeat(TWILIO_MAX_RESPONSE_BYTES)}"}`

  test.each<[string, () => Promise<Response>, Record<string, unknown>]>([
    [
      'a 400 with Twilio’s error',
      async () =>
        Response.json(
          { code: 21211, message: 'Invalid To', more_info: 'x', status: 400 },
          { status: 400 }
        ),
      { reason: 'refused', status: 400, twilioCode: 21211, twilioMessage: 'Invalid To' },
    ],
    [
      'a 401',
      async () =>
        Response.json({ code: 20003, message: 'Authenticate', status: 401 }, { status: 401 }),
      { reason: 'refused', status: 401, twilioCode: 20003, twilioMessage: 'Authenticate' },
    ],
    [
      'a 429',
      async () => new Response('slow down', { status: 429 }),
      { reason: 'refused', status: 429 },
    ],
    [
      'a 500 with no body',
      async () => new Response(null, { status: 500 }),
      { reason: 'refused', status: 500 },
    ],
    [
      'a non-2xx whose body carries a sid: the status decides, whatever the body says',
      async () => Response.json({ sid: MESSAGE_SID }, { status: 400 }),
      { reason: 'refused', status: 400 },
    ],
    [
      // What `fetch` would hand back for a redirect it was told not to follow by hand.
      'a redirect that was handed back instead of refused',
      async () => new Response(null, { status: 302, headers: { location: 'https://x.test/' } }),
      { reason: 'refused', status: 302 },
    ],
    [
      'a 2xx that is not JSON',
      async () => new Response('<html>ok</html>', { status: 200 }),
      { reason: 'not_json', status: 200 },
    ],
    [
      'a 2xx with an empty body',
      async () => new Response(null, { status: 204 }),
      { reason: 'not_json', status: 204 },
    ],
    [
      'a 2xx without a sid',
      async () => Response.json({ status: 'queued' }, { status: 201 }),
      { reason: 'no_sid', status: 201 },
    ],
    [
      'a 2xx whose sid is not a message’s',
      async () => Response.json({ sid: ACCOUNT_SID }, { status: 201 }),
      { reason: 'no_sid', status: 201 },
    ],
    [
      'a 2xx whose sid is not text',
      async () => Response.json({ sid: 12345 }, { status: 201 }),
      { reason: 'no_sid', status: 201 },
    ],
    [
      'a 2xx whose JSON is a list',
      async () => Response.json([{ sid: MESSAGE_SID }], { status: 201 }),
      { reason: 'no_sid', status: 201 },
    ],
    [
      'a 2xx whose JSON is null',
      async () => new Response('null', { status: 201 }),
      { reason: 'no_sid', status: 201 },
    ],
    [
      'a 2xx over the size cap, even with a sid in it',
      async () => new Response(oversized, { status: 201 }),
      { reason: 'too_large', status: 201 },
    ],
    [
      'a refused redirect, a network or a TLS failure',
      async () => {
        throw new TypeError('fetch failed: unexpected redirect')
      },
      { reason: 'no_answer' },
    ],
    [
      'a body that breaks off',
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"sid":"SM'))
              controller.error(new Error('connection reset'))
            },
          }),
          { status: 201 }
        ),
      { reason: 'no_answer', status: 201 },
    ],
  ])('%s', async (_name, answer, logged) => {
    const warn = quiet('warn')
    const debug = quiet('debug')
    const spy = stubFetch(answer)
    const failure = await createTwilioSmsSender(WITH_API_KEY)
      .send(MESSAGE)
      .catch((error) => error)
    expect(failure).toBeInstanceOf(SmsSendError)
    expect(failure.reason).toBe('failed')
    expect(failure.message).toBe('sms not sent: failed')
    // One request, never a second: a retry could send twice, and the limits count one.
    expect(spy).toHaveBeenCalledTimes(1)
    expect(debug).not.toHaveBeenCalled()
    expect(warn.mock.calls).toEqual([['twilio did not take a text message', logged]])
  })

  test('an oversized answer is not read to its end', async () => {
    quiet('warn')
    let pulled = 0
    const chunk = new Uint8Array(16 * 1024).fill(0x20)
    stubFetch(
      async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              pulled += 1
              if (pulled > 1000) {
                controller.close()
                return
              }
              controller.enqueue(chunk)
            },
          }),
          { status: 201 }
        )
    )
    await expect(createTwilioSmsSender(WITH_API_KEY).send(MESSAGE)).rejects.toBeInstanceOf(
      SmsSendError
    )
    // The cap is four chunks; a few more may have been asked for before the cancel landed.
    expect(pulled).toBeLessThan(20)
  })

  test('an answer of exactly the cap is read', async () => {
    quiet('debug')
    const head = `{"sid":"${MESSAGE_SID}","padding":"`
    const body = `${head}${'x'.repeat(TWILIO_MAX_RESPONSE_BYTES - head.length - 2)}"}`
    expect(new TextEncoder().encode(body).byteLength).toBe(TWILIO_MAX_RESPONSE_BYTES)
    stubFetch(async () => new Response(body, { status: 201 }))
    expect(await createTwilioSmsSender(WITH_API_KEY).send(MESSAGE)).toBeUndefined()
  })
})

describe('the deadline', () => {
  /** A `fetch` that answers only by being aborted, as a real one does. */
  function untilAborted(): FetchStub {
    return (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })
  }

  test('no answer in time is a failed send, said as a timeout, with no second try', async () => {
    const warn = quiet('warn')
    const spy = stubFetch(untilAborted())
    const started = performance.now()
    await expect(
      createTwilioSmsSender({ ...WITH_API_KEY, timeoutMs: 25 }).send(MESSAGE)
    ).rejects.toBeInstanceOf(SmsSendError)
    // The option's deadline, not the default's ten seconds.
    expect(performance.now() - started).toBeLessThan(2_000)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls).toEqual([['twilio did not take a text message', { reason: 'timeout' }]])
  })

  test('a fetch that ignores its signal is given up on all the same', async () => {
    const warn = quiet('warn')
    stubFetch(() => new Promise(() => {}))
    const started = performance.now()
    await expect(
      createTwilioSmsSender({ ...WITH_API_KEY, timeoutMs: 25 }).send(MESSAGE)
    ).rejects.toBeInstanceOf(SmsSendError)
    expect(performance.now() - started).toBeLessThan(2_000)
    expect(warn.mock.calls).toEqual([['twilio did not take a text message', { reason: 'timeout' }]])
  })

  test('a body that stops arriving is a timeout too', async () => {
    const warn = quiet('warn')
    stubFetch(
      async (_input, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"sid":'))
              init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason))
            },
          }),
          { status: 201 }
        )
    )
    await expect(
      createTwilioSmsSender({ ...WITH_API_KEY, timeoutMs: 25 }).send(MESSAGE)
    ).rejects.toBeInstanceOf(SmsSendError)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ reason: 'timeout' })
  })

  test('an answer in time leaves no timer behind to fail a later send', async () => {
    quiet('debug')
    const warn = quiet('warn')
    stubFetch(async () => accepted())
    const sender = createTwilioSmsSender({ ...WITH_API_KEY, timeoutMs: 25 })
    await sender.send(MESSAGE)
    await new Promise((resolve) => setTimeout(resolve, 60))
    await sender.send(MESSAGE)
    expect(warn).not.toHaveBeenCalled()
  })
})

// The answer is Twilio's to write, and it can quote anything the request held.
describe('nothing of the request or the answer gets out (canary)', () => {
  const CANARY = 'canary-7f3c1b9e-in-the-answer'
  /** The user name and the password the request authenticated with. */
  const basicOf = (options: TwilioSmsOptions): [string, string] =>
    options.credentials.kind === 'api_key'
      ? [options.credentials.sid, options.credentials.secret]
      : [options.accountSid, options.credentials.token]

  const everySecret = (options: TwilioSmsOptions) => [
    CANARY,
    TO,
    TO.slice(1),
    '4155550142',
    '415-555-0142',
    '(415) 555 0142',
    ...basicOf(options),
    btoa(basicOf(options).join(':')),
    API_KEY_SID,
    ACCOUNT_SID,
    SERVICE_SID,
    FROM_NUMBER,
    '739204',
    MESSAGE.text,
  ]

  /** An error answer that repeats everything the request held, everywhere it can. */
  function hostile(options: TwilioSmsOptions, status: number): Response {
    const [user, password] = basicOf(options)
    const basic = `${user}:${password}`
    const quoted = [
      `The number ${TO} is unverified (also 1 415-555-0142, (415) 555 0142, 14155550142).`,
      `Account ${ACCOUNT_SID} key ${API_KEY_SID} service ${SERVICE_SID} from ${FROM_NUMBER}.`,
      `Authorization: Basic ${btoa(basic)} user ${user} password ${password}.`,
      `Body was: ${MESSAGE.text}\u0000\n\u2028 trailing`,
    ].join(' ')
    return new Response(
      JSON.stringify({
        code: 21608,
        message: quoted,
        more_info: `https://www.twilio.com/docs/errors/21608?${CANARY}&to=${TO}`,
        status,
        [CANARY]: password,
        detail: { to: TO, body: MESSAGE.text, secret: password, canary: CANARY },
      }),
      {
        status,
        headers: {
          'content-type': 'application/json',
          'x-canary': CANARY,
          'x-echo-to': TO,
          'x-echo-authorization': `Basic ${btoa(basic)}`,
          'twilio-request-id': `RQ${CANARY}`,
        },
      }
    )
  }

  test.each([
    ['an API key and a Messaging Service', WITH_API_KEY],
    ['an auth token and a number', WITH_AUTH_TOKEN],
  ])('a refusal that quotes everything, with %s', async (_name, options) => {
    const warn = quiet('warn')
    const debug = quiet('debug')
    stubFetch(async () => hostile(options, 400))
    const failure = await createTwilioSmsSender(options)
      .send(MESSAGE)
      .catch((error) => error)

    // The error: the port's fixed word and not one character more.
    expect(failure).toBeInstanceOf(SmsSendError)
    expect(failure.message).toBe('sms not sent: failed')
    expect(Object.keys(failure).sort()).toEqual(['name', 'reason'])
    expect(failure.cause).toBeUndefined()
    const thrown = [String(failure), failure.stack, JSON.stringify({ ...failure })].join('\n')
    for (const secret of everySecret(options)) {
      expect(thrown).not.toContain(secret)
    }

    // The log line: a fixed word, the status, Twilio's number and its text, masked.
    expect(debug).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
    const [text, context] = warn.mock.calls[0] ?? []
    expect(text).toBe('twilio did not take a text message')
    expect(Object.keys(context ?? {}).sort()).toEqual([
      'reason',
      'status',
      'twilioCode',
      'twilioMessage',
    ])
    expect(context).toMatchObject({ reason: 'refused', status: 400, twilioCode: 21608 })
    const line = JSON.stringify(warn.mock.calls)
    for (const secret of everySecret(options)) {
      expect(line).not.toContain(secret)
    }
    // The text that was sent is taken out whole, not only its code.
    expect(line).not.toContain('Northline')
    const logged = String(context?.twilioMessage)
    expect(logged).toContain('is unverified')
    expect(logged).toContain('[digits]')
    // No run of four digits survives, however it was written out.
    expect(logged).not.toMatch(/[0-9](?:[ ().-]{0,2}[0-9]){3}/)
    // One line, and no longer than the cap.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what must be absent
    expect(logged).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/)
    expect(logged.length).toBeLessThanOrEqual(TWILIO_MAX_LOGGED_MESSAGE)
  })

  test('a 2xx that is not an acceptance says nothing of its body or its headers', async () => {
    const warn = quiet('warn')
    stubFetch(
      async () =>
        new Response(
          JSON.stringify({ message: `${CANARY} ${TO} ${API_KEY_SECRET}`, sid: CANARY }),
          {
            status: 200,
            headers: { 'x-canary': CANARY },
          }
        )
    )
    const failure = await createTwilioSmsSender(WITH_API_KEY)
      .send(MESSAGE)
      .catch((error) => error)
    expect(failure.message).toBe('sms not sent: failed')
    expect(warn.mock.calls).toEqual([
      ['twilio did not take a text message', { reason: 'no_sid', status: 200 }],
    ])
  })

  test('a thrown fetch error is not read: it can quote the request', async () => {
    const warn = quiet('warn')
    stubFetch(async () => {
      throw new Error(`could not POST To=${TO} with ${API_KEY_SECRET} ${CANARY}`)
    })
    const failure = await createTwilioSmsSender(WITH_API_KEY)
      .send(MESSAGE)
      .catch((error) => error)
    expect(failure.message).toBe('sms not sent: failed')
    expect(failure.cause).toBeUndefined()
    expect(warn.mock.calls).toEqual([
      ['twilio did not take a text message', { reason: 'no_answer' }],
    ])
  })

  test('the sender holds no credential a reader could find', () => {
    const sender = createTwilioSmsSender(WITH_API_KEY)
    expect(Object.keys(sender).sort()).toEqual(['configured', 'send'])
    const visible = [JSON.stringify(sender), Bun.inspect(sender), String(sender.send)].join('\n')
    for (const secret of [API_KEY_SECRET, API_KEY_SID, ACCOUNT_SID, SERVICE_SID]) {
      expect(visible).not.toContain(secret)
    }
  })

  test('an accepted message logs Twilio’s identifier and nothing of the answer beside it', async () => {
    const debug = quiet('debug')
    stubFetch(
      async () =>
        new Response(
          JSON.stringify({ sid: MESSAGE_SID, to: TO, body: MESSAGE.text, canary: CANARY }),
          { status: 201, headers: { 'x-canary': CANARY } }
        )
    )
    await createTwilioSmsSender(WITH_API_KEY).send(MESSAGE)
    const line = JSON.stringify(debug.mock.calls)
    for (const secret of [CANARY, TO, '4155550142', '739204', API_KEY_SECRET, ACCOUNT_SID]) {
      expect(line).not.toContain(secret)
    }
  })
})

describe('maskProviderMessage', () => {
  test.each([
    ['a number in E.164', 'To +14155550142 is not valid', 'To [digits] is not valid'],
    ['a number without its plus', 'number 14155550142.', 'number [digits].'],
    ['a number written out', 'call (415) 555-0142 now', 'call ([digits] now'],
    ['a number with dots', '415.555.0142', '[digits]'],
    ['four digits', 'pin 1234', 'pin [digits]'],
    ['three digits are not a number', 'HTTP 400 and 21 more', 'HTTP 400 and 21 more'],
    [
      'an identifier of Twilio’s',
      `Account ${ACCOUNT_SID} is suspended`,
      'Account [sid] is suspended',
    ],
    ['a line break', 'one\ntwo\r\n\tthree', 'one two three'],
    ['nothing to mask', 'Authenticate', 'Authenticate'],
  ])('%s', (_name, text, masked) => {
    expect(maskProviderMessage(text, [])).toBe(masked)
  })

  test('a known value is taken out whatever it looks like', () => {
    expect(maskProviderMessage('secret abcDEF-xyz! here', ['abcDEF-xyz!'])).toBe(
      'secret [redacted] here'
    )
  })

  test('a known value too short to be told from ordinary text is left to the other rules', () => {
    expect(maskProviderMessage('a b c', ['b', ''])).toBe('a b c')
  })

  test('is cut to the cap, and a known value across the cut leaves nothing behind', () => {
    const secret = `S${'e'.repeat(254)}T`
    const text = `${'a'.repeat(TWILIO_MAX_LOGGED_MESSAGE - 10)}${secret} tail`
    const masked = maskProviderMessage(text, [secret])
    expect(masked.length).toBeLessThanOrEqual(TWILIO_MAX_LOGGED_MESSAGE)
    expect(masked).not.toContain('Seee')
    expect(masked.endsWith('[redacted]')).toBe(true)
  })

  test('work is bounded: a megabyte of digits and separators is answered at once', () => {
    const started = performance.now()
    const masked = maskProviderMessage('1 '.repeat(500_000), ['1 2 3 4'])
    expect(performance.now() - started).toBeLessThan(250)
    expect(masked.length).toBeLessThanOrEqual(TWILIO_MAX_LOGGED_MESSAGE)
  })
})
