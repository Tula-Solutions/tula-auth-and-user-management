import { useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { type FormEvent, useEffect, useState } from 'react'
import {
  type OrganizationMembership,
  useAddOrganizationMember,
  useGetUser,
  useListOrganizationMemberships,
  useListUsers,
  useRemoveOrganizationMember,
  useUpdateOrganizationMember,
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
import type { EnvironmentScope } from '~/features/users/users-screen'
import { formatDateTime, userLabel } from '~/lib/format'
import { printable, printableName } from '~/lib/printable'
import { refreshOrganizations } from './queries'
import { roleLabel, useRoles } from './use-roles'
import { organizationMessageFor } from './words'

/** How many members one page of the table holds. */
export const MEMBERS_PAGE_SIZE = 20

/**
 * What a member is called on this screen: the user's email address, else their name, else
 * their id. The user is read like any other (the same query as the user's own page).
 *
 * @param userId - The member's user id.
 * @returns The label and, once loaded, whether the user exists.
 */
function useMemberLabel(userId: string): { label: string; known: boolean } {
  const user = useGetUser(userId, { request: useEnvironmentRequest() })
  return user.data
    ? { label: printableName(userLabel(user.data)), known: true }
    : { label: `User ${userId}`, known: false }
}

function MemberName({ userId, scope }: { userId: string; scope: EnvironmentScope }) {
  const { label, known } = useMemberLabel(userId)
  return known ? (
    <Link
      to='/w/$workspaceId/p/$projectId/e/$environmentId/users/$userId'
      params={{ ...scope, userId }}
      className='font-medium text-link underline underline-offset-4'
    >
      {label}
    </Link>
  ) : (
    <span className='font-medium'>{label}</span>
  )
}

/** A member as a dialog was opened for them: the label is the one the row showed. */
interface MemberSnapshot {
  userId: string
  label: string
  role: string
}

function MemberActions({
  membership,
  onChangeRole,
  onRemove,
}: {
  membership: OrganizationMembership
  onChangeRole: (member: MemberSnapshot) => void
  onRemove: (member: MemberSnapshot) => void
}) {
  const { label } = useMemberLabel(membership.userId)
  const snapshot = { userId: membership.userId, label, role: membership.role }
  return (
    <span className='inline-flex flex-wrap gap-2'>
      <ActionButton
        variant='outline'
        size='sm'
        aria-label={`Change the role of ${label}`}
        onClick={() => onChangeRole(snapshot)}
      >
        Change role
      </ActionButton>
      <ActionButton
        variant='outline'
        size='sm'
        aria-label={`Remove ${label}`}
        onClick={() => onRemove(snapshot)}
      >
        Remove
      </ActionButton>
    </span>
  )
}

function RoleOptions({ selected }: { selected?: string }) {
  const roles = useRoles()
  const list = roles.data?.data ?? []
  // A role the list does not hold (read mid-change) stays selectable, so that the select
  // never shows a role other than the one the member has.
  const missing = selected !== undefined && !list.some((role) => role.key === selected)
  return (
    <>
      {list.map((role) => (
        <option key={role.key} value={role.key}>
          {role.name}
          {role.builtIn ? ' (built in)' : ''}
        </option>
      ))}
      {missing ? <option value={selected}>{printable(selected)}</option> : null}
    </>
  )
}

function AddMemberDialog({
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
  const add = useAddOrganizationMember({ request })
  const [typed, setTyped] = useState('')
  const [searched, setSearched] = useState('')
  const [userId, setUserId] = useState('')
  const [role, setRole] = useState('member')
  const [problem, setProblem] = useState<string>()
  // From the click until the dialog closes, which is after the lists were read again.
  const [saving, setSaving] = useState(false)
  const found = useListUsers(
    { q: searched, page: 1, size: 10 },
    { query: { enabled: open && searched !== '' }, request }
  )
  const { reset } = add

  useEffect(() => {
    if (!open) {
      setTyped('')
      setSearched('')
      setUserId('')
      setRole('member')
      setProblem(undefined)
      setSaving(false)
      reset()
    }
  }, [open, reset])

  const results = searched === '' ? [] : (found.data?.data ?? [])

  function search(event: FormEvent) {
    event.preventDefault()
    setUserId('')
    setSearched(typed.trim())
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    if (saving) {
      return
    }
    if (userId === '') {
      setProblem('Search for a user and choose one.')
      return
    }
    setProblem(undefined)
    setSaving(true)
    add.mutate(
      { id: organizationId, data: { userId, role } },
      {
        onError: () => setSaving(false),
        onSuccess: async () => {
          await refreshOrganizations(queryClient)
          notify('Member added')
          onClose()
        },
      }
    )
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title='Add a member'
      description='Add an existing user with a role. To bring in someone without an account, invite them by email instead.'
    >
      <div className='flex flex-col gap-4'>
        <form onSubmit={search} className='flex flex-wrap items-end gap-2'>
          <TextField
            label='Find a user'
            className='min-w-0 flex-1'
            type='search'
            placeholder='Email or name'
            autoComplete='off'
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
          />
          <ActionButton type='submit' variant='outline'>
            Search
          </ActionButton>
        </form>
        <form onSubmit={submit} className='flex flex-col gap-4' noValidate>
          {searched !== '' && found.isPending ? (
            <p role='status' className='text-sm text-muted-foreground'>
              Searching…
            </p>
          ) : null}
          {searched !== '' && !found.isPending && results.length === 0 ? (
            <p role='status' className='text-sm text-muted-foreground'>
              No user matches that search.
            </p>
          ) : null}
          {results.length > 0 ? (
            <SelectField
              label='User'
              value={userId}
              onChange={(event) => setUserId(event.target.value)}
              error={problem}
            >
              <option value=''>Choose a user</option>
              {results.map((user) => (
                <option key={user.id} value={user.id}>
                  {printableName(userLabel(user))}
                </option>
              ))}
            </SelectField>
          ) : problem ? (
            <p role='alert' className='text-sm text-destructive'>
              {problem}
            </p>
          ) : null}
          <SelectField label='Role' value={role} onChange={(event) => setRole(event.target.value)}>
            <RoleOptions selected={role} />
          </SelectField>
          {add.error ? (
            <p role='alert' className='text-sm text-destructive'>
              {organizationMessageFor(add.error)}
            </p>
          ) : null}
          <div className='flex flex-wrap justify-end gap-2'>
            <ActionButton variant='outline' onClick={onClose}>
              Cancel
            </ActionButton>
            <ActionButton type='submit' pending={saving}>
              Add member
            </ActionButton>
          </div>
        </form>
      </div>
    </Modal>
  )
}

function ChangeRoleDialog({
  organizationId,
  member,
  onClose,
}: {
  organizationId: string
  member: MemberSnapshot | null
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const update = useUpdateOrganizationMember({ request: useEnvironmentRequest() })
  const [role, setRole] = useState('')
  const [saving, setSaving] = useState(false)
  const { reset } = update
  const roles = useRoles()

  useEffect(() => {
    setRole(member?.role ?? '')
    setSaving(false)
    reset()
  }, [member, reset])

  function submit(event: FormEvent) {
    event.preventDefault()
    if (member === null || saving) {
      return
    }
    if (role === member.role) {
      onClose()
      return
    }
    setSaving(true)
    update.mutate(
      { id: organizationId, userId: member.userId, data: { role } },
      {
        onError: () => setSaving(false),
        onSuccess: async () => {
          await refreshOrganizations(queryClient)
          notify('Role changed')
          onClose()
        },
      }
    )
  }

  return (
    <Modal
      open={member !== null}
      onClose={onClose}
      title={`Change the role of ${member?.label ?? ''}?`}
      description={
        roles.data ? (
          <>
            Their permissions follow the new role from their next token refresh. An organization
            always keeps a member who can manage its members.
          </>
        ) : undefined
      }
    >
      <form onSubmit={submit} className='flex flex-col gap-4' noValidate>
        <SelectField label='Role' value={role} onChange={(event) => setRole(event.target.value)}>
          <RoleOptions selected={role} />
        </SelectField>
        {update.error ? (
          <p role='alert' className='text-sm text-destructive'>
            {organizationMessageFor(update.error)}
          </p>
        ) : null}
        <div className='flex flex-wrap justify-end gap-2'>
          <ActionButton variant='outline' onClick={onClose}>
            Cancel
          </ActionButton>
          <ActionButton type='submit' pending={saving}>
            Change role
          </ActionButton>
        </div>
      </form>
    </Modal>
  )
}

/** Props of {@link MembersSection}. */
export interface MembersSectionProps {
  organizationId: string
  organizationName: string
  scope: EnvironmentScope
}

/**
 * An organization's members: who they are, their roles, and adding, changing and removing.
 *
 * Removing asks first, naming the member, and in a production environment asks for their
 * address to be typed. The last member who can manage members cannot be demoted or removed;
 * the server refuses, and the refusal is shown in the dialog.
 *
 * @param props - See {@link MembersSectionProps}.
 * @returns The section.
 */
export function MembersSection({ organizationId, organizationName, scope }: MembersSectionProps) {
  const queryClient = useQueryClient()
  const environment = useEnvironment()
  const request = useEnvironmentRequest()
  const [page, setPage] = useState(1)
  const members = useListOrganizationMemberships(
    organizationId,
    { page, size: MEMBERS_PAGE_SIZE },
    { request }
  )
  const roles = useRoles()
  const remove = useRemoveOrganizationMember({ request })
  const [adding, setAdding] = useState(false)
  const [changing, setChanging] = useState<MemberSnapshot | null>(null)
  const [removing, setRemoving] = useState<MemberSnapshot | null>(null)

  function closeRemoval() {
    remove.reset()
    setRemoving(null)
  }

  function runRemoval() {
    if (removing === null) {
      return
    }
    remove.mutate(
      { id: organizationId, userId: removing.userId },
      {
        onSuccess: async () => {
          await refreshOrganizations(queryClient)
          notify('Member removed')
          closeRemoval()
        },
      }
    )
  }

  return (
    <Section
      title='Members'
      description='Everyone who belongs to this organization, with the role each holds, oldest first.'
      actions={<ActionButton onClick={() => setAdding(true)}>Add member</ActionButton>}
    >
      <QueryState query={members} label='Loading members'>
        {(list) =>
          list.data.length === 0 ? (
            <EmptyState title='No members yet'>
              Add an existing user, or invite someone by email below. The first member is usually
              given a role that can manage members.
            </EmptyState>
          ) : (
            <>
              <DataTable
                caption={`Members of ${organizationName}`}
                rows={list.data}
                rowKey={(membership) => membership.id}
                columns={[
                  {
                    header: 'Member',
                    cell: (membership) => <MemberName userId={membership.userId} scope={scope} />,
                  },
                  {
                    header: 'Role',
                    cell: (membership) => roleLabel(roles.data?.data, membership.role),
                  },
                  { header: 'Joined', cell: (membership) => formatDateTime(membership.createdAt) },
                  {
                    header: 'Actions',
                    cell: (membership) => (
                      <MemberActions
                        membership={membership}
                        onChangeRole={setChanging}
                        onRemove={setRemoving}
                      />
                    ),
                  },
                ]}
              />
              <Pagination label='Members' meta={list.meta} onPage={setPage} />
            </>
          )
        }
      </QueryState>
      <AddMemberDialog
        organizationId={organizationId}
        open={adding}
        onClose={() => setAdding(false)}
      />
      <ChangeRoleDialog
        organizationId={organizationId}
        member={changing}
        onClose={() => setChanging(null)}
      />
      <ConfirmDialog
        open={removing !== null}
        title={`Remove ${removing?.label ?? ''} from ${printableName(organizationName)}?`}
        confirmLabel='Remove member'
        destructive
        requireText={environment.kind === 'production' ? removing?.label : undefined}
        pending={remove.isPending}
        error={remove.error}
        errorText={organizationMessageFor}
        onConfirm={runRemoval}
        onCancel={closeRemoval}
      >
        They lose access to the organization at their next token refresh. Their account is not
        deleted, and they can be added or invited again.
      </ConfirmDialog>
    </Section>
  )
}
