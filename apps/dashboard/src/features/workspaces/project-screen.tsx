import { Navigate } from '@tanstack/react-router'
import { useListInstanceEnvironments } from '~/api/generated/api.gen'
import { PageHeader } from '~/components/page'
import { EmptyState, QueryState } from '~/components/states'

/**
 * A project's address without an environment: go to its development environment (or the
 * only one it has).
 *
 * @param props - `workspaceId` and `projectId` from the address.
 * @returns A redirect, or a state.
 */
export function ProjectScreen({
  workspaceId,
  projectId,
}: {
  workspaceId: string
  projectId: string
}) {
  const environments = useListInstanceEnvironments({ projectId, page: 1, size: 100 })
  return (
    <>
      <PageHeader title='Project' />
      <QueryState query={environments} label='Loading environments'>
        {(list) => {
          const target = list.data.find((entry) => entry.kind === 'development') ?? list.data[0]
          if (!target) {
            return (
              <EmptyState title='No environment yet'>
                Add an environment from the switcher at the top of the page.
              </EmptyState>
            )
          }
          return (
            <Navigate
              to='/w/$workspaceId/p/$projectId/e/$environmentId/users'
              params={{ workspaceId, projectId, environmentId: target.id }}
              replace
            />
          )
        }}
      </QueryState>
    </>
  )
}
