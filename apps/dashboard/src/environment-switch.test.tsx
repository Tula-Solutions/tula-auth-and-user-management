import { afterEach, describe, expect, test } from 'bun:test'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, screen, waitFor, within } from '@testing-library/react'
import { DEFAULT_ENVIRONMENT_SETTINGS } from '@tula/contract'
import type { ReactNode } from 'react'
import { createQueryClient } from '~/app'
import { useSettingsEditor } from '~/features/settings/settings-editor'
import { EnvironmentProvider } from '~/features/shell/environment-context'
import { useScope } from '~/state/scope'
import { type FakeApi, IDS, installFakeApi } from '~/testing/fake-api'
import { DEV_PATH, openDialogs, PROD_PATH, renderApp, type World } from '~/testing/harness'

// What an operator typed or opened for one environment must never act on another: a route
// whose only change is `$environmentId` is not remounted by the router, so the screens are.

let world: World | undefined
let lone: FakeApi | undefined

function start(path: string, options: Parameters<typeof renderApp>[1] = {}): World {
  world = renderApp(path, options)
  return world
}

afterEach(() => {
  // Nothing a failed test left waiting may run against the next one (or the real network).
  world?.queryClient.clear()
  setOnline(true)
  world?.api.restore()
  world = undefined
  lone?.restore()
  lone = undefined
})

/** What a browser does when the network goes or comes back: the flag, then the event. */
function setOnline(online: boolean) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online })
  act(() => {
    window.dispatchEvent(new Event(online ? 'online' : 'offline'))
  })
}

/**
 * Take the network away: `navigator.onLine` is false and a request that is made anyway gets
 * no answer.
 *
 * @returns A function that brings it back.
 */
function goOffline(): () => void {
  const reachable = globalThis.fetch
  globalThis.fetch = (() =>
    Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch
  setOnline(false)
  return () => {
    globalThis.fetch = reachable
    setOnline(true)
  }
}

/**
 * Hold back the answers to some requests (they are still received and recorded by the fake).
 *
 * @param slow - Which calls to hold.
 * @returns `held`: how many answers are being held. `release`: let them through; it resolves
 *   once each has been handed to the code that asked and that code has had its turn, so what
 *   a test checks next is checked after the answer, not after a pause.
 */
function holdAnswers(slow: (path: string, headers: Headers, method: string) => boolean) {
  const answer = globalThis.fetch
  let open: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    open = resolve
  })
  const handedBack: Promise<void>[] = []
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const response = await answer(input, init)
    const path = new URL(String(input), 'http://localhost:3003').pathname
    // The request's `signal` is deliberately not honoured: the worst case is an answer that
    // arrives although nobody is waiting for it any more.
    if (slow(path, new Headers(init.headers), (init.method ?? 'GET').toUpperCase())) {
      const handed = Promise.withResolvers<void>()
      handedBack.push(handed.promise)
      await gate
      queueMicrotask(handed.resolve)
    }
    return response
  }) as typeof fetch
  return {
    held: () => handedBack.length,
    async release() {
      open()
      await Promise.all(handedBack)
      // The caller reads the answer and the query client tells its observers on a zero
      // timer. Two turns of the timer queue come after both, however slow the machine.
      await new Promise((resolve) => setTimeout(resolve, 0))
      await new Promise((resolve) => setTimeout(resolve, 0))
    },
  }
}

/** Put TanStack's default back for mutations: one started offline waits for the network. */
function queueMutationsWhileOffline(current: World) {
  current.queryClient.setDefaultOptions({
    ...current.queryClient.getDefaultOptions(),
    mutations: { retry: false, networkMode: 'online' },
  })
}

const ENVIRONMENT = 'x-tula-environment'

/**
 * Give the fake one settings document per environment, with the same revision in both: the
 * case where a stale `If-Match` would be accepted.
 */
