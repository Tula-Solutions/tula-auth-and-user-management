import { describe, expect, test } from 'bun:test'
import {
  signWebhook,
  WEBHOOK_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  webhookSecretBytes,
} from '@tula/contract'
import { createSecretBox } from '~/lib/secret-box'
import {
  newSigningSecret,
  openSigningSecret,
  SIGNING_SECRET_BYTES,
  type SigningKeys,
  signedHeaders,
} from '~/lib/signing-secret'

const box = createSecretBox('ab'.repeat(32))
const at = new Date('2026-10-08T09:30:00.500Z')

async function sealed(purpose: string, secret: string, binding: string): Promise<string> {
  return box.seal(purpose, new TextEncoder().encode(secret), binding)
}

describe('a signing secret', () => {
  test('is 256 random bits in the Standard Webhooks format, new each time', () => {
    const one = newSigningSecret()
    expect(one).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/)
    expect(webhookSecretBytes(one)?.length).toBe(SIGNING_SECRET_BYTES)
    expect(newSigningSecret()).not.toBe(one)
  })

  test('opens only under the purpose and the binding it was sealed with', async () => {
    const secret = newSigningSecret()
    const stored = await sealed('hook-secrets', secret, 'env:hook')
    const opened = await openSigningSecret(box, 'hook-secrets', stored, 'env:hook')
    expect(opened?.key).toEqual(webhookSecretBytes(secret) as Uint8Array<ArrayBuffer>)
    expect(new TextDecoder().decode(opened?.sealable)).toBe(secret)
    // Another row, another environment, and the same ids under the webhooks' purpose.
    expect(await openSigningSecret(box, 'hook-secrets', stored, 'env:other')).toBeNull()
    expect(await openSigningSecret(box, 'hook-secrets', stored, 'other:hook')).toBeNull()
    expect(await openSigningSecret(box, 'webhook-secrets', stored, 'env:hook')).toBeNull()
  })

  test('what opens and is no signing secret is not one, and nothing is thrown', async () => {
    const stored = await sealed('hook-secrets', 'not a secret', 'env:hook')
    expect(await openSigningSecret(box, 'hook-secrets', stored, 'env:hook')).toBeNull()
    expect(await openSigningSecret(box, 'hook-secrets', 'garbage', 'env:hook')).toBeNull()
  })
})

describe('signedHeaders', () => {
  const current = webhookSecretBytes(newSigningSecret()) as Uint8Array<ArrayBuffer>
  const previous = webhookSecretBytes(newSigningSecret()) as Uint8Array<ArrayBuffer>
  const body = '{"a":1}'

  test('are the three Standard Webhooks headers, signed over the id, the second and the body', async () => {
    const keys: SigningKeys = { current, previous: null, previousUnreadable: false }
    const headers = await signedHeaders(keys, 'id_1', at, body)
    expect(headers).toEqual({
      [WEBHOOK_ID_HEADER]: 'id_1',
      [WEBHOOK_TIMESTAMP_HEADER]: '1791451800',
      [WEBHOOK_SIGNATURE_HEADER]: await signWebhook(current, 'id_1', 1791451800, body),
    })
  })

  test('a previous secret signs second, and only strictly before its end', async () => {
    const during: SigningKeys = {
      current,
      previous: { key: previous, expiresAt: new Date(at.getTime() + 1) },
      previousUnreadable: false,
    }
    const ended: SigningKeys = { ...during, previous: { key: previous, expiresAt: at } }
    const both = (await signedHeaders(during, 'id_1', at, body))[WEBHOOK_SIGNATURE_HEADER]
    expect(both?.split(' ')).toEqual([
      await signWebhook(current, 'id_1', 1791451800, body),
      await signWebhook(previous, 'id_1', 1791451800, body),
    ])
    const one = (await signedHeaders(ended, 'id_1', at, body))[WEBHOOK_SIGNATURE_HEADER]
    expect(one?.split(' ')).toHaveLength(1)
  })
})
