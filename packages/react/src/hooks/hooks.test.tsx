import { afterEach, describe, expect, jest, mock, test } from 'bun:test'
import { act, render, screen, waitFor } from '@testing-library/react'
import { renderToString } from 'react-dom/server'
import { SignedIn, SignedOut, TulaLoading } from '../components/control'
import { SignUp } from '../components/sign-up'
import { TulaProvider } from '../context'
import {
  attempt,
  completed,
  failure,
  json,
  ROUTE,
  sessionTokens,
  started,
  TEST_USER,
  world,
} from '../testing/harness'
import { useResetPassword } from './use-reset-password'
import { useSession } from './use-session'
import { useSignIn } from './use-sign-in'
import { useSignUp } from './use-sign-up'
import { useUser } from './use-user'

afterEach(() => {
  jest.useRealTimers()
  mock.restore()
})

describe('the headless flow hooks', () => {
  function useFlows() {
    return { signIn: useSignIn(), signUp: useSignUp(), reset: useResetPassword() }
  }
  type Flows = ReturnType<typeof useFlows>
  function Probe(props: { onValue(value: Flows): void }) {
    props.onValue(useFlows())
    return null
  }

  test('an action before start fails locally with flow.invalid_step and sends nothing', async () => {
    const w = world()
    let latest = undefined as unknown as Flows
    w.mount(<Probe onValue={(value) => (latest = value)} />)
    expect(latest.signIn).toMatchObject({ step: null, isPending: false, error: null })
    const before = w.api.requests.length
    await act(async () => {
      expect(await latest.signIn.submitPassword({ password: 'x' })).toBeNull()
      expect(await latest.signUp.verifyEmail({ code: '123456' })).toBeNull()
      expect(await latest.reset.submit({ code: '123456', password: 'x' })).toBeNull()
      expect(await latest.reset.resendCode()).toBeNull()
    })
    for (const flow of [latest.signIn, latest.signUp, latest.reset]) {
      expect(flow.error).toMatchObject({ code: 'flow.invalid_step', status: 0 })
    }
    expect(
      w.api.requests
        .slice(before)
        .filter((request) => request.method === 'POST' && !request.path.endsWith('/refresh'))
    ).toEqual([])
    act(() => latest.signIn.clearError())
    expect(latest.signIn.error).toBeNull()
  })

  test('one action at a time: a second call while one is pending resolves null and sends nothing', async () => {
    const w = world()
    let release: (response: Response) => void = () => undefined
    w.api.on(ROUTE.signIn, () => new Promise<Response>((resolve) => (release = resolve)))
    let latest = undefined as unknown as Flows
    w.mount(<Probe onValue={(value) => (latest = value)} />)
    let first: Promise<unknown> = Promise.resolve()
    await act(async () => {
      first = latest.signIn.start({ identifier: 'maya@northline.app' })
      expect(await latest.signIn.start({ identifier: 'maya@northline.app' })).toBeNull()
    })
    expect(latest.signIn.isPending).toBe(true)
    expect(w.api.calls(ROUTE.signIn)).toHaveLength(1)
    await act(async () => {
      release(await started('sign_in', { status: 'needs_password' }))
      await first
    })
    expect(latest.signIn).toMatchObject({ step: { status: 'needs_password' }, isPending: false })
  })

  test('reset forgets the attempt; a late answer for it is dropped; a non-Tula failure becomes `internal`', async () => {
    const w = world()
    let release: (response: Response) => void = () => undefined
    w.api.on(ROUTE.signUp, () => new Promise<Response>((resolve) => (release = resolve)))
    let latest = undefined as unknown as Flows
    w.mount(<Probe onValue={(value) => (latest = value)} />)
    let pending: Promise<unknown> = Promise.resolve()
    await act(async () => {
      pending = latest.signUp.start({ email: 'maya@northline.app', password: 'x' })
      await Promise.resolve()
    })
    act(() => latest.signUp.reset())
    await act(async () => {
      release(failure(422, 'email.invalid'))
      await pending
    })
    expect(latest.signUp).toMatchObject({ step: null, error: null, isPending: false })

    w.api.on(ROUTE.reset, () => {
      throw new RangeError('a bug, not an API answer: secret detail')
    })
    await act(async () => {
      await latest.reset.start({ email: 'maya@northline.app' })
    })
    // Core reports a throwing fetch as a network failure; either way the detail is not shown.
    expect(latest.reset.error?.message).not.toContain('secret detail')
    expect(['network.failed', 'internal']).toContain(latest.reset.error?.code ?? '')
  })

  test('a provider that is given another client starts every flow afresh', async () => {
    const a = world()
    const b = world()
    a.api.on(ROUTE.signIn, () => started('sign_in', { status: 'needs_password' }))
    let latest = undefined as unknown as Flows
    const tree = (client: typeof a.client) => (
      <TulaProvider client={client}>
        <Probe onValue={(value) => (latest = value)} />
      </TulaProvider>
    )
    const { rerender } = render(tree(a.client))
    await act(async () => {
      await latest.signIn.start({ identifier: 'maya@northline.app' })
    })
    expect(latest.signIn.step).toEqual({ status: 'needs_password' })
    rerender(tree(b.client))
    await waitFor(() => expect(latest.signIn.step).toBeNull())
    await waitFor(() => expect(b.client.state.status).toBe('signed-out'))
  })

  test('a flow that completes at its start signs in', async () => {
    const w = world()
    w.api.on(ROUTE.signIn, async () => {
      const response = await completed('sign_in')
      const body = (await response.json()) as object
      return json(200, { ...body, attemptSecret: 'tula_at_test_secret' })
    })
    let latest = undefined as unknown as Flows
    w.mount(<Probe onValue={(value) => (latest = value)} />)
    await act(async () => {
      await latest.signIn.start({ identifier: 'maya@northline.app' })
    })
    expect(latest.signIn.step?.status).toBe('complete')
    expect(w.client.state.status).toBe('signed-in')
  })
})

