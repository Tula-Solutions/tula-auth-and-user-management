import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { type OAuthFailure, OAuthProviderError } from '~/ports/oauth-provider'
import { createGitHubProvider } from './github'
import { MAX_PROFILE_BYTES } from './profile-read'

const TOKEN_URL = 'https://github.com/login/oauth/access_token'
const USER_URL = 'https://api.github.com/user'
const EMAILS_URL = 'https://api.github.com/user/emails'
const ACCESS_TOKEN = 'gho_access_canary'
const credentials = { clientId: 'cid', clientSecret: 'secret' }
const exchangeInput = {
  code: 'the-code',
  codeVerifier: 'the-verifier',
  nonce: 'n',
  redirectUri: 'https://auth.northline.app/v1/oauth/callback/github',
}

type Answer = () => Response
interface Call {
  url: string
  headers: Headers
  redirect: 'follow' | 'error' | 'manual' | undefined
}

const spies: ReturnType<typeof spyOn>[] = []
afterEach(() => {
  for (const spy of spies.splice(0)) {
    spy.mockRestore()
  }
})

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init })

function github(overrides: Record<string, Answer> = {}): Call[] {
  const calls: Call[] = []
  const routes: Record<string, Answer> = {
    [TOKEN_URL]: () => json({ access_token: ACCESS_TOKEN, token_type: 'bearer', scope: 'x' }),
    [USER_URL]: () => json({ id: 42, name: 'Nelly Okafor' }),
    [EMAILS_URL]: () => json([{ email: 'n@northline.app', primary: true, verified: true }]),
    ...overrides,
  }
  spies.push(
    spyOn(globalThis, 'fetch').mockImplementation((async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = input instanceof Request ? input.url : String(input)
      const redirect = input instanceof Request ? input.redirect : init?.redirect
      calls.push({
        url,
        headers: input instanceof Request ? input.headers : new Headers(init?.headers),
        redirect,
      })
      const route = routes[url]
      if (!route) {
        throw new Error(`unexpected request to ${url}`)
      }
      const answer = route()
      if (answer.status >= 300 && answer.status < 400 && redirect === 'error') {
        throw new TypeError('fetch failed: unexpected redirect')
      }
      return answer
    }) as typeof fetch)
  )
  return calls
}

async function failureOf(promise: Promise<unknown>): Promise<OAuthFailure | string> {
  try {
    await promise
    return 'resolved'
  } catch (error) {
    return error instanceof OAuthProviderError ? error.failure : `threw ${String(error)}`
  }
}

describe('GitHub profile reads (H-153)', () => {
  test('sends the Bearer token and the GitHub headers, refusing redirects', async () => {
    const calls = github()
    const profile = await createGitHubProvider().exchange(credentials, exchangeInput)
    expect(profile.subject).toBe('42')
    const read = calls.filter((call) => call.url.startsWith('https://api.github.com'))
    expect(read).toHaveLength(2)
    for (const call of read) {
      expect(call.headers.get('authorization')).toBe(`Bearer ${ACCESS_TOKEN}`)
      expect(call.headers.get('accept')).toBe('application/vnd.github+json')
      expect(call.headers.get('x-github-api-version')).toBe('2022-11-28')
      expect(call.headers.get('user-agent')).toBe('tula-auth')
      expect(call.redirect).toBe('error')
    }
  })

  test('a redirect on /user is not followed with the token', async () => {
    const calls = github({
      [USER_URL]: () =>
        new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }),
    })
    expect(await failureOf(createGitHubProvider().exchange(credentials, exchangeInput))).toBe(
      'unavailable'
    )
    expect(calls.some((call) => call.url.startsWith('https://evil.example'))).toBe(false)
  })

  test('a body over the cap is an invalid profile', async () => {
    github({ [EMAILS_URL]: () => json([{ pad: 'x'.repeat(MAX_PROFILE_BYTES) }]) })
    expect(await failureOf(createGitHubProvider().exchange(credentials, exchangeInput))).toBe(
      'invalid_profile'
    )
  })
})
