import { useQueryClient } from '@tanstack/react-query'
import { INVITATION_EXPIRY_DAYS, INVITATION_STATUSES } from '@tula-tech/contract'
import { type FormEvent, useEffect, useState } from 'react'
import { fieldErrorMap } from '~/api/errors'
import {
  type OrganizationInvitation,
  useGetEnvironmentSettings,
  useInviteToOrganization,
  useListOrganizationInvitations,
  useRevokeOrganizationInvitation,
} from '~/api/generated/api.gen'
import { ActionButton } from '~/components/action-button'
import { ConfirmDialog } from '~/components/confirm-dialog'
import { DataTable, Pagination } from '~/components/data-table'
import { SelectField, TextField } from '~/components/field'
import { Modal } from '~/components/modal'
import { Section } from '~/components/page'
import { EmptyState, QueryState } from '~/components/states'
import { notify } from '~/components/toaster'
import { useEnvironment, useEnvironmentRequest } from '~/features/shell/environment-context'
import { EnvironmentLink } from '~/features/shell/environment-link'
import { formatDateTime } from '~/lib/format'
import { printable, printableName } from '~/lib/printable'
import { refreshOrganizations } from './queries'
import { roleLabel, useRoles } from './use-roles'
import { invitationStatusLabel, organizationMessageFor } from './words'

/** How many invitations one page of the table holds. */
export const INVITATIONS_PAGE_SIZE = 20

/**
 * The redirect URLs an emailed invitation link may lead to: the environment's allowed
 * redirect URLs that a browser opens from an email. A custom scheme is refused by the
 * server for this, so it is not offered.
 *
 * @param allowed - The environment's `urls.allowedRedirectUrls`.
 * @returns The http(s) entries, in the order they are listed.
 */
