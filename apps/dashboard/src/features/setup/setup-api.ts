import { SETUP_LINK_HEADER } from '@tula-tech/contract/headers'
import { ApiError, fromEnvelope } from '~/api/errors'

// The setup portal's one way to the API (ADR 0067, "Setup links"). It is not `dashboardFetch`:
// there is no session here, so no cookie (`credentials: 'omit'`) and no dashboard header, and
// the link's token travels in `x-tula-setup-token` alone. The token is held in memory only:
// it is never written to web storage, the address or a log.

let held: string | null = null

/** What the address held when the page opened: a link's token, or a test sign-in's return. */
export interface SetupBoot {
  token: string | null
  test: string | null
}

let booted: SetupBoot | null = null

/**
 * Read the address once: take the token out of the fragment into memory and remove the
 * fragment from the address, so it stays out of the history and out of a copied address.
 *
 * It runs once per page load (a second call returns the first answer), because React may
 * render a screen twice and the fragment is gone after the first read.
 *
 * @param location - The page's location.
 * @param history - The page's history.
 * @returns The token the link carried and the test id a sign-in returned with, each or `null`.
 */
export function boot(
  location: Pick<Location, 'hash' | 'pathname' | 'search'> = window.location,
  history: Pick<History, 'replaceState'> = window.history
): SetupBoot {
  if (booted !== null) {
    return booted
  }
  const fragment = new URLSearchParams(location.hash.replace(/^#/, ''))
  const token = fragment.get('token')
  const test = fragment.get('tula_test')
  if (token) {
    held = token
  }
  if (location.hash !== '') {
    history.replaceState(null, '', `${location.pathname}${location.search}`)
  }
  booted = { token: held, test: token ? null : test }
  return booted
}

/** Forget the boot read and the token (tests). */
export function resetSetup(): void {
  held = null
  booted = null
}

/**
 * Call a setup route with the link's token.
 *
 * @param path - A path under `/v1/setup`, such as `/connections`.
 * @param init - The method and the JSON body.
 * @returns The parsed JSON answer, or `undefined` for an answer with no body.
 * @throws ApiError for any failure; `auth.invalid_key` is a link that is wrong, ended or revoked.
 */
export async function setupRequest<T>(
  path: string,
  init: { method?: string; body?: unknown } = {}
): Promise<T> {
  if (held === null) {
    throw fromEnvelope(
      401,
      { code: 'auth.invalid_key', detail: 'This setup link is not valid.' },
      null
    )
  }
  let response: Response
  try {
    response = await fetch(`/v1/setup${path}`, {
      method: init.method ?? 'GET',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      headers: {
        [SETUP_LINK_HEADER]: held,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
  } catch {
    throw new ApiError({
      status: 0,
      code: 'network.failed',
      detail: 'The API did not answer. Check your connection, then try again.',
    })
  }
  const text = await response.text()
  let body: unknown
  try {
    body = text === '' ? undefined : JSON.parse(text)
  } catch {
    body = undefined
  }
  if (!response.ok) {
    const seconds = Number(response.headers.get('retry-after'))
    throw fromEnvelope(
      response.status,
      body,
      Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null
    )
  }
  return body as T
}
