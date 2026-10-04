import { useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { type FormEvent, useState } from 'react'
import { fieldErrorMap, messageFor } from '~/api/errors'
import {
  type Project,
  useListInstanceEnvironments,
  useListProjects,
  useListWorkspaces,
  useUpdateProject,
} from '~/api/generated/api.gen'
import { ActionButton } from '~/components/action-button'
import { KIND_LABEL } from '~/components/environment-badge'
import { TextField } from '~/components/field'
import { Modal } from '~/components/modal'
import { PageHeader } from '~/components/page'
import { EmptyState, QueryState } from '~/components/states'
import { notify } from '~/components/toaster'
import { CreateProjectDialog, nameProblem } from '~/features/shell/create-dialogs'
import { formatDateTime } from '~/lib/format'

function RenameProjectDialog({
  project,
  onClose,
}: {
  project: Project | null
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const rename = useUpdateProject()
  const [name, setName] = useState('')
  const [problem, setProblem] = useState<string>()
  const [seen, setSeen] = useState<string | null>(null)
  if (project !== null && seen !== project.id) {
    setSeen(project.id)
    setName(project.name)
    setProblem(undefined)
  }
  function close() {
    setSeen(null)
    rename.reset()
    onClose()
  }
  function submit(event: FormEvent) {
    event.preventDefault()
    const found = nameProblem(name)
    setProblem(found)
    if (found !== undefined || project === null) {
      return
    }
    rename.mutate(
      { projectId: project.id, data: { name: name.trim() } },
      {
        onSuccess: async () => {
          await queryClient.invalidateQueries({ queryKey: ['/v1/instance/projects'] })
          notify('Project renamed')
          close()
        },
      }
    )
  }
  const fieldError = problem ?? fieldErrorMap(rename.error).name
  return (
    <Modal open={project !== null} onClose={close} title='Rename project'>
      <form onSubmit={submit} className='flex flex-col gap-4' noValidate>
        <TextField
          label='Name'
          value={name}
          onChange={(event) => setName(event.target.value)}
          error={fieldError}
          autoComplete='off'
        />
        {rename.error && !fieldError ? (
          <p role='alert' className='text-sm text-destructive'>
            {messageFor(rename.error)}
          </p>
        ) : null}
        <div className='flex flex-wrap justify-end gap-2'>
          <ActionButton variant='outline' onClick={close}>
            Cancel
          </ActionButton>
          <ActionButton type='submit' pending={rename.isPending}>
            Rename
          </ActionButton>
        </div>
      </form>
    </Modal>
  )
}

function ProjectCard({ project, onRename }: { project: Project; onRename: () => void }) {
  const environments = useListInstanceEnvironments({ projectId: project.id, page: 1, size: 100 })
  return (
    <li className='flex flex-col gap-3 rounded-xl border bg-card p-5 text-card-foreground'>
      <div className='flex items-start justify-between gap-3'>
        <div className='min-w-0'>
          <h2 className='truncate text-base font-semibold'>{project.name}</h2>
          <p className='text-xs text-muted-foreground'>
            Created {formatDateTime(project.createdAt)}
          </p>
        </div>
        <ActionButton
          variant='outline'
          size='sm'
          onClick={onRename}
          aria-label={`Rename ${project.name}`}
        >
          Rename
        </ActionButton>
      </div>
      <ul className='flex flex-wrap gap-2' aria-label={`Environments of ${project.name}`}>
        {(environments.data?.data ?? []).map((environment) => (
          <li key={environment.id}>
            <Link
              to='/w/$workspaceId/p/$projectId/e/$environmentId/users'
              params={{
                workspaceId: project.workspaceId,
                projectId: project.id,
                environmentId: environment.id,
              }}
              className='inline-flex rounded-md border border-input px-3 py-1.5 text-sm font-medium hover:bg-accent'
            >
              {KIND_LABEL[environment.kind]}
              <span className='sr-only'> environment of {project.name}</span>
            </Link>
          </li>
        ))}
      </ul>
    </li>
  )
}

/**
 * A workspace: its projects, each with the way into its environments.
 *
 * @param props - `workspaceId` from the address.
 * @returns The screen.
 */
export function WorkspaceScreen({ workspaceId }: { workspaceId: string }) {
  const navigate = useNavigate()
  const workspaces = useListWorkspaces({ page: 1, size: 100 })
  const projects = useListProjects({ workspaceId, page: 1, size: 100 })
  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState<Project | null>(null)
  const workspace = workspaces.data?.data.find((entry) => entry.id === workspaceId)
  return (
    <>
      <PageHeader
        title={workspace?.name ?? 'Workspace'}
        description='Projects in this workspace. Each has a development and a production environment.'
        actions={<ActionButton onClick={() => setCreating(true)}>Create project</ActionButton>}
      />
      <QueryState query={projects} label='Loading projects'>
        {(list) =>
          list.data.length === 0 ? (
            <EmptyState title='No projects yet'>
              Create a project to get its environments, keys and settings.
            </EmptyState>
          ) : (
            <ul className='grid gap-4 lg:grid-cols-2'>
              {list.data.map((project) => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  onRename={() => setRenaming(project)}
                />
              ))}
            </ul>
          )
        }
      </QueryState>
      <CreateProjectDialog
        workspaceId={workspaceId}
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={({ project }) =>
          void navigate({
            to: '/w/$workspaceId/p/$projectId',
            params: { workspaceId, projectId: project.id },
          })
        }
      />
      <RenameProjectDialog project={renaming} onClose={() => setRenaming(null)} />
    </>
  )
}