function settingsPerEnvironment(api: FakeApi) {
  const production = structuredClone(DEFAULT_ENVIRONMENT_SETTINGS)
  production.password.minLength = 14
  const documents: Record<string, { revision: number; settings: typeof production }> = {
    [IDS.development]: { revision: 3, settings: structuredClone(DEFAULT_ENVIRONMENT_SETTINGS) },
    [IDS.production]: { revision: 3, settings: production },
  }
  const puts: { environment: string; ifMatch: string | null; body: typeof production }[] = []
  api.override('GET', /^\/v1\/admin\/settings$/, (call) => ({
    ...structuredClone(documents[call.headers.get(ENVIRONMENT) ?? '']),
    managedBy: null,
  }))
  api.override('PUT', /^\/v1\/admin\/settings$/, (call) => {
    const environment = call.headers.get(ENVIRONMENT) ?? ''
    const body = call.body as typeof production
    puts.push({ environment, ifMatch: call.headers.get('if-match'), body })
    const current = documents[environment]
    const next = { revision: (current?.revision ?? 0) + 1, settings: body }
    documents[environment] = next
    return { ...structuredClone(next), managedBy: null }
  })
  return { documents, puts }
}

async function switchToProduction(current: World, screenPath: string) {
  const switcher = await screen.findByRole('group', { name: 'Switch environment' })
  await current.user.click(within(switcher).getByRole('link', { name: 'Production' }))
  await waitFor(() => expect(current.location()).toBe(`${PROD_PATH}${screenPath}`))
  await waitFor(() => expect(useScope.getState().environmentId).toBe(IDS.production))
}

function minimumLength(): string {
  return (screen.getByLabelText('Minimum length') as HTMLInputElement).value
}

describe('switching environment', () => {
  test('a settings draft does not follow the operator to another environment', async () => {
    const api = installFakeApi()
    const { puts } = settingsPerEnvironment(api)
    const current = start(`${DEV_PATH}/password-policy`, { api })
    const { user } = current
    const minimum = await screen.findByLabelText('Minimum length')
    await user.clear(minimum)
    await user.type(minimum, '16')
    await screen.findByText('You have unsaved changes.')

    await switchToProduction(current, '/password-policy')

    // Production's own values, and nothing to save.
    await waitFor(() => expect(minimumLength()).toBe('14'))
    await screen.findByText('No unsaved changes.')

    // A save from here is made from production's document, for production.
    await user.clear(screen.getByLabelText('Minimum length'))
    await user.type(screen.getByLabelText('Minimum length'), '20')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('Settings saved')
    const expected = structuredClone(DEFAULT_ENVIRONMENT_SETTINGS)
    expected.password.minLength = 20
    expected.password.preset = 'custom'
    expect(puts).toHaveLength(1)
    expect(puts[0]?.environment).toBe(IDS.production)
    expect(puts[0]?.ifMatch).toBe('"3"')
    expect(puts[0]?.body).toEqual(expected)
  })

  test('a half-typed provider secret does not follow the operator to another environment', async () => {
    const current = start(`${DEV_PATH}/sign-in-methods`)
    const { user, api } = current
    const card = () =>
      (screen.getByRole('heading', { name: 'GitHub' }).closest('li') as HTMLElement) ?? null
    await screen.findByRole('heading', { name: 'GitHub' })
    await user.type(within(card()).getByLabelText('Client ID'), 'dev-client')
    await user.type(within(card()).getByLabelText('Client secret'), 'dev-secret-half')

    await switchToProduction(current, '/sign-in-methods')
    await waitFor(() =>
      expect(api.callsTo('GET', '/v1/admin/oauth-providers').at(-1)?.headers.get(ENVIRONMENT)).toBe(
        IDS.production
      )
    )
    await screen.findByRole('heading', { name: 'GitHub' })

    await waitFor(() =>
      expect((within(card()).getByLabelText('Client secret') as HTMLInputElement).value).toBe('')
    )
    expect((within(card()).getByLabelText('Client ID') as HTMLInputElement).value).toBe('')
    expect(document.documentElement.outerHTML.includes('dev-secret-half')).toBe(false)
    expect(api.callsTo('PUT', '/v1/admin/oauth-providers/github')).toHaveLength(0)
  })

  test('an open destructive confirmation does not survive a switch', async () => {
    const current = start(`${DEV_PATH}/api-keys`)
    const { user, router, location } = current
    await screen.findByRole('heading', { level: 1, name: 'API keys' })
    await user.click(screen.getByRole('button', { name: 'Create key' }))
    const creating = screen.getByRole('dialog')
    await user.type(within(creating).getByLabelText('Name'), 'Web app')
    await user.click(within(creating).getByRole('button', { name: 'Create key' }))
    await user.click(await screen.findByRole('button', { name: 'I have copied it' }))
    await waitFor(() => expect(openDialogs()).toBe(0))
    await user.click(await screen.findByRole('button', { name: 'Revoke Web app' }))
    await waitFor(() => expect(openDialogs()).toBe(1))

    // A modal dialog blocks the switcher; the browser's back and forward buttons still move.
    await act(() => router.navigate({ href: `${PROD_PATH}/api-keys` }))
    await waitFor(() => expect(location()).toBe(`${PROD_PATH}/api-keys`))
    await screen.findByRole('heading', { level: 1, name: 'API keys' })

    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(current.api.calls.filter((call) => call.method === 'DELETE')).toHaveLength(0)
  })
})

