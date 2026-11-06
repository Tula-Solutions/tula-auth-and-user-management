import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { createGitHubProvider } from '~/adapters/oauth/github'

// H-082: auto-linking trusts `emailVerified`, so only GitHub's boolean `true` may set it.
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

let fetchSpy: ReturnType<typeof spyOn> | undefined
afterEach(() => fetchSpy?.mockRestore())

describe('GitHub verified-email source', () => {
  test.each([
    ['missing', undefined],
    ['the string "true"', 'true'],
    ['1', 1],
    ['null', null],
  ])('a primary address whose verified is %s is unverified', async (_name, verified) => {
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (
      input: string | URL | Request
    ) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.includes('/login/oauth/access_token')) {
        return json({ access_token: 'gho_access', token_type: 'bearer' })
      }
      if (url.includes('/user/emails')) {
        return json([{ email: 'maya@northline.app', primary: true, verified }])
      }
      return json({ id: 7, login: 'maya', name: null })
    }) as typeof fetch)
    const profile = await createGitHubProvider().exchange(
      { clientId: 'Iv1.github', clientSecret: 'github-secret' },
      {
        code: 'c',
        codeVerifier: 'v',
        nonce: 'n',
        redirectUri: 'https://auth.northline.app/v1/oauth/callback/github',
      }
    )
    expect(profile).toMatchObject({ email: 'maya@northline.app', emailVerified: false })
  })
})
