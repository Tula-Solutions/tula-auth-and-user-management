import {
  DASHBOARD_HEADER,
  DASHBOARD_HEADER_VALUE,
  ENVIRONMENT_HEADER,
} from '@tula/contract/headers'
import { ApiError, fromEnvelope } from '~/api/errors'
import { useScope } from '~/state/scope'
import { useSession } from '~/state/session'

/** Options of one API call: `fetch`'s own, plus a look at the raw response. */
export interface DashboardRequestInit extends RequestInit {
  /**
   * Called with the response of a successful call, for the few answers whose meaning is in a
   * header (`x-tula-can-still-sign-in`).
   */
  onResponse?: (response: Response) => void
}

/** Admin routes act on one environment, named by a header (ADR 0032). */
const ADMIN_PREFIX = '/v1/admin/'

function retryAfterOf(response: Response): number | null {
  const seconds = Number(response.headers.get('retry-after'))
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return undefined
  }
}

/**
 * The one way the dashboard calls the API (Orval's mutator: every generated hook uses it).
 *
 * Each request carries `x-tula-dashboard: 1` and the session cookie, never `Authorization`
 * (the API refuses the two together). A failure is always an {@link ApiError};
 * `auth.unauthenticated` also ends the session, which sends the operator back to sign-in.
 *
 * An admin call acts on one environment, and says which itself: the `x-tula-environment`
 * header in `options`, put there by `useEnvironmentRequest` when the calling screen rendered.
 * This function never fills it in from the current selection, and it sends nothing when the
 * two differ, so no admin request can leave for an environment other than the one its
 * caller was drawn for (ADR 0032).
 *
 * @param url - A path on this origin (`/v1/...`).
 * @param options - `fetch` options from the generated function, plus `onResponse`.
 * @returns The parsed body, or `undefined` for an answer without one.
 * @throws ApiError for a refusal, an unreadable answer or no answer; and, before any request,
 *   for an admin call that names no environment (`client.no_environment`) or one that is no
 *   longer the selected environment (`client.environment_changed`).
 */
export async function dashboardFetch<T>(
  url: string,
  options: DashboardRequestInit = {}
): Promise<T> {
  const { onResponse, headers: given, ...init } = options
  const headers = new Headers(given)
  headers.delete('authorization')
  headers.set(DASHBOARD_HEADER, DASHBOARD_HEADER_VALUE)
  if (url.startsWith(ADMIN_PREFIX)) {
    // The environment is the caller's (`useEnvironmentRequest`: fixed when its screen
    // rendered), never the selection at the time the request leaves: a call that runs late
    // (a retry, a mutation that waited) would otherwise be made under whatever the operator
    // switched to meanwhile.
    const named = headers.get(ENVIRONMENT_HEADER)
    if (named === null || named === '') {
      throw new ApiError({
        status: 0,
        code: 'client.no_environment',
        detail: 'Choose an environment first.',
      })
    }
    // And a screen whose environment is no longer the selected one is on its way out: what
    // it still asks for is not sent at all, rather than done behind the operator's back.
    if (named !== useScope.getState().environmentId) {
      throw new ApiError({
        status: 0,
        code: 'client.environment_changed',
        detail: 'The environment was switched before this was sent. Nothing was changed.',
      })
    }
  } else {
    headers.delete(ENVIRONMENT_HEADER)
  }

  let response: Response
  try {
    response = await fetch(url, { ...init, headers, credentials: 'include' })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error
    }
    // Nothing of the failure is kept: a network error's text can name internal hosts.
    throw new ApiError({ status: 0, code: 'network.failed', detail: 'The API did not answer.' })
  }

  if (!response.ok) {
    const failure = fromEnvelope(response.status, await readJson(response), retryAfterOf(response))
    if (failure.status === 401 && failure.code === 'auth.unauthenticated') {
      useSession.getState().signedOut()
    }
    throw failure
  }
  onResponse?.(response)
  if (response.status === 204 || response.status === 205) {
    return undefined as T
  }
  const body = await readJson(response)
  if (body === undefined) {
    throw fromEnvelope(response.status, undefined, null)
  }
  return body as T
}