export function invitationRedirectChoices(allowed: readonly string[]): string[] {
  return allowed.filter((url) => /^https?:\/\//i.test(url))
}

function InviteDialog({
  organizationId,
  open,
  onClose,
}: {
  organizationId: string
  open: boolean
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const request = useEnvironmentRequest()
  const invite = useInviteToOrganization({ request })
  const settings = useGetEnvironmentSettings({ query: { enabled: open }, request })
  const roles = useRoles()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('member')
  const [redirectUrl, setRedirectUrl] = useState('')
  const [problems, setProblems] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const { reset } = invite
  const choices = invitationRedirectChoices(settings.data?.settings.urls?.allowedRedirectUrls ?? [])
  const defaultRole = settings.data?.settings.organizations?.defaultRole
  const chosenUrl = redirectUrl !== '' ? redirectUrl : (choices[0] ?? '')

  useEffect(() => {
    if (!open) {
      setEmail('')
      setRole('member')
      setRedirectUrl('')
      setProblems({})
      setSaving(false)
      reset()
    }
  }, [open, reset])

  // The role an invitation offers when none is chosen is the environment's default role.
  useEffect(() => {
    if (open && defaultRole) {
      setRole(defaultRole)
    }
  }, [open, defaultRole])

  function submit(event: FormEvent) {
    event.preventDefault()
    if (saving) {
      return
    }
    const found: Record<string, string> = {}
    if (email.trim() === '' || !email.includes('@')) {
      found.email = 'Enter the email address to invite.'
    }
    if (chosenUrl === '') {
      found.redirectUrl = 'Choose where the link leads.'
    }
    setProblems(found)
    if (Object.keys(found).length > 0) {
      return
    }
    setSaving(true)
    invite.mutate(
      { id: organizationId, data: { email: email.trim(), role, redirectUrl: chosenUrl } },
      {
        onError: () => setSaving(false),
        onSuccess: async () => {
          await refreshOrganizations(queryClient)
          notify('Invitation sent')
          onClose()
        },
      }
    )
  }

  const errors = { ...fieldErrorMap(invite.error), ...problems }
  const general = invite.error && !errors.email && !errors.role && !errors.redirectUrl
  return (
    <Modal
      open={open}
      onClose={onClose}
      title='Invite by email'
      description={`They are emailed a link that is good for ${INVITATION_EXPIRY_DAYS} days. They join once they sign in, with that address verified, and accept.`}
    >
      <form onSubmit={submit} className='flex flex-col gap-4' noValidate>
        <TextField
          label='Email address'
          type='email'
          autoComplete='off'
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          error={errors.email}
        />
        <SelectField label='Role' value={role} onChange={(event) => setRole(event.target.value)}>
          {(roles.data?.data ?? []).map((entry) => (
            <option key={entry.key} value={entry.key}>
              {entry.name}
              {entry.builtIn ? ' (built in)' : ''}
            </option>
          ))}
          {roles.data?.data.some((entry) => entry.key === role) ? null : (
            <option value={role}>{printable(role)}</option>
          )}
        </SelectField>
        {choices.length === 0 ? (
          <>
            <p role='note' className='rounded-lg border bg-card p-3 text-sm'>
              {settings.isPending ? (
                'Loading the redirect URLs…'
              ) : (
                <>
                  The link needs a page of your app to lead to, and this environment has no allowed
                  https redirect URL. Add one in{' '}
                  <EnvironmentLink to='/w/$workspaceId/p/$projectId/e/$environmentId/settings'>
                    Settings
                  </EnvironmentLink>
                  , then invite.
                </>
              )}
            </p>
            {errors.redirectUrl ? (
              <p role='alert' className='text-sm text-destructive'>
                {errors.redirectUrl}
              </p>
            ) : null}
          </>
        ) : (
          <SelectField
            label='The link leads to'
            value={chosenUrl}
            onChange={(event) => setRedirectUrl(event.target.value)}
            error={errors.redirectUrl}
            hint='One of this environment’s allowed redirect URLs. Your page there reads the invitation from the link and lets the person accept it.'
          >
            {choices.map((url) => (
              <option key={url} value={url}>
                {printable(url)}
              </option>
            ))}
          </SelectField>
        )}
        {general ? (
          <p role='alert' className='text-sm text-destructive'>
            {organizationMessageFor(invite.error)}
          </p>
        ) : null}
        <div className='flex flex-wrap justify-end gap-2'>
          <ActionButton variant='outline' onClick={onClose}>
            Cancel
          </ActionButton>
          <ActionButton type='submit' pending={saving}>
            Send invitation
          </ActionButton>
        </div>
      </form>
    </Modal>
  )
}

/** Props of {@link InvitationsSection}. */
export interface InvitationsSectionProps {
  organizationId: string
  organizationName: string
}

/**
 * An organization's invitations: the ones waiting by default, any other state on request,
 * inviting by email and withdrawing an invitation that is still pending.
 *
 * The invitation's token is never in an answer, so it is never shown; an address from the
 * server is written out with `printable`.
 *
 * @param props - See {@link InvitationsSectionProps}.
 * @returns The section.
 */
export function InvitationsSection({ organizationId, organizationName }: InvitationsSectionProps) {
  const queryClient = useQueryClient()
  const environment = useEnvironment()
  const request = useEnvironmentRequest()
  const [status, setStatus] = useState<OrganizationInvitation['status']>('pending')
  const [page, setPage] = useState(1)
  const invitations = useListOrganizationInvitations(
    organizationId,
    { page, size: INVITATIONS_PAGE_SIZE, status },
    { request }
  )
  const roles = useRoles()
  const revoke = useRevokeOrganizationInvitation({ request })
  const [inviting, setInviting] = useState(false)
  const [revoking, setRevoking] = useState<OrganizationInvitation | null>(null)

  function closeRevocation() {
    revoke.reset()
    setRevoking(null)
  }

  function runRevocation() {
    if (revoking === null) {
      return
    }
    revoke.mutate(
      { id: organizationId, invitationId: revoking.id },
      {
        onSuccess: async () => {
          await refreshOrganizations(queryClient)
          notify('Invitation withdrawn')
          closeRevocation()
        },
      }
    )
  }

  return (
    <Section
      title='Invitations'
      description='People invited by email who have not joined yet.'
      actions={<ActionButton onClick={() => setInviting(true)}>Invite by email</ActionButton>}
    >
      <div className='max-w-xs'>
        <SelectField
          label='Show invitations that are'
          value={status}
          onChange={(event) => {
            setStatus(event.target.value as OrganizationInvitation['status'])
            setPage(1)
          }}
        >
          {INVITATION_STATUSES.map((entry) => (
            <option key={entry} value={entry}>
              {invitationStatusLabel(entry)}
            </option>
          ))}
        </SelectField>
      </div>
      <QueryState query={invitations} label='Loading invitations'>
        {(list) =>
          list.data.length === 0 ? (
            <EmptyState
              title={
                status === 'pending'
                  ? 'No invitations are waiting'
                  : `No ${invitationStatusLabel(status).toLowerCase()} invitations`
              }
            >
              {status === 'pending'
                ? 'Invite someone by email and the invitation waits here until it is accepted, declined, withdrawn or expires.'
                : 'Invitations in this state appear here.'}
            </EmptyState>
          ) : (
            <>
              <DataTable
                caption={`${invitationStatusLabel(status)} invitations to ${printableName(organizationName)}`}
                rows={list.data}
                rowKey={(invitation) => invitation.id}
                columns={[
                  {
                    header: 'Email',
                    cell: (invitation) => (
                      <bdi dir='ltr' className='font-medium'>
                        {printable(invitation.email)}
                      </bdi>
                    ),
                  },
                  {
                    header: 'Role',
                    cell: (invitation) => roleLabel(roles.data?.data, invitation.role),
                  },
                  {
                    header: 'State',
                    cell: (invitation) => invitationStatusLabel(invitation.status),
                  },
                  {
                    header: 'Sent',
                    cell: (invitation) => formatDateTime(invitation.createdAt),
                  },
                  {
                    header: 'Expires',
                    cell: (invitation) => formatDateTime(invitation.expiresAt),
                  },
                  {
                    header: 'Actions',
                    cell: (invitation) =>
                      invitation.status === 'pending' ? (
                        <ActionButton
                          variant='outline'
                          size='sm'
                          aria-label={`Withdraw the invitation to ${printable(invitation.email)}`}
                          onClick={() => setRevoking(invitation)}
                        >
                          Withdraw
                        </ActionButton>
                      ) : (
                        '—'
                      ),
                  },
                ]}
              />
              <Pagination label='Invitations' meta={list.meta} onPage={setPage} />
            </>
          )
        }
      </QueryState>
      <InviteDialog
        organizationId={organizationId}
        open={inviting}
        onClose={() => setInviting(false)}
      />
      <ConfirmDialog
        open={revoking !== null}
        title={`Withdraw the invitation to ${revoking ? printable(revoking.email) : ''}?`}
        confirmLabel='Withdraw invitation'
        destructive
        requireText={
          environment.kind === 'production' && revoking ? printable(revoking.email) : undefined
        }
        pending={revoke.isPending}
        error={revoke.error}
        errorText={organizationMessageFor}
        onConfirm={runRevocation}
        onCancel={closeRevocation}
      >
        The link they were emailed stops working. You can invite the same address again.
      </ConfirmDialog>
    </Section>
  )
}
