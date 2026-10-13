import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { type OAuthFailure, OAuthProviderError } from '~/ports/oauth-provider'
import { MAX_PROFILE_BYTES, readProfile } from './profile-read'

// What the two adapters that read a profile with an access token (Discord, LinkedIn) share.
// Each adapter's own tests hold the redirect, the cap and the timeout through its exchange;
// these are the corners of the read that no provider's answer reaches by itself.

const URL = 'https://provider.test/profile'
const TOKEN = 'access-token-canary'

const spies: ReturnType<typeof spyOn>[] = []
afterEach(() => {
  for (const spy of spies.splice(0)) {
    spy.mockRestore()
  }
})

function answer(response: () => Response | Promise<Response>) {
  const inits: (RequestInit | undefined)[] = []
  spies.push(
    spyOn(globalThis, 'fetch').mockImplementation((async (
      _input: string | URL | Request,
      init?: RequestInit
    ) => {
      inits.push(init)
      return response()
    }) as typeof fetch)
  )
  return inits
}

async function failureOf(promise: Promise<unknown>): Promise<OAuthFailure | string> {
  try {
    await promise
    return 'resolved'
  } catch (error) {
    return error instanceof OAuthProviderError ? error.failure : `threw ${String(error)}`
  }
}

/** A body that arrives in pieces and whose cancellation fails, as a broken connection's does. */
function stubborn(chunks: number): { body: ReadableStream<Uint8Array>; cancelled: () => number } {
  let cancelled = 0
  let sent = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent === chunks) {
        controller.close()
        return
      }
      sent += 1
      controller.enqueue(new Uint8Array(16 * 1024).fill(0x20))
    },
    cancel() {
      cancelled += 1
      throw new Error('cancel failed: canary')
    },
  })
  return { body, cancelled: () => cancelled }
}

describe('readProfile', () => {
  test('one GET with the token in a header, no redirect followed, under an abort signal', async () => {
    const inits = answer(() => new Response('{"id":"1"}'))
    expect(await readProfile(URL, TOKEN, 1000)).toEqual({ id: '1' })
    expect(inits).toHaveLength(1)
    const init = inits[0] as RequestInit
    expect(init.method).toBeUndefined()
    expect(init.body).toBeUndefined()
    expect(init.redirect).toBe('error')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(Object.fromEntries(new Headers(init.headers))).toEqual({
      accept: 'application/json',
      authorization: `Bearer ${TOKEN}`,
    })
  })

  test('a 2xx with no body at all is not a profile', async () => {
    answer(() => new Response(null, { status: 204 }))
    expect(await failureOf(readProfile(URL, TOKEN, 1000))).toBe('invalid_profile')
  })

  test('an oversized body whose cancellation fails is still only too large', async () => {
    const { body, cancelled } = stubborn(64)
    answer(() => new Response(body))
    const error = await readProfile(URL, TOKEN, 1000).catch((caught: unknown) => caught)
    expect((error as Error).message).toBe('oauth provider: invalid_profile')
    expect((error as Error).cause).toBeUndefined()
    expect(cancelled()).toBe(1)
  })

  test('a refused call whose body cannot be cancelled is still only unavailable', async () => {
    const { body, cancelled } = stubborn(1)
    answer(() => new Response(body, { status: 401 }))
    const error = await readProfile(URL, TOKEN, 1000).catch((caught: unknown) => caught)
    expect((error as Error).message).toBe('oauth provider: unavailable')
    expect((error as Error).cause).toBeUndefined()
    expect(`${String(error)}${JSON.stringify(error)}`).not.toContain('canary')
    expect(cancelled()).toBe(1)
  })

  test('a body in several pieces is put together, multi-byte characters across a boundary included', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ name: 'Zoë Åström' }))
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        // One byte at a time: every two-byte character is split.
        for (const byte of bytes) {
          controller.enqueue(new Uint8Array([byte]))
        }
        controller.close()
      },
    })
    answer(() => new Response(body))
    expect(await readProfile(URL, TOKEN, 1000)).toEqual({ name: 'Zoë Åström' })
  })

  test('the cap counts bytes, not characters', async () => {
    // Two bytes a character: half the cap in characters is the cap in bytes, one more is over.
    const fits = JSON.stringify('é'.repeat((MAX_PROFILE_BYTES - 2) / 2))
    expect(new TextEncoder().encode(fits).byteLength).toBe(MAX_PROFILE_BYTES)
    answer(() => new Response(fits))
    expect(await failureOf(readProfile(URL, TOKEN, 1000))).toBe('resolved')
    spies.splice(0).forEach((spy) => {
      spy.mockRestore()
    })
    answer(() => new Response(JSON.stringify('é'.repeat(MAX_PROFILE_BYTES / 2))))
    expect(await failureOf(readProfile(URL, TOKEN, 1000))).toBe('invalid_profile')
  })
})