describe('when things the components ask for cannot be had', () => {
  test('no config: no checklist and no app name, and the form still works', async () => {
    const w = world()
    w.api.on(ROUTE.config, () => failure(503, 'service.unavailable'))
    w.mount(<SignUp />)
    await waitFor(() => expect(w.api.calls(ROUTE.config).length).toBeGreaterThan(0))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    expect(screen.queryByRole('list', { name: 'Password requirements' })).toBeNull()
    expect(screen.getByLabelText('Password').getAttribute('aria-describedby')).toBeNull()
  })

  test('a user that still cannot be fetched stays null, quietly', async () => {
    jest.useFakeTimers()
    const w = world({ signedIn: true })
    w.api.on(ROUTE.me, () => failure(503, 'service.unavailable'))
    let user: unknown = 'unset'
    function Probe() {
      user = useUser().user
      return null
    }
    w.mount(<Probe />)
    for (let turn = 0; turn < 20; turn++) {
      await act(async () => {
        await Promise.resolve()
      })
    }
    const asked = w.api.calls(ROUTE.me).length
    await act(async () => {
      jest.advanceTimersByTime(3_100)
      for (let turn = 0; turn < 20; turn++) {
        await Promise.resolve()
      }
    })
    expect(w.api.calls(ROUTE.me).length).toBe(asked + 1)
    expect(user).toBeNull()
    expect(w.client.state.status).toBe('signed-in')
  })
})

describe('hydration', () => {
  test('markup rendered on a server (state: loading) hydrates without a mismatch, then follows the client', async () => {
    const w = world({ signedIn: true })
    w.api.on(ROUTE.sessions, () => json(200, { data: [] }))
    const tree = (
      <TulaProvider client={w.client}>
        <TulaLoading>loading</TulaLoading>
        <SignedIn>in as {TEST_USER.email}</SignedIn>
        <SignedOut>out</SignedOut>
      </TulaProvider>
    )
    const container = document.createElement('div')
    document.body.append(container)
    container.innerHTML = renderToString(tree)
    expect(container.textContent).toBe('loading')
    const errors: unknown[] = []
    const { unmount } = render(tree, {
      container,
      hydrate: true,
      onRecoverableError: (error) => errors.push(error),
    })
    await waitFor(() => expect(container.textContent).toContain('in as'))
    expect(errors).toEqual([])
    unmount()
    container.remove()
  })
})

