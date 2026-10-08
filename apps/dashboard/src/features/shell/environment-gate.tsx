import type { ReactNode } from 'react'
import { useListInstanceEnvironments } from '~/api/generated/api.gen'
import { PageHeader } from '~/components/page'
import { EmptyState, QueryState } from '~/components/states'
import { EnvironmentProvider } from './environment-context'

/**
 * Draw an environment's screens only once the environment is known to exist in its project.
 *
 * The ids come from the address, which anyone can type: an environment that is not the
 * project's is "not found" here, before any admin call is made for it.
 *
 * The screens are keyed by the environment: the router does not remount a route whose only
 * change is `$environmentId`, and a draft, a half-typed secret or an open confirmation of one
 * environment must never be shown, or sent, under another (ADR 0032).
 *
 * @param props - `projectId` and `environmentId` from the route, and the screens.
 * @returns The screens under an {@link EnvironmentProvider}, or a state.
 */
export function EnvironmentGate({
  projectId,
  environmentId,
  children,
}: {
  projectId: string
  environmentId: string
  children: ReactNode
}) {
  const environments = useListInstanceEnvironments({ projectId, page: 1, size: 100 })
  return (
    <QueryState query={environments} label='Loading the environment'>
      {(list) => {
        const environment = list.data.find((entry) => entry.id === environmentId)
        if (!environment) {
          return (
            <>
              <PageHeader title='Environment' />
              <EmptyState title='Environment not found'>
                This project has no environment with that id. Choose a project from the navigation.
              </EmptyState>
            </>
          )
        }
        return (
          <EnvironmentProvider
            key={environment.id}
            environment={{ id: environment.id, kind: environment.kind }}
          >
            {children}
          </EnvironmentProvider>
        )
      }}
    </QueryState>
  )
}
