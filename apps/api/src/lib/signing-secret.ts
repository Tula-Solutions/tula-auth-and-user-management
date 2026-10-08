import {
  formatWebhookSecret,
  signWebhook,
  WEBHOOK_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  webhookSecretBytes,
} from '@tula/contract'
import type { SecretBox } from '~/lib/secret-box'

// The signing secret of a request the server sends to an operator's endpoint, and the one
// place such a request is signed. A webhook delivery (ADR 0034) and a hook's question
// (ADR 0035) are signed the same way, with the same code: the Standard Webhooks scheme, the
// contract's `signWebhook`. What differs between them (the purpose a secret is sealed under,
// what it is bound to, whether there can be a previous secret) is each module's own.

/** Bytes of a new signing key: 256 bits, inside the 24 to 64 the scheme allows. */
export const SIGNING_SECRET_BYTES = 32

/**
 * A new signing secret: 256 bits from the CSPRNG, in the Standard Webhooks format.
 *
 * @returns `whsec_` and the base64 of the key.
 */
export function newSigningSecret(): string {
  return formatWebhookSecret(crypto.getRandomValues(new Uint8Array(SIGNING_SECRET_BYTES)))
}

/**
 * One sealed secret, opened: its signing key, and the bytes that were sealed (the `whsec_…`
 * text, for sealing again under another binding).
 *
 * @param secretBox - The secret box.
 * @param purpose - The key-separation label the secret was sealed under.
 * @param sealed - The stored ciphertext.
 * @param binding - What it was bound to when it was sealed.
 * @returns The key and the sealed bytes; `null` when it cannot be opened with that purpose
 *   and binding or is no signing secret. The failure itself is never passed on, logged or
 *   returned: it is about key material.
 */
export async function openSigningSecret(
  secretBox: SecretBox,
  purpose: string,
  sealed: string,
  binding: string
): Promise<{ key: Uint8Array<ArrayBuffer>; sealable: Uint8Array } | null> {
  try {
    const sealable = await secretBox.open(purpose, sealed, binding)
    const key = webhookSecretBytes(new TextDecoder().decode(sealable))
    return key && { key, sealable }
  } catch {
    return null
  }
}

/** What a request is signed with. */
export interface SigningKeys {
  /** The key of the current secret: it always signs, and its signature comes first. */
  current: Uint8Array<ArrayBuffer>
  /**
   * The key of the secret a rotation replaced, and when it stops signing; `null` when there
   * is none, when its end had come by the time the keys were opened, or when it would not
   * open. Whether it signs a given request is decided at that request ({@link signedHeaders}).
   */
  previous: { key: Uint8Array<ArrayBuffer>; expiresAt: Date } | null
  /**
   * There is a previous secret that should still be signing and it would not open: requests
   * are made with the current secret's signature alone, and the caller says so.
   */
  previousUnreadable: boolean
}

/**
 * The Standard Webhooks headers of one request: its id, when it is made, and the signatures.
 * **The one place a request to an operator's endpoint is signed**, for a webhook delivery (the
 * worker, a test event, a delivery sent again) and for a hook's question alike.
 *
 * The signature header is the current secret's signature and after it, separated by a space,
 * the previous secret's while its overlap lasts. Whether the previous secret signs is decided
 * here, for this request, from its stored end and the instant the request is made, never from
 * whether anything has cleared it away. Never more than two entries.
 *
 * @param keys - The keys to sign with.
 * @param id - The `webhook-id`.
 * @param at - When the request is made: also where its `webhook-timestamp` comes from.
 * @param body - The exact text sent.
 * @returns The three headers, by name.
 */
export async function signedHeaders(
  keys: SigningKeys,
  id: string,
  at: Date,
  body: string
): Promise<Record<string, string>> {
  const timestamp = Math.floor(at.getTime() / 1000)
  const entries = [await signWebhook(keys.current, id, timestamp, body)]
  if (keys.previous && at.getTime() < keys.previous.expiresAt.getTime()) {
    entries.push(await signWebhook(keys.previous.key, id, timestamp, body))
  }
  return {
    [WEBHOOK_ID_HEADER]: id,
    [WEBHOOK_TIMESTAMP_HEADER]: String(timestamp),
    [WEBHOOK_SIGNATURE_HEADER]: entries.join(' '),
  }
}
