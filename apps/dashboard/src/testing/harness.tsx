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
