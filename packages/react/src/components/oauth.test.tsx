import { describe, expect, test } from 'bun:test'
import { screen, waitFor, within } from '@testing-library/react'
import { StrictMode } from 'react'
import {
  attempt,
  failure,
  fakeLinkStorage,
  fakePage,
  json,
  ROUTE,
  sessionTokens,
  type World,
  world,
} from '../testing/harness'
import { OAuthCallback } from './oauth'
import { SignIn } from './sign-in'
import { SignUp } from './sign-up'
import { UserProfile } from './user-profile'

const CALLBACK = 'http://localhost:5173/oauth/callback'
const PROVIDER_URL = 'https://accounts.google.com/o/oauth2/v2/auth?state=s'
const START = 'POST /v1/client/sign-ins/oauth'
const EXCHANGE = 'POST /v1/client/sign-ins/oauth/exchange'
const IDENTITIES = 'GET /v1/client/me/identities'
const LINK_START = 'POST /v1/client/me/identities/oauth'
const LINK_EXCHANGE = 'POST /v1/client/me/identities/oauth/exchange'
const KEY = 'tula.oauth.attempt_1'
const GOOGLE = { id: 'identity_1', provider: 'google', createdAt: '2026-01-01T00:00:00.000Z' }

const started = () => ({
  attempt: {
    id: 'attempt_1',
    kind: 'sign_in',
    expiresAt: '2030-01-01T00:10:00.000Z',
    step: { status: 'needs_first_factor', strategies: ['oauth_google'] },
    attemptSecret: 'tula_at_lost',
  },
  authorizationUrl: PROVIDER_URL,
  binding: 'tula_ob_binding',
})

function signInPage(options: { oauth?: string[]; storage?: boolean; signedIn?: boolean } = {}) {
  const tabStorage = fakeLinkStorage()
  const page = fakePage('http://localhost:5173/sign-in')
  const w = world({
    oauth: options.oauth ?? ['google', 'github', 'apple'],
    tabStorage: options.storage === false ? undefined : tabStorage,
    page,
    signedIn: options.signedIn,
  })
  return { w, page, tabStorage }
}

