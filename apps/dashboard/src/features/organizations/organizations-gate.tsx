import type { ReactNode } from 'react'
import { EmptyState, type QueryLike, QueryState } from '~/components/states'
import { EnvironmentLink } from '~/features/shell/environment-link'
import { isDisabled } from './words'

/**
 * What every organization screen shows while the environment has organizations switched
 * off: the server refuses each route then, and "not allowed" would be the wrong thing to
 * say. The way out is the settings screen.
 *
 * @returns The state.
 */
export function OrganizationsOff() {
  return (
    <EmptyState title='Organizations are switched off in this environment'>
      Nothing is lost: switching them on again in{' '}
      <EnvironmentLink to='/w/$workspaceId/p/$projectId/e/$environmentId/organization-settings'>
        Organization settings
      </EnvironmentLink>{' '}
      restores every organization, membership and role.
    </EmptyState>
  )
}

/**
 * {@link QueryState} for the organization screens: a refused read because organizations are
 * off is said as that, with the way to switch them on.
 *
 * @param props - `query`: the query; `label`: what is loading; `children`: renders the data.
 * @returns The data, a loading or error state, or {@link OrganizationsOff}.
 */
export function OrganizationsQueryState<T>({
  query,
  label,
  children,
}: {
  query: QueryLike<T>
  label?: string
  children: (data: T) => ReactNode
}) {
  if (query.data === undefined && !query.isPending && isDisabled(query.error)) {
    return <OrganizationsOff />
  }
  return (
    <QueryState query={query} label={label}>
      {children}
    </QueryState>
  )
}
