import { OAuthProviderError } from '~/ports/oauth-provider'
import { withDeadline } from './id-token'

/**
 * The longest profile answer that is read. A profile is a few hundred bytes; an answer beyond
 * this is not one, and is dropped unread instead of being buffered.
 */
export const MAX_PROFILE_BYTES = 64 * 1024

/**
 * Read a response body as text, up to a number of bytes.
 *
 * @returns The text, or `null` when the body is longer: the rest is cancelled, not read.
 */
async function boundedText(response: Response, maxBytes: number): Promise<string | null> {
  const reader = response.body?.getReader()
  if (!reader) {
    return ''
  }
  const decoder = new TextDecoder()
  let text = ''
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      return text + decoder.decode()
    }
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    text += decoder.decode(value, { stream: true })
  }
}

async function read(url: string, accessToken: string, signal: AbortSignal): Promise<unknown> {
  let response: Response
  try {
    response = await globalThis.fetch(url, {
      signal,
      // A redirect would carry the token to wherever it points.
      redirect: 'error',
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    })
  } catch {
    throw new OAuthProviderError('unavailable')
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new OAuthProviderError('unavailable')
  }
  let text: string | null
  try {
    text = await boundedText(response, MAX_PROFILE_BYTES)
  } catch {
    // A body cut off (by the timeout or the connection) is the provider not answering.
    throw new OAuthProviderError('unavailable')
  }
  if (text === null) {
    throw new OAuthProviderError('invalid_profile')
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new OAuthProviderError('invalid_profile')
  }
}

/**
 * Read a provider's profile endpoint with the access token of the exchange, within bounds.
 *
 * One `GET` to a fixed address of the provider, never one taken from an answer. The request
 * is aborted at the timeout (the signal also ends a body that stops arriving), and
 * {@link withDeadline} guards a `fetch` that ignores it. No redirect is followed, and at most
 * {@link MAX_PROFILE_BYTES} of the answer are read. Nothing of the answer or of the token is
 * put in an error or logged.
 *
 * @param url - The provider's profile endpoint, a constant of the adapter.
 * @param accessToken - The access token the code was just exchanged for.
 * @param timeoutMs - The deadline of the whole read.
 * @returns The answer's JSON, unjudged.
 * @throws OAuthProviderError `unavailable` when the provider does not answer, answers anything
 *   but a 2xx or stops mid-body; `invalid_profile` when the answer is over the cap or not JSON.
 */
export function readProfile(url: string, accessToken: string, timeoutMs: number): Promise<unknown> {
  return withDeadline(read(url, accessToken, AbortSignal.timeout(timeoutMs)), timeoutMs)
}