describe('provider buttons on <SignIn> and <SignUp>', () => {
  test('one accessible button per enabled provider, named by its text, above the form', async () => {
    const { w } = signInPage()
    w.mount(<SignIn oauthCallbackUrl={CALLBACK} />)
    const buttons = await screen.findAllByRole('button', { name: /^Continue with / })
    expect(buttons.map((button) => button.textContent)).toEqual([
      'Continue with Google',
      'Continue with GitHub',
      'Continue with Apple',
    ])
    for (const button of buttons) {
      // The mark is decoration: the name comes from the text.
      expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
      expect(button.getAttribute('type')).toBe('button')
    }
    expect(screen.getByText('or')).toBeTruthy()
    // The provider buttons come before the email field in the document, and so in tab order.
    const email = screen.getByLabelText('Email address')
    expect(
      buttons[0]?.compareDocumentPosition(email) ?? 0 & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  test('a provider this version does not know is left out, and so is everything without a callback page', async () => {
    const { w } = signInPage({ oauth: ['google', 'microsoft'] })
    const { unmount } = w.mount(<SignIn oauthCallbackUrl={CALLBACK} />)
    expect(await screen.findAllByRole('button', { name: /^Continue with / })).toHaveLength(1)
    unmount()
    w.mount(<SignIn />)
    await screen.findByLabelText('Email address')
    expect(screen.queryByRole('button', { name: /^Continue with / })).toBeNull()
    expect(screen.queryByText('or')).toBeNull()
  })

  test('nothing is offered where no provider is enabled, or where the tab cannot keep the binding', async () => {
    for (const options of [{ oauth: [] }, { storage: false }]) {
      const { w } = signInPage(options)
      const { unmount } = w.mount(<SignIn oauthCallbackUrl={CALLBACK} />)
      await screen.findByLabelText('Email address')
      await waitFor(() => expect(w.api.calls(ROUTE.config).length).toBeGreaterThan(0))
      expect(screen.queryByRole('button', { name: /^Continue with / })).toBeNull()
      unmount()
    }
  })

  test('choosing a provider asks for its URL with the page’s callback, keeps the binding and navigates', async () => {
    const { w, page, tabStorage } = signInPage()
    w.api.on(START, () => json(200, started()))
    w.mount(<SignIn />, { oauthCallbackUrl: '/oauth/callback' })
    await w.user.click(await screen.findByRole('button', { name: 'Continue with GitHub' }))
    await waitFor(() => expect(page.assigned).toEqual([PROVIDER_URL]))
    expect(w.api.calls(START)[0]?.body).toEqual({ provider: 'github', redirectUrl: CALLBACK })
    expect(tabStorage.entries.has(KEY)).toBe(true)
    // While the page is being replaced the chosen button stays busy and the others inert.
    expect(
      screen.getByRole('button', { name: 'Continue with GitHub' }).getAttribute('aria-busy')
    ).toBe('true')
    expect(
      screen.getByRole('button', { name: 'Continue with Google' }).getAttribute('aria-disabled')
    ).toBe('true')
    await w.user.click(screen.getByRole('button', { name: 'Continue with Google' }))
    expect(w.api.calls(START)).toHaveLength(1)
  })

  test('a refusal is announced and the buttons work again', async () => {
    const { w, page } = signInPage()
    w.api.on(START, () => failure(403, 'auth.method_disabled'))
    w.mount(<SignIn oauthCallbackUrl={CALLBACK} />)
    await w.user.click(await screen.findByRole('button', { name: 'Continue with Google' }))
    expect((await screen.findByRole('alert')).textContent).toContain('not available')
    expect(page.assigned).toEqual([])
    expect(
      screen.getByRole('button', { name: 'Continue with Google' }).getAttribute('aria-busy')
    ).toBeNull()
  })

  test('<SignUp> offers the same buttons', async () => {
    const { w, page } = signInPage({ oauth: ['apple'] })
    w.api.on(START, () => json(200, started()))
    w.mount(<SignUp oauthCallbackUrl={CALLBACK} />)
    await w.user.click(await screen.findByRole('button', { name: 'Continue with Apple' }))
    await waitFor(() => expect(page.assigned).toEqual([PROVIDER_URL]))
    expect(w.api.calls(START)[0]?.body).toEqual({ provider: 'apple', redirectUrl: CALLBACK })
  })
})

describe('<OAuthCallback>', () => {
  function landing(
    options: { fragment?: string; binding?: 'sign_in' | 'link' | false; signedIn?: boolean } = {}
  ) {
    const tabStorage = fakeLinkStorage()
    const page = fakePage(
      `${CALLBACK}${options.fragment ?? '#tula_ticket=tula_ot_t&tula_attempt=attempt_1'}`
    )
    const w = world({ oauth: ['google'], tabStorage, page, signedIn: options.signedIn })
    if (options.binding !== false) {
      tabStorage.setItem(
        KEY,
        JSON.stringify({
          b: 'tula_ob_binding',
          e: Date.now() + 600_000,
          s: 'http://localhost:3003|tula_pk_test_0000000000000000',
          k: options.binding ?? 'sign_in',
        })
      )
    }
    return { w, page, tabStorage }
  }
  /** The scope the harness's client uses, read back from a real save. */
  async function bind(
    w: World,
    tabStorage: ReturnType<typeof fakeLinkStorage>,
    intent = 'sign_in'
  ) {
    w.api.on(START, () => json(200, started()))
    await w.client.signIn.withOAuth({ provider: 'google', redirectUrl: CALLBACK, navigate: false })
    const entry = JSON.parse(tabStorage.entries.get(KEY) ?? '{}')
    tabStorage.setItem(KEY, JSON.stringify({ ...entry, k: intent }))
  }
  const complete = () =>
    attempt(
      'sign_in',
      { status: 'complete', userId: 'user_1', sessionId: 'session_1' },
      { session: sessionTokens('access_1') }
    )

  test('exchanges the ticket once (also under StrictMode), cleans the address, and goes on signed in', async () => {
    const { w, page, tabStorage } = landing({ binding: false })
    await bind(w, tabStorage)
    w.api.on(EXCHANGE, complete)
    const went: string[] = []
    w.mount(
      <StrictMode>
        <OAuthCallback afterSignInUrl='/app' />
      </StrictMode>,
      { navigate: (url: string) => went.push(url) }
    )
    expect(screen.getByRole('status').textContent).toContain('Finishing sign-in')
    await waitFor(() => expect(went).toEqual(['/app']))
    expect(w.api.calls(EXCHANGE)).toHaveLength(1)
    expect(w.api.calls(EXCHANGE)[0]?.body).toEqual({
      ticket: 'tula_ot_t',
      attemptId: 'attempt_1',
      binding: 'tula_ob_binding',
    })
    expect(page.current).toBe(CALLBACK)
    expect(tabStorage.entries.size).toBe(0)
    expect(w.client.state.status).toBe('signed-in')
  })

  test('`onComplete` is called instead of navigating', async () => {
    const { w, tabStorage } = landing({ binding: false })
    await bind(w, tabStorage)
    w.api.on(EXCHANGE, complete)
    let done = 0
    const went: string[] = []
    w.mount(
      <OAuthCallback
        afterSignInUrl='/app'
        onComplete={() => {
          done += 1
        }}
      />,
      {
        navigate: (url: string) => went.push(url),
      }
    )
    await waitFor(() => expect(done).toBe(1))
    expect(went).toEqual([])
  })

  test('a user with a second factor gets the second-factor screen, and is signed in only after it', async () => {
    const { w, tabStorage } = landing({ binding: false })
    await bind(w, tabStorage)
    w.api.on(EXCHANGE, () =>
      attempt(
        'sign_in',
        { status: 'needs_second_factor', options: ['totp', 'backup_code'] },
        { attemptSecret: 'tula_at_fresh' }
      )
    )
    w.api.on('POST /v1/client/sign-ins/attempt_1/second-factor', complete)
    const went: string[] = []
    w.mount(<OAuthCallback afterSignInUrl='/app' />, { navigate: (url: string) => went.push(url) })
    const code = await screen.findByLabelText(/code/i)
    expect(w.client.state.status).not.toBe('signed-in')
    expect(went).toEqual([])
    await w.user.type(code, '123456')
    await w.user.click(screen.getByRole('button', { name: /verify|continue/i }))
    await waitFor(() => expect(went).toEqual(['/app']))
    const [sent] = w.api.calls('POST /v1/client/sign-ins/attempt_1/second-factor')
    expect(sent?.headers.get('x-tula-attempt')).toBe('tula_at_fresh')
    expect(w.client.state.status).toBe('signed-in')
  })

  test.each([
    [409, 'oauth.account_exists', 'You already have an account', 'Connected accounts'],
    [403, 'oauth.email_unverified', 'We could not sign you in', 'not verified'],
    [410, 'oauth.ticket_invalid', 'We could not sign you in', 'expired'],
  ] as [number, string, string, string][])(
    'a refusal (%p %p) is explained with a next step',
    async (status, code, title, text) => {
      const { w, tabStorage } = landing({ binding: false })
      await bind(w, tabStorage)
      w.api.on(EXCHANGE, () => failure(status, code as never))
      w.mount(<OAuthCallback signInUrl='/sign-in' />)
      const heading = await screen.findByRole('heading', { name: title })
      await waitFor(() => expect(document.activeElement).toBe(heading))
      expect(document.querySelector(`[data-tula-oauth="${code}"]`)?.textContent).toContain(text)
      expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/sign-in')
      expect(w.client.state.status).not.toBe('signed-in')
    }
  )

  test.each([
    ['#tula_error=oauth.access_denied&tula_attempt=attempt_1', 'Sign-in was cancelled'],
    ['#tula_error=oauth.provider_error&tula_attempt=attempt_1', 'We could not sign you in'],
    ['#tula_error=%3Cimg%20src%3Dx%3E&tula_attempt=attempt_1', 'We could not sign you in'],
    ['', 'Nothing to finish here'],
  ])('the address %p is explained without a request', async (fragment, title) => {
    const { w, page } = landing({ fragment, binding: false })
    w.mount(<OAuthCallback />)
    await screen.findByRole('heading', { name: title })
    expect(w.api.calls(EXCHANGE)).toHaveLength(0)
    expect(page.current).toBe(CALLBACK)
    expect(document.body.innerHTML).not.toContain('<img')
  })

  test('a ticket opened where the sign-in was not started completes nothing', async () => {
    const { w } = landing({ binding: false })
    w.mount(<OAuthCallback />)
    await screen.findByRole('heading', { name: 'Start again in this browser' })
    expect(w.api.calls(EXCHANGE)).toHaveLength(0)
    expect(w.client.state.status).not.toBe('signed-in')
  })

  test('a request that got no answer is reported as such', async () => {
    const { w, tabStorage } = landing({ binding: false })
    await bind(w, tabStorage)
    w.api.on(EXCHANGE, () => {
      throw new TypeError('fetch failed')
    })
    w.mount(<OAuthCallback />)
    await screen.findByRole('heading', { name: 'We could not finish signing you in' })
    expect(screen.getByRole('alert').textContent).not.toBe('')
  })

  test('a step this version cannot draw is not guessed at', async () => {
    const { w, tabStorage } = landing({ binding: false })
    await bind(w, tabStorage)
    w.api.on(EXCHANGE, () =>
      attempt('sign_in', { status: 'needs_second_factor', options: ['hologram'] } as never, {
        attemptSecret: 'tula_at_fresh',
      })
    )
    w.mount(<OAuthCallback />)
    await screen.findByRole('heading', { name: 'We could not finish signing you in' })
    expect(w.client.state.status).not.toBe('signed-in')
  })

  test('a link started from the profile ends on “Account connected”', async () => {
    const { w, tabStorage } = landing({ binding: false, signedIn: true })
    await w.client.load()
    await bind(w, tabStorage, 'link')
    w.api.on(LINK_EXCHANGE, () => json(200, GOOGLE))
    const linked: string[] = []
    w.mount(
      <OAuthCallback
        userProfileUrl='/account'
        onLinked={(identity) => linked.push(identity.provider)}
      />
    )
    await screen.findByRole('heading', { name: 'Account connected' })
    expect(screen.getByText(/Your Google account is connected/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Back to your account' }).getAttribute('href')).toBe(
      '/account'
    )
    expect(linked).toEqual(['google'])
    expect(w.api.calls(EXCHANGE)).toHaveLength(0)
  })
})

describe('connected accounts in <UserProfile>', () => {
  async function profile(identities: object[], oauth = ['google', 'github']) {
    const tabStorage = fakeLinkStorage()
    const page = fakePage('http://localhost:5173/account')
    const w = world({ signedIn: true, oauth, tabStorage, page })
    w.api.on(ROUTE.sessions, () => json(200, { data: [] }))
    let current = identities
    w.api.on(IDENTITIES, () => json(200, { data: current }))
    await w.client.load()
    w.mount(<UserProfile oauthCallbackUrl={CALLBACK} />)
    const section = (await screen.findByRole('heading', { name: 'Connected accounts' })).closest(
      'section'
    ) as HTMLElement
    return {
      w,
      page,
      tabStorage,
      section,
      set: (next: object[]) => {
        current = next
      },
    }
  }

  test('lists the connected accounts and offers to connect the providers that are not', async () => {
    const { section } = await profile([GOOGLE])
    const view = within(section)
    await view.findByText('Google')
    expect(view.getByRole('button', { name: 'Disconnect Google' })).toBeTruthy()
    expect(view.getByRole('button', { name: 'Connect GitHub' })).toBeTruthy()
    expect(view.queryByRole('button', { name: 'Connect Google' })).toBeNull()
  })

  test('with none connected it says so', async () => {
    const { section } = await profile([])
    expect(await within(section).findByText('No accounts are connected.')).toBeTruthy()
  })

  test('connect keeps the binding as a link and sends the browser to the provider', async () => {
    const { w, page, tabStorage, section } = await profile([])
    w.api.on(LINK_START, () =>
      json(200, {
        attemptId: 'attempt_1',
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        authorizationUrl: PROVIDER_URL,
        binding: 'tula_ob_binding',
      })
    )
    await w.user.click(await within(section).findByRole('button', { name: 'Connect GitHub' }))
    await waitFor(() => expect(page.assigned).toEqual([PROVIDER_URL]))
    expect(w.api.calls(LINK_START)[0]?.body).toEqual({ provider: 'github', redirectUrl: CALLBACK })
    expect(JSON.parse(tabStorage.entries.get(KEY) ?? '{}').k).toBe('link')
  })

  test('disconnect removes the account, says so, and reloads the list', async () => {
    const { w, section, set } = await profile([GOOGLE])
    w.api.on('DELETE /v1/client/me/identities/identity_1', () => {
      set([])
      return new Response(null, { status: 204 })
    })
    await w.user.click(await within(section).findByRole('button', { name: 'Disconnect Google' }))
    expect((await within(section).findByRole('status')).textContent).toBe(
      'Google was disconnected.'
    )
    expect(within(section).queryByRole('button', { name: 'Disconnect Google' })).toBeNull()
  })

  test('the last way to sign in cannot be disconnected: the server’s reason is shown', async () => {
    const { w, section } = await profile([GOOGLE])
    w.api.on('DELETE /v1/client/me/identities/identity_1', () =>
      failure(409, 'identity.last_sign_in_method' as never)
    )
    await w.user.click(await within(section).findByRole('button', { name: 'Disconnect Google' }))
    expect((await within(section).findByRole('alert')).textContent).toContain('only way to sign in')
    expect(within(section).getByRole('button', { name: 'Disconnect Google' })).toBeTruthy()
  })

  test('a list that cannot be loaded is reported; an unknown provider is shown by its name', async () => {
    const failed = world({
      signedIn: true,
      oauth: ['google'],
      tabStorage: fakeLinkStorage(),
      page: fakePage('http://localhost:5173/account'),
    })
    failed.api.on(ROUTE.sessions, () => json(200, { data: [] }))
    failed.api.on(IDENTITIES, () => failure(500, 'internal'))
    await failed.client.load()
    const { unmount } = failed.mount(<UserProfile oauthCallbackUrl={CALLBACK} />)
    const heading = await screen.findByRole('heading', { name: 'Connected accounts' })
    expect(await within(heading.closest('section') as HTMLElement).findByRole('alert')).toBeTruthy()
    unmount()
    const { section } = await profile([{ ...GOOGLE, provider: 'microsoft' }])
    expect(await within(section).findByText('microsoft')).toBeTruthy()
  })

  test('where no provider is enabled the section and its request are left out', async () => {
    const w = world({ signedIn: true })
    w.api.on(ROUTE.sessions, () => json(200, { data: [] }))
    await w.client.load()
    w.mount(<UserProfile oauthCallbackUrl={CALLBACK} />)
    await screen.findByRole('heading', { name: 'Devices' }).catch(() => null)
    expect(screen.queryByRole('heading', { name: 'Connected accounts' })).toBeNull()
    expect(w.api.calls(IDENTITIES)).toHaveLength(0)
  })
})
