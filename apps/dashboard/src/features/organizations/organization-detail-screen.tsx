import { useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { UpdateOrganizationRequestSchema } from '@tula-tech/contract'
import { type FormEvent, type ReactNode, useEffect, useState } from 'react'
import { fieldErrorMap } from '~/api/errors'
import {
  type Organization,
  useDeleteOrganization,
  useGetOrganization,
  useUpdateOrganization,
} from '~/api/generated/api.gen'
import { ActionButton } from '~/components/action-button'
import { ConfirmDialog } from '~/components/confirm-dialog'
import { TextField } from '~/components/field'
import { Modal } from '~/components/modal'
import { PageHeader, Section } from '~/components/page'
import { notify } from '~/components/toaster'
import { useEnvironment, useEnvironmentRequest } from '~/features/shell/environment-context'
import type { EnvironmentScope } from '~/features/users/users-screen'
import { formatDateTime } from '~/lib/format'
import { printable, printableName } from '~/lib/printable'
import { DomainsSection } from './domains-section'
import { InvitationsSection } from './invitations-section'
import { MembersSection } from './members-section'
import { OrganizationsQueryState } from './organizations-gate'
import { refreshOrganizations } from './queries'
import { organizationMessageFor } from './words'

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className='flex flex-col gap-0.5'>
      <dt className='text-xs font-medium text-muted-foreground'>{label}</dt>
      <dd className='text-sm break-words'>{children}</dd>
    </div>
  )
}

