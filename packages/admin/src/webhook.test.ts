import { describe, expect, test } from 'bun:test'
import { EVENT_FIXTURES } from '@tula/contract'
import {
  formatWebhookSecret,
  signWebhook,
  webhookSecretBytes,
} from '@tula/contract/webhook-signature'
import { isTulaAdminError, type TulaAdminError } from './errors'
import { verifyWebhook, WEBHOOK_MAX_SIGNATURES } from './webhook'

const SECRET = formatWebhookSecret(new Uint8Array(32).fill(41))
const OTHER_SECRET = formatWebhookSecret(new Uint8Array(32).fill(42))
const NOW = Date.parse('2026-10-08T09:30:00.000Z')
const SECONDS = Math.floor(NOW / 1000)
const event = EVENT_FIXTURES['user.created']
const BODY = JSON.stringify(event)

async function sign(
  secret = SECRET,
  {
    id = event.id,
    timestamp = SECONDS,
    body = BODY,
  }: { id?: string; timestamp?: number; body?: string } = {}
): Promise<string> {
  return signWebhook(webhookSecretBytes(secret) as Uint8Array<ArrayBuffer>, id, timestamp, body)
}

async function delivery(overrides: Record<string, string | undefined> = {}) {
  return {
    'webhook-id': event.id,
    'webhook-timestamp': String(SECONDS),
    'webhook-signature': await sign(),
    ...overrides,
  }
}

async function failure(work: Promise<unknown>): Promise<TulaAdminError> {
  try {
    await work
  } catch (error) {
    if (isTulaAdminError(error)) {
      return error
    }
    throw error
  }
  throw new Error('expected the verification to fail')
}

const verify = (
  headers: Parameters<typeof verifyWebhook>[1],
  { body = BODY as string | Uint8Array, secret = SECRET, now = NOW } = {}
) => verifyWebhook(body, headers, secret, { now })

