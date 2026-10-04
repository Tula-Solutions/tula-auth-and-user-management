import { createContext, type ReactNode, useContext } from 'react'
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
