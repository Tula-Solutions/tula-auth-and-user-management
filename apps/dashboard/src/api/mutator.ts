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
 * (the API refuses the two together); admin calls also name the selected environment. A
 * failure is always an {@link ApiError}; `auth.unauthenticated` also ends the session, which
 * sends the operator back to sign-in.
 *
 * @param url - A path on this origin (`/v1/...`).
 * @param options - `fetch` options from the generated function, plus `onResponse`.
 * @returns The parsed body, or `undefined` for an answer without one.
 * @throws ApiError for a refusal, an unreadable answer, no answer, or an admin call made
 *   with no environment selected (`client.no_environment`, before any request).
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
    const { environmentId } = useScope.getState()
    if (environmentId === null) {
      throw new ApiError({
        status: 0,
        code: 'client.no_environment',
        detail: 'Choose an environment first.',
      })
    }
    headers.set(ENVIRONMENT_HEADER, environmentId)
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