// A request belongs to the environment of the screen that made it. Two layers, tested apart:
// nothing waits for the network (so nothing is sent later, under another selection), and
// the environment of a request is the caller's, never whatever is selected when it leaves.
describe.each([
  ['as shipped', false],
  ['even with mutations queued while offline', true],
] as const)('a save made offline, then a switch to production (%s)', (_name, queued) => {
  test('a settings save is never sent to production', async () => {
    const api = installFakeApi()
    const { puts, documents } = settingsPerEnvironment(api)
    const current = start(`${DEV_PATH}/password-policy`, { api })
    if (queued) {
      queueMutationsWhileOffline(current)
    }
    const { user } = current
    const minimum = await screen.findByLabelText('Minimum length')
    await user.clear(minimum)
    await user.type(minimum, '16')
    await screen.findByText('You have unsaved changes.')

    const online = goOffline()
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    if (!queued) {
      // Not kept for later: it failed, and the screen says so.
      await screen.findByText(/The API did not answer/)
      await screen.findByText('You have unsaved changes.')
    }
    await switchToProduction(current, '/password-policy')
    online()

    await waitFor(() =>
      expect(api.callsTo('GET', '/v1/admin/settings').at(-1)?.headers.get(ENVIRONMENT)).toBe(
        IDS.production
      )
    )
    await waitFor(() => expect(minimumLength()).toBe('14'))
    await screen.findByText('No unsaved changes.')
    expect(puts.filter((put) => put.environment !== IDS.development)).toEqual([])
    expect(documents[IDS.production]?.settings.password.minLength).toBe(14)
    expect(documents[IDS.production]?.revision).toBe(3)
  })

  test('a provider secret is never sent to production', async () => {
    const current = start(`${DEV_PATH}/sign-in-methods`)
    if (queued) {
      queueMutationsWhileOffline(current)
    }
    const { user, api } = current
    const card = () => screen.getByRole('heading', { name: 'GitHub' }).closest('li') as HTMLElement
    await screen.findByRole('heading', { name: 'GitHub' })
    await user.type(within(card()).getByLabelText('Client ID'), 'dev-client')
    await user.type(within(card()).getByLabelText('Client secret'), 'dev-secret-whole')

    const online = goOffline()
    await user.click(within(card()).getByRole('button', { name: 'Save GitHub' }))
    if (!queued) {
      await within(card()).findByText(/The API did not answer/)
    }
    await switchToProduction(current, '/sign-in-methods')
    online()

    await waitFor(() =>
      expect(api.callsTo('GET', '/v1/admin/oauth-providers').at(-1)?.headers.get(ENVIRONMENT)).toBe(
        IDS.production
      )
    )
    await screen.findByRole('heading', { name: 'GitHub' })
    const sent = api
      .callsTo('PUT', '/v1/admin/oauth-providers/github')
      .map((call) => call.headers.get(ENVIRONMENT))
    expect(sent.filter((environment) => environment !== IDS.development)).toEqual([])
    await waitFor(() =>
      expect((within(card()).getByLabelText('Client ID') as HTMLInputElement).value).toBe('')
    )
    expect(document.documentElement.outerHTML.includes('dev-secret-whole')).toBe(false)
  })
})

