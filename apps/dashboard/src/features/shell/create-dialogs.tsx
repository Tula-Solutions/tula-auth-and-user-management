import { useQueryClient } from '@tanstack/react-query'
import { type FormEvent, useEffect, useState } from 'react'
import { fieldErrorMap, messageFor } from '~/api/errors'
import {
  type CreatedProject,
  useCreateEnvironment,
  useCreateProject,
  useCreateWorkspace,
  type Workspace,
} from '~/api/generated/api.gen'
import { ActionButton } from '~/components/action-button'
import { ConfirmDialog } from '~/components/confirm-dialog'
import { type EnvironmentKind, KIND_LABEL } from '~/components/environment-badge'
import { TextField } from '~/components/field'
import { Modal } from '~/components/modal'
import { notify } from '~/components/toaster'

/** The longest name the API takes for a workspace or a project. */
const MAX_NAME_LENGTH = 100

/**
 * Check a workspace's or project's name the way the API will.
 *
 * @param name - What was typed.
 * @returns The problem, or `undefined` when the name is fine.
 */
export function nameProblem(name: string): string | undefined {
  const trimmed = name.trim()
  if (trimmed === '') {
    return 'Enter a name.'
  }
  if (trimmed.length > MAX_NAME_LENGTH) {
    return `Use ${MAX_NAME_LENGTH} characters or fewer.`
  }
  return undefined
}

interface NameDialogProps {
  open: boolean
  onClose: () => void
  title: string
  description: string
  submitLabel: string
  pending: boolean
  error: unknown
  onSubmit: (name: string) => void
}

function NameDialog({
  open,
  onClose,
  title,
  description,
  submitLabel,
  pending,
  error,
  onSubmit,
}: NameDialogProps) {
  const [name, setName] = useState('')
  const [problem, setProblem] = useState<string>()
  useEffect(() => {
    if (!open) {
      setName('')
      setProblem(undefined)
    }
  }, [open])
  function submit(event: FormEvent) {
    event.preventDefault()
    const found = nameProblem(name)
    setProblem(found)
    if (found === undefined) {
      onSubmit(name.trim())
    }
  }
  const fieldError = problem ?? fieldErrorMap(error).name
  return (
    <Modal open={open} onClose={onClose} title={title} description={description}>
      <form onSubmit={submit} className='flex flex-col gap-4' noValidate>
        <TextField
          label='Name'
          value={name}
          onChange={(event) => setName(event.target.value)}
          error={fieldError}
          autoComplete='off'
        />
        {error && !fieldError ? (
          <p role='alert' className='text-sm text-destructive'>
            {messageFor(error)}
          </p>
        ) : null}
        <div className='flex flex-wrap justify-end gap-2'>
          <ActionButton variant='outline' onClick={onClose}>
            Cancel
          </ActionButton>
          <ActionButton type='submit' pending={pending}>
            {submitLabel}
          </ActionButton>
        </div>
      </form>
    </Modal>
  )
}

/**
 * Create a workspace: the top of the switcher. A deployment that was never seeded has none.
 *
 * @param props - `open`, `onClose`, and `onCreated` with the new workspace.
 * @returns The dialog.
 */
export function CreateWorkspaceDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  onCreated: (workspace: Workspace) => void
}) {
  const queryClient = useQueryClient()
  const create = useCreateWorkspace()
  function close() {
    create.reset()
    onClose()
  }
  return (
    <NameDialog
      open={open}
      onClose={close}
      title='New workspace'
      description='A workspace groups projects. Most deployments need one.'
      submitLabel='Create workspace'
      pending={create.isPending}
      error={create.error}
      onSubmit={(name) =>
        create.mutate(
          { data: { name } },
          {
            onSuccess: async (workspace) => {
              await queryClient.invalidateQueries({ queryKey: ['/v1/instance/workspaces'] })
              notify('Workspace created')
              close()
              onCreated(workspace)
            },
          }
        )
      }
    />
  )
}

/**
 * Create a project in a workspace. It comes with a development and a production environment.
 *
 * @param props - `workspaceId`, `open`, `onClose`, and `onCreated` with the project and its
 *   environments.
 * @returns The dialog.
 */
export function CreateProjectDialog({
  workspaceId,
  open,
  onClose,
  onCreated,
}: {
  workspaceId: string
  open: boolean
  onClose: () => void
  onCreated: (created: CreatedProject) => void
}) {
  const queryClient = useQueryClient()
  const create = useCreateProject()
  function close() {
    create.reset()
    onClose()
  }
  return (
    <NameDialog
      open={open}
      onClose={close}
      title='Create project'
      description='A project is one application. It gets a development and a production environment, each with its own users, keys and settings.'
      submitLabel='Create project'
      pending={create.isPending}
      error={create.error}
      onSubmit={(name) =>
        create.mutate(
          { data: { workspaceId, name } },
          {
            onSuccess: async (created) => {
              await queryClient.invalidateQueries({ queryKey: ['/v1/instance/projects'] })
              notify('Project created')
              close()
              onCreated(created)
            },
          }
        )
      }
    />
  )
}

/**
 * Add the environment kind a project does not have yet.
 *
 * @param props - `projectId`, the missing `kind`, `open`, `onClose`, and `onCreated` with the
 *   new environment's id.
 * @returns The confirmation.
 */
export function AddEnvironmentDialog({
  projectId,
  kind,
  open,
  onClose,
  onCreated,
}: {
  projectId: string
  kind: EnvironmentKind
  open: boolean
  onClose: () => void
  onCreated: (environmentId: string) => void
}) {
  const queryClient = useQueryClient()
  const create = useCreateEnvironment()
  function close() {
    create.reset()
    onClose()
  }
  return (
    <ConfirmDialog
      open={open}
      title={`Add a ${KIND_LABEL[kind].toLowerCase()} environment?`}
      confirmLabel='Add environment'
      pending={create.isPending}
      error={create.error}
      onCancel={close}
      onConfirm={() =>
        create.mutate(
          { projectId, data: { kind } },
          {
            onSuccess: async (environment) => {
              await queryClient.invalidateQueries({ queryKey: ['/v1/instance/environments'] })
              notify('Environment added')
              close()
              onCreated(environment.id)
            },
          }
        )
      }
    >
      It starts with default settings, its own signing keys and no users or API keys. An environment
      cannot be taken away again from the dashboard.
    </ConfirmDialog>
  )
}
