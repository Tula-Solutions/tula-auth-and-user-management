import { expect } from 'bun:test'
import { createMemoryHistory } from '@tanstack/react-router'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App, BASE_PATH, createAppRouter, createQueryClient } from '~/app'
import { clearToasts } from '~/components/toaster'
import { useScope } from '~/state/scope'
import { useSession } from '~/state/session'
import { type FakeApi, IDS, installFakeApi } from './fake-api'

/** The address of the fake's development environment's screens. */
export const DEV_PATH = `/w/${IDS.workspace}/p/${IDS.project}/e/${IDS.development}`
/** The address of the fake's production environment's screens. */
export const PROD_PATH = `/w/${IDS.workspace}/p/${IDS.project}/e/${IDS.production}`

/** Everything a test of the whole app holds. */
export interface World {
  api: FakeApi
  user: ReturnType<typeof userEvent.setup>
  router: ReturnType<typeof createAppRouter>
  queryClient: ReturnType<typeof createQueryClient>
  /** The router's current address, without the `/dashboard` base. */
  location: () => string
}

/**
 * Render the whole dashboard at an address, against the fake API.
 *
 * @param path - An in-app path (`/sign-in`, `${DEV_PATH}/users`).
 * @param options - `signedIn`: whether the browser already has a session (default true);
 *   `api`: a fake API arranged beforehand.
 * @returns The world. Call `world.api.restore()` when done.
 */
export function renderApp(
  path: string,
  options: { signedIn?: boolean; api?: FakeApi } = {}
): World {
  const api = options.api ?? installFakeApi()
  api.state.signedIn = options.signedIn ?? true
  useSession.setState({ status: 'unknown', expiresAt: null })
  useScope.setState({ workspaceId: null, projectId: null, environmentId: null })
  clearToasts()
  const queryClient = createQueryClient()
  const history = createMemoryHistory({ initialEntries: [`${BASE_PATH}${path}`] })
  const router = createAppRouter(queryClient, history)
  render(<App queryClient={queryClient} router={router} />)
  return {
    api,
    user: userEvent.setup(),
    router,
    queryClient,
    location: () => router.state.location.href,
  }
}

/**
 * The number of dialogs open now. Wait for one to close with
 * `await waitFor(() => expect(openDialogs()).toBe(0))`: never hand `expect` an element inside
 * `waitFor` (a failed matcher formats the whole happy-dom window).
 *
 * @returns How many elements have the `dialog` role.
 */
export function openDialogs(): number {
  return screen.queryAllByRole('dialog').length
}

/**
 * Wait until focus is on an element. Compared as a boolean, for the reason at
 * {@link openDialogs}.
 *
 * @param element - The element that should hold focus.
 */
export async function expectFocus(element: Element | null): Promise<void> {
  await waitFor(() => expect(document.activeElement === element).toBe(true))
}

/**
 * Hold back the answers to some requests (they are still received and recorded by the fake).
 * The fake API must be installed first: this wraps the `fetch` that is there. A test that
 * ends without `release()` leaves nothing behind once the fake is restored.
 *
 * @param slow - Which calls to hold.
 * @returns `held`: how many answers are being held. `release`: let them through; it resolves
 *   once each has been handed to the code that asked and that code has had its turn, so what
 *   a test checks next is checked after the answer, not after a pause.
 */
export function holdAnswers(slow: (path: string, headers: Headers, method: string) => boolean) {
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

/**
 * Assert that nothing a secret could be left in holds one: both web storages are empty, and
 * neither the address nor the document contains any of the values.
 *
 * @param world - The world.
 * @param secrets - Values that must be gone.
 */
export function expectNothingKept(world: World, secrets: string[]): void {
  expect(localStorage.length).toBe(0)
  expect(sessionStorage.length).toBe(0)
  const cache = JSON.stringify(
    world.queryClient
      .getQueryCache()
      .getAll()
      .map((query) => query.state.data)
  )
  const mutations = JSON.stringify(
    world.queryClient
      .getMutationCache()
      .getAll()
      .map((mutation) => [mutation.state.data, mutation.state.variables])
  )
  for (const secret of secrets) {
    expect(world.location().includes(secret)).toBe(false)
    expect(window.location.href.includes(secret)).toBe(false)
    expect(document.documentElement.outerHTML.includes(secret)).toBe(false)
    expect(cache.includes(secret)).toBe(false)
    expect(mutations.includes(secret)).toBe(false)
  }
}