describe('a result that arrives for a session that is no longer the current one is dropped (F2)', () => {
  const device = (id: string) => ({
    id,
    client: 'web',
    userAgent: null,
    ipAddress: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    lastActiveAt: '2026-10-01T00:00:00.000Z',
    expiresAt: '2030-01-01T00:00:00.000Z',
    current: true,
  })

  /** Sign the client in as someone else: a completed sign-in with a new session id. */
  async function signInAs(w: ReturnType<typeof world>, sessionId: string) {
    w.api.on(ROUTE.signIn, () =>
      attempt(
        'sign_in',
        { status: 'complete', userId: 'user_2', sessionId },
        { attemptSecret: 'tula_at_test_secret', session: sessionTokens('other', { sessionId }) }
      )
    )
    await w.client.signIn.start({ identifier: 'other@northline.app' })
  }

  function mountSessions(w: ReturnType<typeof world>) {
    const seen: (string[] | null)[] = []
    function Probe() {
      const { sessions } = useSession()
      seen.push(sessions ? sessions.map((entry) => entry.id) : null)
      return null
    }
    w.mount(<Probe />)
    return seen
  }

  test('sign out while the device list is on its way: the late list is not shown', async () => {
    const w = world({ signedIn: true })
    let release: (response: Response) => void = () => undefined
    w.api.on(ROUTE.sessions, () => new Promise<Response>((resolve) => (release = resolve)))
    const seen = mountSessions(w)
    await waitFor(() => expect(w.api.calls(ROUTE.sessions)).toHaveLength(1))
    await act(async () => {
      await w.client.session.signOut()
    })
    await act(async () => {
      release(json(200, { data: [device('session_1')] }))
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    expect(seen.at(-1)).toBeNull()
    expect(seen.filter((list) => list !== null)).toEqual([])
  })

  test('another user signs in while the list is on its way: they never see the first user’s devices', async () => {
    const w = world({ signedIn: true })
    const pending: ((response: Response) => void)[] = []
    w.api.on(ROUTE.sessions, () => new Promise<Response>((resolve) => pending.push(resolve)))
    const seen = mountSessions(w)
    await waitFor(() => expect(pending).toHaveLength(1))
    await act(async () => {
      await w.client.session.signOut()
      await signInAs(w, 'session_2')
    })
    // The new session asks for its own list instead of sharing the request still in flight.
    await waitFor(() => expect(pending).toHaveLength(2))
    await act(async () => {
      pending[0]?.(json(200, { data: [device('first_users_phone')] }))
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    expect(seen.flat()).not.toContain('first_users_phone')
    await act(async () => {
      pending[1]?.(json(200, { data: [device('session_2')] }))
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    expect(seen.at(-1)).toEqual(['session_2'])
    expect(seen.flat()).not.toContain('first_users_phone')
  })

  test('a user fetched for one session is not installed into the next', async () => {
    const w = world({ signedIn: true })
    w.api.on(ROUTE.sessions, () => json(200, { data: [] }))
    const users: (string | null)[] = []
    let reload: () => Promise<unknown> = async () => undefined
    function Probe() {
      const result = useUser()
      reload = result.reload
      users.push(result.user?.email ?? null)
      return null
    }
    w.mount(<Probe />)
    await waitFor(() => expect(users.at(-1)).toBe(TEST_USER.email))
    let release: (response: Response) => void = () => undefined
    w.api.on(ROUTE.me, () => new Promise<Response>((resolve) => (release = resolve)))
    let reloading: Promise<unknown> = Promise.resolve()
    await act(async () => {
      reloading = reload().catch(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    w.api.on(ROUTE.me, () =>
      json(200, { ...TEST_USER, id: 'user_2', email: 'other@northline.app' })
    )
    await act(async () => {
      await w.client.session.signOut()
      await signInAs(w, 'session_2')
    })
    await waitFor(() => expect(users.at(-1)).toBe('other@northline.app'))
    await act(async () => {
      release(json(200, TEST_USER))
      await reloading
    })
    expect(users.at(-1)).toBe('other@northline.app')
  })
})
