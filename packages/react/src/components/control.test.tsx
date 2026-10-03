import { afterEach, describe, expect, jest, mock, spyOn, test } from 'bun:test'
import { act, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { TulaProvider } from '../context'
import { useAuth } from '../hooks/use-auth'
import { useSession } from '../hooks/use-session'
import { useTula } from '../hooks/use-tula'
import { useUser } from '../hooks/use-user'
import {
  failure,
  json,
  ROUTE,
  sessionTokens,
  TEST_BASE_URL,
  TEST_KEY,
  TEST_USER,
  world,
} from '../testing/harness'
import { SignedIn, SignedOut, TulaLoading } from './control'
import { SignIn } from './sign-in'

afterEach(() => {
  jest.useRealTimers()
  mock.restore()
})

function Gates() {
  return (
    <>
      <TulaLoading>loading</TulaLoading>
      <SignedIn>in</SignedIn>
      <SignedOut>out</SignedOut>
    </>
  )
}

describe('<TulaProvider> and the control components', () => {
  test('loading first, then signed out; one load however often effects run', async () => {
    const w = world()
    const { container } = w.mount(
      <StrictMode>
        <Gates />
      </StrictMode>
    )
    expect(container.textContent).toBe('loading')
    await waitFor(() => expect(container.textContent).toBe('out'))
    // StrictMode runs the provider's effect twice; the session is still restored once.
    expect(w.api.calls(ROUTE.refresh)).toHaveLength(1)
  })

  test('a session is restored: signed in, with the user', async () => {
    const w = world({ signedIn: true })
    const { container } = w.mount(<Gates />)
    await waitFor(() => expect(container.textContent).toBe('in'))
    expect(w.client.state).toMatchObject({ status: 'signed-in', user: TEST_USER })
  })

  test('creates its own client from a key and a URL, and keeps it across renders', async () => {
    const fetch = spyOn(globalThis, 'fetch').mockImplementation((async () =>
      failure(401, 'auth.unauthenticated')) as unknown as typeof globalThis.fetch)
    const clients = new Set<unknown>()
    function Probe() {
      clients.add(useTula())
      return null
    }
    const tree = (label: string) => (
      <TulaProvider publishableKey={TEST_KEY} baseUrl={TEST_BASE_URL}>
        <Probe />
        <Gates />
        {label}
      </TulaProvider>
    )
    const { container, rerender } = render(tree('a'))
    await waitFor(() => expect(container.textContent).toBe('outa'))
    rerender(tree('b'))
    expect(clients.size).toBe(1)
    const request = fetch.mock.calls[0]?.[0] as unknown as Request
    expect(request.url).toBe(`${TEST_BASE_URL}/v1/client/sessions/refresh`)
    expect(request.headers.get('x-tula-publishable-key')).toBe(TEST_KEY)
  })

  test('refuses a secret key', () => {
    const error = spyOn(console, 'error').mockImplementation(() => undefined)
    expect(() =>
      render(
        <TulaProvider publishableKey='tula_sk_dev_never_in_a_browser' baseUrl={TEST_BASE_URL}>
          x
        </TulaProvider>
      )
    ).toThrow(/secret key/)
    error.mockRestore()
  })

  test('when the API cannot be reached the state stays loading and load is tried again', async () => {
    jest.useFakeTimers()
    const w = world()
    let online = false
    w.api.on(ROUTE.refresh, () =>
      online ? failure(401, 'auth.unauthenticated') : Promise.reject(new TypeError('offline'))
    )
    const { container } = w.mount(<Gates />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(container.textContent).toBe('loading')
    // One refresh, sent twice by the client itself (its one automatic retry).
    const first = w.api.calls(ROUTE.refresh).length
    expect(first).toBeGreaterThanOrEqual(1)

    online = true
    await act(async () => {
      jest.advanceTimersByTime(2_100)
      await Promise.resolve()
    })
    jest.useRealTimers()
    await waitFor(() => expect(container.textContent).toBe('out'))
    expect(w.api.calls(ROUTE.refresh).length).toBe(first + 1)
  })

  test('coming back online retries at once; unmounting stops the retries', async () => {
    const w = world()
    let online = false
    w.api.on(ROUTE.refresh, () =>
      online ? failure(401, 'auth.unauthenticated') : Promise.reject(new TypeError('offline'))
    )
    const { container, unmount } = w.mount(<Gates />)
    await waitFor(() => expect(w.api.calls(ROUTE.refresh).length).toBeGreaterThanOrEqual(1))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    online = true
    await act(async () => {
      window.dispatchEvent(new Event('online'))
    })
    await waitFor(() => expect(container.textContent).toBe('out'))
    const sent = w.api.calls(ROUTE.refresh).length
    unmount()
    window.dispatchEvent(new Event('online'))
    expect(w.api.calls(ROUTE.refresh).length).toBe(sent)
  })

  test('localization: strings are replaced, error messages are translated through the client', async () => {
    const w = world()
    w.mount(<SignIn />, {
      localization: {
        signIn: { title: 'Inicia sesión', continue: 'Continuar', emailLabel: 'Correo' },
        errors: { 'network.failed': 'Sin conexión.' },
      },
    })
    expect(await screen.findByRole('heading', { name: 'Inicia sesión' })).toBeTruthy()
    w.api.on(ROUTE.signIn, () => Promise.reject(new TypeError('offline')))
    await w.user.type(screen.getByLabelText('Correo'), 'maya@northline.app')
    await w.user.click(screen.getByRole('button', { name: 'Continuar' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Sin conexión.')
  })

  test('appearance: theme tokens become inline custom properties, class names are added, the scheme is forced', async () => {
    const w = world()
    w.mount(
      <SignIn
        appearance={{
          theme: { dark: { primary: '#5eead4' }, radius: '4px' },
          elements: { card: 'from-component', title: 'big' },
        }}
      />,
      {
        appearance: {
          theme: { light: { primary: '#0f766e' }, radius: '6px' },
          colorScheme: 'dark',
          elements: { card: 'from-provider' },
        },
      }
    )
    const root = (await screen.findByRole('heading', { name: 'Sign in' })).closest(
      '.tula-root'
    ) as HTMLElement
    expect(root.getAttribute('data-tula-element')).toBe('root')
    expect(root.getAttribute('data-tula-theme')).toBe('dark')
    expect(root.style.getPropertyValue('--tula-color-primary')).toBe('#0f766e')
    expect(root.style.getPropertyValue('--tula-dark-color-primary')).toBe('#5eead4')
    expect(root.style.getPropertyValue('--tula-radius')).toBe('4px')
    const card = root.querySelector('[data-tula-element="card"]') as HTMLElement
    expect(card.className).toBe('tula-card from-provider from-component')
    expect(screen.getByRole('heading', { name: 'Sign in' }).className).toBe('tula-title big')
  })

  test('with no appearance there is no inline style and no forced scheme', async () => {
    const w = world()
    const { container } = w.mount(<SignIn />)
    await screen.findByText('to continue to Northline')
    const root = container.querySelector('.tula-root') as HTMLElement
    expect(root.getAttribute('style')).toBeNull()
    expect(root.getAttribute('data-tula-theme')).toBeNull()
  })

  test('hooks and components outside a provider say what is missing', () => {
    const error = spyOn(console, 'error').mockImplementation(() => undefined)
    expect(() => render(<SignedIn>x</SignedIn>)).toThrow(/inside <TulaProvider>/)
    error.mockRestore()
  })
})

describe('useAuth, useUser and useSession', () => {
  /** Everything the three hooks return, for a test to look at. */
  function useEverything() {
    return { auth: useAuth(), user: useUser(), session: useSession() }
  }
  type Everything = ReturnType<typeof useEverything>
  function Probe(props: { onValue(value: Everything): void }) {
    props.onValue(useEverything())
    return null
  }

  test('follow the client: loading, signed in with token and user, signed out after signOut', async () => {
    const w = world({ signedIn: true })
    w.api.on(ROUTE.sessions, () => json(200, { data: [] }))
    const navigate = mock()
    let latest = undefined as unknown as Everything
    w.mount(<Probe onValue={(value) => (latest = value)} />, { navigate, afterSignOutUrl: '/' })
    expect(latest.auth).toMatchObject({
      status: 'loading',
      isLoaded: false,
      isSignedIn: false,
      sessionId: null,
    })
    expect(latest.user).toMatchObject({ isLoaded: false, user: null })

    await waitFor(() => expect(latest.auth.isSignedIn).toBe(true))
    expect(latest.auth).toMatchObject({
      status: 'signed-in',
      isLoaded: true,
      sessionId: 'session_1',
    })
    await waitFor(() => expect(latest.user.user).toEqual(TEST_USER))
    expect(await latest.auth.getToken()).toBe(sessionTokens('access_1').accessToken)
    await waitFor(() => expect(latest.session.sessions).toEqual([]))
    expect(latest.session.sessionId).toBe('session_1')

    w.api.on(ROUTE.me, () => json(200, { ...TEST_USER, firstName: 'Mia' }))
    await act(async () => {
      await latest.user.reload()
    })
    expect(latest.user.user?.firstName).toBe('Mia')

    await act(async () => {
      await latest.auth.signOut({ redirectUrl: '/bye' })
    })
    expect(latest.auth).toMatchObject({ status: 'signed-out', isLoaded: true, isSignedIn: false })
    expect(latest.session.sessions).toBeNull()
    expect(navigate).toHaveBeenCalledWith('/bye')
  })

  test('signOut rejects when the server could not be told, and does not navigate', async () => {
    const w = world({ signedIn: true })
    w.api.on(ROUTE.sessions, () => json(200, { data: [] }))
    w.api.on(ROUTE.signOut, () => failure(503, 'service.unavailable'))
    const navigate = mock()
    let latest = undefined as unknown as Everything
    w.mount(<Probe onValue={(value) => (latest = value)} />, { navigate, afterSignOutUrl: '/' })
    await waitFor(() => expect(latest.auth.isSignedIn).toBe(true))
    let caught: unknown
    await act(async () => {
      caught = await latest.auth.signOut().catch((error: unknown) => error)
    })
    expect(caught).toMatchObject({ code: 'service.unavailable' })
    expect(latest.auth.status).toBe('signed-out')
    expect(navigate).not.toHaveBeenCalled()
  })

  test('a user the client could not fetch is asked for once more after a while', async () => {
    jest.useFakeTimers()
    const w = world({ signedIn: true })
    w.api.on(ROUTE.sessions, () => json(200, { data: [] }))
    let fail = true
    w.api.on(ROUTE.me, () => (fail ? failure(503, 'service.unavailable') : json(200, TEST_USER)))
    let latest = undefined as unknown as Everything
    w.mount(<Probe onValue={(value) => (latest = value)} />)
    for (let turn = 0; turn < 20; turn++) {
      await act(async () => {
        await Promise.resolve()
      })
    }
    expect(latest.auth.isSignedIn).toBe(true)
    expect(latest.user.user).toBeNull()
    const asked = w.api.calls(ROUTE.me).length
    fail = false
    await act(async () => {
      jest.advanceTimersByTime(3_100)
      await Promise.resolve()
    })
    jest.useRealTimers()
    await waitFor(() => expect(latest.user.user).toEqual(TEST_USER))
    expect(w.api.calls(ROUTE.me).length).toBe(asked + 1)
  })
})
