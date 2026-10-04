import { ENVIRONMENT_HEADER } from '@tula/contract/headers'
import { createContext, type ReactNode, useContext } from 'react'
import type { DashboardRequestInit } from '~/api/mutator'
import type { EnvironmentKind } from '~/components/environment-badge'

/** The environment a screen acts on. */
export interface CurrentEnvironment {
  id: string
  kind: EnvironmentKind
}

const EnvironmentContext = createContext<CurrentEnvironment | null>(null)

/**
 * Give the screens under it the environment they act on.
 *
 * @param props - `environment`: its id and kind.
 * @returns The provider.
 */
export function EnvironmentProvider({
  environment,
  children,
}: {
  environment: CurrentEnvironment
  children: ReactNode
}) {
  return <EnvironmentContext.Provider value={environment}>{children}</EnvironmentContext.Provider>
}

/**
 * The environment the current screen acts on.
 *
 * @returns Its id and kind.
 * @throws Error when used outside an environment route (a programming error).
 */
export function useEnvironment(): CurrentEnvironment {
  const environment = useContext(EnvironmentContext)
  if (environment === null) {
    throw new Error('useEnvironment must be used under an environment route')
  }
  return environment
}

/**
 * The request options of an admin call made by the current screen: they name the environment
 * the screen was rendered for.
 *
 * Every generated admin hook is given these (`useListUsers(params, { request })`). The
 * environment of a request is then fixed when the component renders, not read from the
 * selection when the request finally leaves: a retry, or anything else that runs late, cannot
 * be sent under the environment the operator has switched to meanwhile. `dashboardFetch`
 * refuses an admin call that does not name its environment this way (ADR 0032).
 *
 * Outside an environment route the options name no environment, so an admin call made with
 * them is refused before any request.
 *
 * @param init - Other options of the call (`If-Match`, `onResponse`).
 * @returns `init` with the environment header added.
 */
export function useEnvironmentRequest(init: DashboardRequestInit = {}): DashboardRequestInit {
  const environment = useContext(EnvironmentContext)
  if (environment === null) {
    return init
  }
  const headers = new Headers(init.headers)
  headers.set(ENVIRONMENT_HEADER, environment.id)
  return { ...init, headers: Object.fromEntries(headers.entries()) }
}