describe('verifyWebhook', () => {
  test('returns the event of a delivery signed with the secret', async () => {
    expect(await verify(await delivery())).toEqual(event)
  })

  test('accepts the reference implementation’s own example signature', async () => {
    // github.com/standard-webhooks/standard-webhooks: the libraries' shared test vector. Its
    // body is not a Tula event, so the signature is what is under test: it gets as far as
    // the payload.
    const error = await failure(
      verifyWebhook(
        '{"test": 2432232314}',
        {
          'webhook-id': 'msg_p5jXN8AQM9LWM0D4loKWxJek',
          'webhook-timestamp': '1614265330',
          'webhook-signature': 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
        },
        'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
        { now: 1614265330_000 }
      )
    )
    expect(error.code).toBe('webhook.invalid_payload')
  })

  test.each([
    ['a Headers object', async () => new Headers(await delivery())],
    [
      'names in another case',
      async () => ({
        'Webhook-Id': event.id,
        'WEBHOOK-TIMESTAMP': String(SECONDS),
        'Webhook-Signature': await sign(),
      }),
    ],
    [
      'single-entry lists, as Node gives repeated headers',
      async () => ({
        'webhook-id': [event.id],
        'webhook-timestamp': [String(SECONDS)],
        'webhook-signature': [await sign()],
      }),
    ],
    [
      'other headers beside them',
      async () => ({ ...(await delivery()), host: 'app.example', 'x-other': undefined }),
    ],
  ])('reads the headers from %s', async (_, headers) => {
    expect(await verify(await headers())).toEqual(event)
  })

  test('takes the body as the bytes that arrived', async () => {
    expect(await verify(await delivery(), { body: new TextEncoder().encode(BODY) })).toEqual(event)
  })

  test('accepts any one of several signatures: a rotated secret verifies with either', async () => {
    const old = await sign(OTHER_SECRET)
    const current = await sign()
    for (const header of [
      `${old} ${current}`,
      `${current} ${old}`,
      `v1a,AAAA ${old} v2,BBBB ${current}`,
    ]) {
      expect(await verify(await delivery({ 'webhook-signature': header }))).toEqual(event)
    }
  })

  test.each([
    ['another secret', async () => delivery({ 'webhook-signature': await sign(OTHER_SECRET) })],
    [
      'another id',
      async () => delivery({ 'webhook-signature': await sign(SECRET, { id: 'other' }) }),
    ],
    [
      'another timestamp',
      async () => delivery({ 'webhook-signature': await sign(SECRET, { timestamp: SECONDS - 1 }) }),
    ],
    [
      'another body',
      async () => delivery({ 'webhook-signature': await sign(SECRET, { body: `${BODY} ` }) }),
    ],
    [
      'one character changed',
      async () => {
        const signature = await sign()
        const flipped = signature.at(-2) === 'A' ? 'B' : 'A'
        return delivery({ 'webhook-signature': `${signature.slice(0, -2)}${flipped}=` })
      },
    ],
    [
      'a prefix of the right signature',
      async () => delivery({ 'webhook-signature': (await sign()).slice(0, 20) }),
    ],
    [
      'the right signature under another version label',
      async () => delivery({ 'webhook-signature': (await sign()).replace('v1,', 'v1a,') }),
    ],
    [
      'no v1 signature among them',
      async () => delivery({ 'webhook-signature': 'v2,AAAA v1a,BBBB' }),
    ],
    [
      'only wrong ones',
      async () =>
        delivery({
          'webhook-signature': `${await sign(OTHER_SECRET)} ${await sign(SECRET, { id: 'x' })}`,
        }),
    ],
  ])('refuses a signature made with %s', async (_, headers) => {
    const error = await failure(verify(await headers()))
    expect(error.code).toBe('webhook.invalid_signature')
    expect(error.status).toBe(0)
  })

  test('refuses a body that was changed after it was signed', async () => {
    const tampered = BODY.replace('"sign_up"', '"admin"')
    expect(tampered).not.toBe(BODY)
    expect((await failure(verify(await delivery(), { body: tampered }))).code).toBe(
      'webhook.invalid_signature'
    )
    // A body that was parsed and written out again is not the body that was signed.
    const reformatted = JSON.stringify(JSON.parse(BODY), null, 2)
    expect((await failure(verify(await delivery(), { body: reformatted }))).code).toBe(
      'webhook.invalid_signature'
    )
  })

  test('refuses bytes that are not text', async () => {
    const error = await failure(
      verify(await delivery(), { body: new Uint8Array([0xff, 0xfe, 0x00]) })
    )
    expect(error.code).toBe('webhook.invalid_signature')
  })

  test.each([
    ['no id', { 'webhook-id': undefined }],
    ['an empty id', { 'webhook-id': '' }],
    ['an id with a full stop', { 'webhook-id': 'a.b' }],
    ['an id that is too long', { 'webhook-id': 'x'.repeat(257) }],
    ['no timestamp', { 'webhook-timestamp': undefined }],
    ['a timestamp that is not a number', { 'webhook-timestamp': 'yesterday' }],
    ['a timestamp with a fraction', { 'webhook-timestamp': `${SECONDS}.5` }],
    ['a negative timestamp', { 'webhook-timestamp': `-${SECONDS}` }],
    ['a timestamp in hex', { 'webhook-timestamp': `0x${SECONDS.toString(16)}` }],
    ['a timestamp with a space', { 'webhook-timestamp': ` ${SECONDS}` }],
    ['a timestamp too long to be one', { 'webhook-timestamp': '1'.repeat(16) }],
    ['no signature', { 'webhook-signature': undefined }],
    ['an empty signature', { 'webhook-signature': '' }],
    [
      'a signature with no version',
      { 'webhook-signature': 'g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=' },
    ],
    ['a signature header that is too long', { 'webhook-signature': `v1,${'A'.repeat(5000)}` }],
    [
      'more signatures than are ever sent',
      {
        'webhook-signature': Array.from(
          { length: WEBHOOK_MAX_SIGNATURES + 1 },
          () => 'v1,AAAA'
        ).join(' '),
      },
    ],
  ])('refuses %s as a malformed delivery', async (_, change) => {
    const error = await failure(verify(await delivery(change)))
    expect(error.code).toBe('webhook.invalid_headers')
  })

  test.each(['webhook-id', 'webhook-timestamp'] as const)(
    'refuses a %s that was sent twice, however the headers are given',
    async (name) => {
      const once = await delivery()
      const value = once[name]
      // A `Headers` object joins a repeated header with a comma; Node gives a list.
      const joined = new Headers(once)
      joined.append(name, value)
      expect((await failure(verify(joined))).code).toBe('webhook.invalid_headers')
      expect((await failure(verify({ ...once, [name]: [value, value] }))).code).toBe(
        'webhook.invalid_headers'
      )
    }
  )

  test('refuses an id with a comma in it', async () => {
    const id = 'a,b'
    const headers = await delivery({
      'webhook-id': id,
      'webhook-signature': await sign(SECRET, { id }),
    })
    expect((await failure(verify(headers))).code).toBe('webhook.invalid_headers')
  })

  test('a signature header sent twice is one list: any right entry is enough, as the reference library reads it', async () => {
    const right = await sign()
    const wrong = await sign(OTHER_SECRET)
    for (const [first, second] of [
      [right, wrong],
      [wrong, right],
    ] as const) {
      const joined = new Headers(await delivery({ 'webhook-signature': first }))
      joined.append('webhook-signature', second)
      expect(joined.get('webhook-signature')).toBe(`${first}, ${second}`)
      expect(await verify(joined)).toEqual(event)
      expect(await verify({ ...(await delivery()), 'webhook-signature': [first, second] })).toEqual(
        event
      )
    }
    const none = new Headers(await delivery({ 'webhook-signature': wrong }))
    none.append('webhook-signature', await sign(SECRET, { id: 'other' }))
    expect((await failure(verify(none))).code).toBe('webhook.invalid_signature')
  })

  test('refuses a header that was sent twice', async () => {
    const headers = { ...(await delivery()), 'webhook-id': [event.id, event.id] }
    expect((await failure(verify(headers))).code).toBe('webhook.invalid_headers')
    const twoNames = { ...(await delivery()), 'Webhook-Id': event.id }
    expect((await failure(verify(twoNames))).code).toBe('webhook.invalid_headers')
  })

  test.each([
    ['five minutes old', -300, true],
    ['a second more than five minutes old', -301, false],
    ['an hour old', -3600, false],
    ['five minutes ahead', 300, true],
    ['a second more than five minutes ahead', 301, false],
    ['a day ahead', 86_400, false],
  ])('a correctly signed delivery that is %s: accepted = %p', async (_, offset, accepted) => {
    const timestamp = SECONDS + offset
    const headers = await delivery({
      'webhook-timestamp': String(timestamp),
      'webhook-signature': await sign(SECRET, { timestamp }),
    })
    if (accepted) {
      expect(await verify(headers)).toEqual(event)
    } else {
      expect((await failure(verify(headers))).code).toBe('webhook.timestamp_out_of_tolerance')
    }
  })

  test('judges the timestamp by the clock it is given, and by the real one otherwise', async () => {
    const headers = await delivery()
    expect((await failure(verifyWebhook(BODY, headers, SECRET, { now: NOW + 301_000 }))).code).toBe(
      'webhook.timestamp_out_of_tolerance'
    )
    const seconds = Math.floor(Date.now() / 1000)
    const fresh = await delivery({
      'webhook-timestamp': String(seconds),
      'webhook-signature': await sign(SECRET, { timestamp: seconds }),
    })
    expect(await verifyWebhook(BODY, fresh, SECRET)).toEqual(event)
  })

  test.each([
    ['a publishable key', 'tula_pk_dev_0000000000000000000000000000000000'],
    ['a secret key', 'tula_sk_dev_0000000000000000000000000000000000'],
    ['the secret without its prefix', SECRET.slice('whsec_'.length)],
    ['an empty string', ''],
    ['a secret that is too short', 'whsec_c2hvcnQ='],
  ])('refuses %s as the secret, and does not repeat it', async (_, secret) => {
    const error = await failure(verify(await delivery(), { secret }))
    expect(error.code).toBe('webhook.invalid_secret')
    if (secret !== '') {
      expect(`${error.message} ${JSON.stringify(error)} ${error.stack}`).not.toContain(secret)
    }
  })

  test.each([
    ['text that is not JSON', 'not json'],
    ['a list', '[]'],
    ['null', 'null'],
    ['an object that is no event', '{"hello":"world"}'],
    ['an event without a type', JSON.stringify({ ...event, type: undefined })],
    ['an event without a schema version', JSON.stringify({ ...event, schemaVersion: undefined })],
    ['an event without data', JSON.stringify({ ...event, data: undefined })],
    ['an event whose data is a list', JSON.stringify({ ...event, data: [] })],
    [
      'an event with another id than the delivery’s',
      JSON.stringify({ ...event, id: EVENT_FIXTURES['user.deleted'].id }),
    ],
    // `test` is `true` on a test event and absent on a real one: nothing else is either.
    ['an event whose test mark is false', JSON.stringify({ ...event, test: false })],
    ['an event whose test mark is a word', JSON.stringify({ ...event, test: 'true' })],
    ['an event whose test mark is null', JSON.stringify({ ...event, test: null })],
  ])('refuses a correctly signed body that is %s', async (_, body) => {
    const headers = await delivery({ 'webhook-signature': await sign(SECRET, { body }) })
    expect((await failure(verify(headers, { body }))).code).toBe('webhook.invalid_payload')
  })

  test('returns a test event with its mark, so a receiver can tell it from a real one', async () => {
    const body = JSON.stringify({ ...event, test: true })
    const headers = await delivery({ 'webhook-signature': await sign(SECRET, { body }) })
    const verified = await verify(headers, { body })
    expect(verified.test).toBe(true)
    expect((await verify(await delivery())).test).toBeUndefined()
    // The mark is inside what is signed: adding it to a real delivery breaks the signature.
    expect((await failure(verify(await delivery(), { body }))).code).toBe(
      'webhook.invalid_signature'
    )
  })

  test('returns an event of a type this version does not know: a later server may send one', async () => {
    const later = { ...event, type: 'phone.verified', data: { method: 'sms' } }
    const body = JSON.stringify(later)
    const headers = await delivery({ 'webhook-signature': await sign(SECRET, { body }) })
    expect(await verify(headers, { body })).toEqual(later as never)
  })

  test('an error never carries the secret, a signature or the body', async () => {
    const signature = await sign(OTHER_SECRET)
    const errors = [
      await failure(verify(await delivery({ 'webhook-signature': signature }))),
      await failure(verify(await delivery({ 'webhook-timestamp': '1' }))),
      await failure(verify(await delivery({ 'webhook-id': '' }))),
      await failure(verify(await delivery(), { body: '{"canary":"body"}' })),
    ]
    for (const error of errors) {
      const text = `${error.message} ${JSON.stringify(error)} ${error.stack} ${JSON.stringify(error.params)}`
      expect(text).not.toContain(SECRET)
      expect(text).not.toContain(SECRET.slice('whsec_'.length))
      expect(text).not.toContain(signature)
      expect(text).not.toContain(signature.slice(3))
      expect(text).not.toContain((await sign()).slice(3))
      expect(text).not.toContain('canary')
      expect(error.name).toBe('TulaAdminError')
    }
  })

  test('every example event verifies and comes back as it was sent', async () => {
    for (const fixture of Object.values(EVENT_FIXTURES)) {
      const body = JSON.stringify(fixture)
      const headers = {
        'webhook-id': fixture.id,
        'webhook-timestamp': String(SECONDS),
        'webhook-signature': await sign(SECRET, { id: fixture.id, body }),
      }
      expect(await verify(headers, { body })).toEqual(fixture as never)
    }
  })
})
