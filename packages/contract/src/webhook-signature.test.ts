import { describe, expect, test } from 'bun:test'
import {
  formatWebhookSecret,
  signWebhook,
  WEBHOOK_ID_HEADER,
  WEBHOOK_SECRET_PREFIX,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  WEBHOOK_TOLERANCE_SECONDS,
  webhookSecretBytes,
} from './webhook-signature'

// The example of the Standard Webhooks reference libraries' own tests
// (github.com/standard-webhooks/standard-webhooks, libraries/*): a signature made here for
// their secret, id, timestamp and body has to be the one they expect.
const REFERENCE = {
  secret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
  id: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
  timestamp: 1614265330,
  body: '{"test": 2432232314}',
  signature: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
}

function keyOf(secret: string): Uint8Array<ArrayBuffer> {
  const key = webhookSecretBytes(secret)
  if (!key) {
    throw new Error('not a signing secret')
  }
  return key
}

describe('the Standard Webhooks names', () => {
  test('are the specification’s header names, secret prefix and five-minute tolerance', () => {
    expect([WEBHOOK_ID_HEADER, WEBHOOK_TIMESTAMP_HEADER, WEBHOOK_SIGNATURE_HEADER]).toEqual([
      'webhook-id',
      'webhook-timestamp',
      'webhook-signature',
    ])
    expect(WEBHOOK_SECRET_PREFIX).toBe('whsec_')
    expect(WEBHOOK_TOLERANCE_SECONDS).toBe(300)
  })
})

describe('signWebhook', () => {
  test('produces the reference implementation’s signature for its example', async () => {
    const signature = await signWebhook(
      keyOf(REFERENCE.secret),
      REFERENCE.id,
      REFERENCE.timestamp,
      REFERENCE.body
    )
    expect(signature).toBe(REFERENCE.signature)
  })

  test.each([
    ['the id', { id: 'msg_other' }],
    ['the timestamp', { timestamp: REFERENCE.timestamp + 1 }],
    ['one character of the body', { body: '{"test": 2432232315}' }],
    ['white space in the body', { body: '{"test":2432232314}' }],
  ])('changes when %s changes', async (_, change) => {
    const input = { ...REFERENCE, ...change }
    const signature = await signWebhook(
      keyOf(REFERENCE.secret),
      input.id,
      input.timestamp,
      input.body
    )
    expect(signature).not.toBe(REFERENCE.signature)
    expect(signature).toMatch(/^v1,[A-Za-z0-9+/]{43}=$/)
  })

  test('changes with the key', async () => {
    const other = formatWebhookSecret(new Uint8Array(32).fill(7))
    expect(
      await signWebhook(keyOf(other), REFERENCE.id, REFERENCE.timestamp, REFERENCE.body)
    ).not.toBe(REFERENCE.signature)
  })

  test('signs a body that is not ASCII as its UTF-8 bytes', async () => {
    const key = keyOf(REFERENCE.secret)
    const signature = await signWebhook(key, 'id', 1, '{"name":"Zoë"}')
    expect(signature).not.toBe(await signWebhook(key, 'id', 1, '{"name":"Zoe"}'))
  })
})

describe('a signing secret', () => {
  test('is written as whsec_ and the base64 of its bytes, and read back', () => {
    const key = crypto.getRandomValues(new Uint8Array(32))
    const secret = formatWebhookSecret(key)
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/)
    expect(webhookSecretBytes(secret)).toEqual(key)
  })

  test.each([23, 65])('is not made from a key of %d bytes', (length) => {
    expect(() => formatWebhookSecret(new Uint8Array(length))).toThrow(RangeError)
  })

  test.each([
    ['no prefix', 'MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'],
    ['another prefix', 'whsk_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'],
    ['nothing after the prefix', 'whsec_'],
    ['the URL-safe alphabet', `whsec_${'-_'.repeat(16)}`],
    ['a character outside base64', 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaS!'],
    ['a length base64 cannot have', 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSwA'],
    ['too few bytes', `whsec_${btoa('x'.repeat(23))}`],
    ['too many bytes', `whsec_${btoa('x'.repeat(65))}`],
    ['the empty string', ''],
  ])('is refused with %s', (_, secret) => {
    expect(webhookSecretBytes(secret)).toBeNull()
  })

  test.each([24, 64])('is accepted at %d bytes', (length) => {
    expect(webhookSecretBytes(`whsec_${btoa('x'.repeat(length))}`)?.length).toBe(length)
  })
})