describe('an answer that arrives after the switch', () => {
  test('a slow development list does not appear under production', async () => {
    const api = installFakeApi()
    const seeded = api.state.users[0]
    if (!seeded) {
      throw new Error('the fake seeds a user')
    }
    api.override('GET', /^\/v1\/admin\/users$/, (call) => ({
      meta: { totalCount: 1, totalPages: 1, page: 1, perPage: 25 },
      data: [
        call.headers.get(ENVIRONMENT) === IDS.production
          ? { ...seeded, email: 'only-in-production@example.com' }
          : { ...seeded, email: 'only-in-development@example.com' },
      ],
    }))
    const { release, held } = holdAnswers(
      (path, headers) => path === '/v1/admin/users' && headers.get(ENVIRONMENT) === IDS.development
    )
    const current = start(`${DEV_PATH}/users`, { api })
    await waitFor(() => expect(api.callsTo('GET', '/v1/admin/users')).toHaveLength(1))

    await switchToProduction(current, '/users')
    await screen.findByText('only-in-production@example.com')

    // Development's answer arrives now.
    expect(held()).toBe(1)
    await act(release)
    expect(screen.queryAllByText('only-in-development@example.com').length).toBe(0)
    expect(screen.getAllByText('only-in-production@example.com').length).toBeGreaterThan(0)
    const asked = api.callsTo('GET', '/v1/admin/users').map((call) => call.headers.get(ENVIRONMENT))
    expect(asked).toEqual([IDS.development, IDS.production])
  })

  test('a slow development save does not touch production’s screen or document', async () => {
    const api = installFakeApi()
    const { puts, documents } = settingsPerEnvironment(api)
    const { release } = holdAnswers((path, _headers, method) => {
      return path === '/v1/admin/settings' && method === 'PUT'
    })
    const current = start(`${DEV_PATH}/password-policy`, { api })
    const { user } = current
    const minimum = await screen.findByLabelText('Minimum length')
    await user.clear(minimum)
    await user.type(minimum, '16')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(puts).toHaveLength(1))

    await switchToProduction(current, '/password-policy')
    await waitFor(() => expect(minimumLength()).toBe('14'))
    // The save is under way until its answer is let through, and over once it was acted on.
    expect(current.queryClient.isMutating()).toBe(1)
    await act(release)
    await waitFor(() => expect(current.queryClient.isMutating()).toBe(0))

    // The save was development's and stays development's; production shows its own document.
    expect(puts.map((put) => put.environment)).toEqual([IDS.development])
    expect(minimumLength()).toBe('14')
    await screen.findByText('No unsaved changes.')
    expect(screen.queryAllByText('Settings saved').length).toBe(0)
    expect(documents[IDS.production]?.revision).toBe(3)
    // Nothing of development's answer is in the cache production's screen reads from (no key
    // in it names an environment: the whole cache is looked at).
    const cached = JSON.stringify(
      current.queryClient
        .getQueryCache()
        .getAll()
        .map((query) => query.state.data)
    )
    expect(cached.includes('"minLength":14')).toBe(true)
    expect(cached.includes('"minLength":16')).toBe(false)
  })
})

describe('switching user, workspace and project', () => {
  test('a password typed for one user does not follow the operator to another user', async () => {
    const api = installFakeApi()
    const other = '00000000-0000-7000-8000-0000000000d2'
    const first = api.state.users[0]
    if (!first) {
      throw new Error('the fake seeds a user')
    }
    api.state.users.push({ ...first, id: other })
    const current = start(`${DEV_PATH}/users/${IDS.user}`, { api })
    const { user, router, location } = current
    await user.click(await screen.findByRole('button', { name: 'Set password' }))
    await user.type(
      within(screen.getByRole('dialog')).getByLabelText('New password'),
      'granite-Lantern-hums-93'
    )

    await act(() => router.navigate({ href: `${DEV_PATH}/users/${other}` }))
    await waitFor(() => expect(location()).toBe(`${DEV_PATH}/users/${other}`))

    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(document.documentElement.outerHTML.includes('granite-Lantern-hums-93')).toBe(false)
    expect(api.calls.filter((call) => call.method === 'PUT')).toHaveLength(0)
  })

  test('the “new project” dialog of one workspace does not survive a switch to another', async () => {
    const api = installFakeApi()
    const other = '00000000-0000-7000-8000-0000000000a2'
    api.state.workspaces.push({ id: other, name: 'Second', createdAt: '2026-10-04T12:00:00.000Z' })
    const current = start(`/w/${IDS.workspace}`, { api })
    const { user, router, location } = current
    await user.click(
      (await screen.findAllByRole('button', { name: 'Create project' }))[0] as HTMLElement
    )
    await waitFor(() => expect(openDialogs()).toBe(1))
    await user.type(
      within(screen.getByRole('dialog')).getByLabelText('Name'),
      'Typed for the first'
    )

    await act(() => router.navigate({ href: `/w/${other}` }))
    await waitFor(() => expect(location()).toBe(`/w/${other}`))

    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(api.callsTo('POST', '/v1/instance/projects')).toHaveLength(0)
  })

  test('the “add environment” dialog of one project does not survive a switch to another', async () => {
    const api = installFakeApi()
    api.state.environments = api.state.environments.filter((entry) => entry.kind !== 'production')
    const otherProject = '00000000-0000-7000-8000-0000000000b2'
    const otherEnvironment = '00000000-0000-7000-8000-0000000000c9'
    const project = api.state.projects[0]
    const environment = api.state.environments[0]
    if (!project || !environment) {
      throw new Error('the fake seeds a project and an environment')
    }
    api.state.projects.push({ ...project, id: otherProject, name: 'Other' })
    api.state.environments.push({ ...environment, id: otherEnvironment, projectId: otherProject })
    const current = start(`${DEV_PATH}/users`, { api })
    const { user, router, location } = current
    await user.click(await screen.findByRole('button', { name: 'Add production' }))
    await waitFor(() => expect(openDialogs()).toBe(1))

    const target = `/w/${IDS.workspace}/p/${otherProject}/e/${otherEnvironment}/users`
    await act(() => router.navigate({ href: target }))
    await waitFor(() => expect(location()).toBe(target))

    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(api.calls.filter((call) => call.method === 'POST')).toHaveLength(0)
  })
})

