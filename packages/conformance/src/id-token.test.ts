import { describe, expect, test } from 'bun:test'
import { devIdTokens, MOCK_ID_TOKEN_PATH } from './id-token'

type Sent = { url: string; init: RequestInit | undefined }

function fakeServer(answer: () => Response) {
  const sent: Sent[] = []
  const idToken = devIdTokens('http://localhost:3003', {
    fetch: (async (url: string, init?: RequestInit) => {
      sent.push({ url, init })
      return answer()
    }) as unknown as typeof fetch,
  })
  return { idToken, sent }
}

const ASK = { provider: 'google', audience: 'web-client', nonce: 'n-1', email: 'a@b.test' }

describe('devIdTokens', () => {
  test('posts what it was asked, as JSON, to the mock provider’s route and returns the token', async () => {
    const { idToken, sent } = fakeServer(() => Response.json({ idToken: 'minted' }))
    expect(await idToken(ASK)).toBe('minted')
    expect(sent).toHaveLength(1)
    expect(sent[0]?.url).toBe(`http://localhost:3003${MOCK_ID_TOKEN_PATH}`)
    expect(sent[0]?.init?.method).toBe('POST')
    expect(JSON.parse(String(sent[0]?.init?.body))).toEqual(ASK)
    // No header a browser's page would send, a deadline, and no redirect followed.
    expect(sent[0]?.init?.headers).toEqual({ 'content-type': 'application/json' })
    expect(sent[0]?.init?.redirect).toBe('error')
    expect(sent[0]?.init?.signal).toBeInstanceOf(AbortSignal)
  })

  test.each([
    [404, 'a server without the mock provider'],
    [403, 'a server reached at an address that is not loopback'],
    [400, 'a request the route cannot read'],
  ])('%i is an error that says nothing of the answer (%s)', async (status) => {
    const { idToken } = fakeServer(() => new Response('canary-in-the-answer', { status }))
    const error = await idToken(ASK).catch((thrown: unknown) => thrown as Error)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain(String(status))
    expect((error as Error).message).not.toContain('canary')
  })

  test.each([
    ['no token', {}],
    ['an empty token', { idToken: '' }],
    ['a token that is not a string', { idToken: 7 }],
  ])('a 200 with %s is an error', async (_name, body) => {
    const { idToken } = fakeServer(() => Response.json(body))
    await expect(idToken(ASK)).rejects.toThrow('without a token')
  })
})
