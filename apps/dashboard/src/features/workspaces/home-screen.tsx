import { Navigate, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { useListWorkspaces } from '~/api/generated/api.gen'
import { ActionButton } from '~/components/action-button'
import { PageHeader } from '~/components/page'
import { EmptyState, QueryState } from '~/components/states'
import { CreateWorkspaceDialog } from '~/features/shell/create-dialogs'

/**
 * Where the app starts: the first workspace, or the offer to create one on a deployment that
 * has none yet.
 *
 * @returns The screen.
 */
export function HomeScreen() {
  const workspaces = useListWorkspaces({ page: 1, size: 100 })
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)
  return (
    <>
      <PageHeader
        title='Welcome'
        description='Workspaces, projects and environments of this deployment.'
      />
      <QueryState query={workspaces} label='Loading workspaces'>
        {(list) => {
          const first = list.data[0]
          if (first) {
            return <Navigate to='/w/$workspaceId' params={{ workspaceId: first.id }} replace />
          }
          return (
            <EmptyState
              title='No workspace yet'
              action={
                <ActionButton onClick={() => setCreating(true)}>Create a workspace</ActionButton>
              }
            >
              A workspace groups your projects. Create one to add the first project.
            </EmptyState>
          )
        }}
      </QueryState>
      <CreateWorkspaceDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(workspace) =>
          void navigate({ to: '/w/$workspaceId', params: { workspaceId: workspace.id } })
        }
      />
    </>
  )
}