type Password = NonNullable<ReturnType<typeof useSettingsEditor>['draft']>['password']

function longer(password: Password): Password {
  return password ? { ...password, minLength: 16 } : password
}

describe('the settings editor without a remount', () => {
  // Defence in depth: the state is forced into what a missing remount would leave behind.
  function editor(api: FakeApi) {
    const queryClient = createQueryClient()
    let environmentId: string = IDS.development
    useScope.setState({
      workspaceId: IDS.workspace,
      projectId: IDS.project,
      environmentId: IDS.development,
    })
    api.state.signedIn = true
    function wrapper({ children }: { children: ReactNode }) {
      return (
        <QueryClientProvider client={queryClient}>
          <EnvironmentProvider environment={{ id: environmentId, kind: 'development' }}>
            {children}
          </EnvironmentProvider>
        </QueryClientProvider>
      )
    }
    const view = renderHook(() => useSettingsEditor(), { wrapper })
    return {
      view,
      show(id: string) {
        environmentId = id
        view.rerender()
      },
    }
  }

  test('the draft belongs to the environment it was loaded for', async () => {
    lone = installFakeApi()
    const { puts } = settingsPerEnvironment(lone)
    const { view, show } = editor(lone)
    await waitFor(() =>
      expect(view.result.current.draft?.password?.minLength).toBe(
        DEFAULT_ENVIRONMENT_SETTINGS.password.minLength
      )
    )
    act(() =>
      view.result.current.update((draft) => ({ ...draft, password: longer(draft.password) }))
    )
    expect(view.result.current.plan?.dirty).toBe(true)

    // The same component instance is now shown for production.
    act(() => useScope.setState({ environmentId: IDS.production }))
    show(IDS.production)

    // Development's draft is not production's: it is gone, then production's loads.
    expect(view.result.current.draft?.password?.minLength === 16).toBe(false)
    await waitFor(() => expect(view.result.current.draft?.password?.minLength).toBe(14))
    expect(view.result.current.plan?.dirty).toBe(false)
    act(() => view.result.current.save())
    expect(puts).toHaveLength(0)
  })

  test('a save is refused when requests would go to another environment than the one loaded', async () => {
    lone = installFakeApi()
    const { puts } = settingsPerEnvironment(lone)
    const { view } = editor(lone)
    await waitFor(() => expect(view.result.current.draft).not.toBeNull())
    act(() =>
      view.result.current.update((draft) => ({ ...draft, password: longer(draft.password) }))
    )
    // The selection moved on (the store is what a request's environment header is read
    // from), but this instance still shows development.
    act(() => useScope.setState({ environmentId: IDS.production }))
    act(() => view.result.current.save())
    await Promise.resolve()
    expect(puts).toHaveLength(0)
    expect(lone.callsTo('PUT', '/v1/admin/settings')).toHaveLength(0)
  })
})