function EditOrganizationDialog({
  organization,
  open,
  onClose,
}: {
  organization: Organization
  open: boolean
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const update = useUpdateOrganization({ request: useEnvironmentRequest() })
  const [name, setName] = useState(organization.name)
  const [slug, setSlug] = useState(organization.slug)
  const [problems, setProblems] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const { reset } = update

  useEffect(() => {
    if (open) {
      setName(organization.name)
      setSlug(organization.slug)
    } else {
      setProblems({})
      setSaving(false)
      reset()
    }
  }, [open, organization.name, organization.slug, reset])

  function submit(event: FormEvent) {
    event.preventDefault()
    if (saving) {
      return
    }
    const body = {
      ...(name !== organization.name ? { name } : {}),
      ...(slug !== organization.slug ? { slug } : {}),
    }
    if (Object.keys(body).length === 0) {
      onClose()
      return
    }
    const parsed = UpdateOrganizationRequestSchema.safeParse(body)
    if (!parsed.success) {
      const found: Record<string, string> = {}
      for (const issue of parsed.error.issues) {
        found[String(issue.path[0])] ??= issue.message
      }
      setProblems(found)
      return
    }
    setProblems({})
    setSaving(true)
    update.mutate(
      { id: organization.id, data: parsed.data },
      {
        onError: () => setSaving(false),
        onSuccess: async () => {
          await refreshOrganizations(queryClient)
          notify('Organization saved')
          onClose()
        },
      }
    )
  }

  const errors = { ...fieldErrorMap(update.error), ...problems }
  const general = update.error && !errors.name && !errors.slug
  return (
    <Modal
      open={open}
      onClose={onClose}
      title='Edit organization'
      description='Changing the slug changes the address apps may have saved for this organization.'
    >
      <form onSubmit={submit} className='flex flex-col gap-4' noValidate>
        <TextField
          label='Name'
          autoComplete='off'
          value={name}
          onChange={(event) => setName(event.target.value)}
          error={errors.name}
        />
        <TextField
          label='Slug'
          autoComplete='off'
          autoCapitalize='off'
          spellCheck={false}
          value={slug}
          onChange={(event) => setSlug(event.target.value)}
          error={errors.slug}
        />
        {general ? (
          <p role='alert' className='text-sm text-destructive'>
            {organizationMessageFor(update.error)}
          </p>
        ) : null}
        <div className='flex flex-wrap justify-end gap-2'>
          <ActionButton variant='outline' onClick={onClose}>
            Cancel
          </ActionButton>
          <ActionButton type='submit' pending={saving}>
            Save changes
          </ActionButton>
        </div>
      </form>
    </Modal>
  )
}

/** Props of {@link OrganizationDetailScreen}. */
export interface OrganizationDetailScreenProps {
  scope: EnvironmentScope
  organizationId: string
  /** Called after the organization was deleted: there is nothing left to show here. */
  onGone: () => void
}

/**
 * One organization: its details, members and invitations, and renaming and deleting it.
 *
 * Deleting names the organization, says what goes with it (every membership and invitation)
 * and in a production environment asks for the slug to be typed.
 *
 * @param props - See {@link OrganizationDetailScreenProps}.
 * @returns The screen.
 */
export function OrganizationDetailScreen({
  scope,
  organizationId,
  onGone,
}: OrganizationDetailScreenProps) {
  const queryClient = useQueryClient()
  const environment = useEnvironment()
  const request = useEnvironmentRequest()
  const organization = useGetOrganization(organizationId, { request })
  const remove = useDeleteOrganization({ request })
  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState(false)

  function closeDeletion() {
    remove.reset()
    setDeleting(false)
  }

  function runDeletion() {
    remove.mutate(
      { id: organizationId },
      {
        onSuccess: async () => {
          setDeleting(false)
          notify('Organization deleted')
          await refreshOrganizations(queryClient)
          onGone()
        },
      }
    )
  }

  return (
    <>
      <Link
        to='/w/$workspaceId/p/$projectId/e/$environmentId/organizations'
        params={scope}
        className='text-sm text-link underline underline-offset-4'
      >
        ← All organizations
      </Link>
      <OrganizationsQueryState query={organization} label='Loading the organization'>
        {(current) => (
          <>
            <PageHeader
              title={printableName(current.name)}
              description={
                <>
                  Slug <code className='text-xs'>{printable(current.slug)}</code>
                </>
              }
              actions={
                <>
                  <ActionButton variant='outline' onClick={() => setEditing(true)}>
                    Edit
                  </ActionButton>
                  <ActionButton variant='destructive' onClick={() => setDeleting(true)}>
                    Delete organization
                  </ActionButton>
                </>
              }
            />
            <Section title='Details'>
              <dl className='grid gap-4 sm:grid-cols-2 lg:grid-cols-3'>
                <Detail label='Created'>{formatDateTime(current.createdAt)}</Detail>
                <Detail label='Created by'>
                  {current.createdBy === null ? (
                    'An administrator'
                  ) : (
                    <Link
                      to='/w/$workspaceId/p/$projectId/e/$environmentId/users/$userId'
                      params={{ ...scope, userId: current.createdBy }}
                      className='text-link underline underline-offset-4'
                    >
                      A user
                    </Link>
                  )}
                </Detail>
                <Detail label='Last changed'>{formatDateTime(current.updatedAt)}</Detail>
                <Detail label='Organization id'>
                  <code className='text-xs'>{current.id}</code>
                </Detail>
              </dl>
            </Section>
            <MembersSection
              organizationId={current.id}
              organizationName={current.name}
              scope={scope}
            />
            <InvitationsSection organizationId={current.id} organizationName={current.name} />
            <DomainsSection organizationId={current.id} organizationName={current.name} />
            <EditOrganizationDialog
              organization={current}
              open={editing}
              onClose={() => setEditing(false)}
            />
            <ConfirmDialog
              open={deleting}
              title={`Delete ${printableName(current.name)}?`}
              confirmLabel='Delete organization'
              destructive
              requireText={environment.kind === 'production' ? printable(current.slug) : undefined}
              pending={remove.isPending}
              error={remove.error}
              errorText={organizationMessageFor}
              onConfirm={runDeletion}
              onCancel={closeDeletion}
            >
              Every membership and invitation of the organization is deleted with it, for good, and
              its members lose the organization at their next token refresh. Their accounts are
              kept. This cannot be undone.
            </ConfirmDialog>
          </>
        )}
      </OrganizationsQueryState>
    </>
  )
}
