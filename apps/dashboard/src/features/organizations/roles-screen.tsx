import { useQueryClient } from '@tanstack/react-query'
import { MAX_CUSTOM_ROLES, MAX_PERMISSIONS_PER_ROLE } from '@tula-tech/contract'
import { useId, useState } from 'react'
import { type OrganizationRole, useDeleteOrganizationRole } from '~/api/generated/api.gen'
import { ActionButton } from '~/components/action-button'
import { ConfirmDialog } from '~/components/confirm-dialog'
import { PageHeader } from '~/components/page'
import { EmptyState } from '~/components/states'
import { notify } from '~/components/toaster'
import { etag } from '~/features/settings/model'
import { useEnvironment, useEnvironmentRequest } from '~/features/shell/environment-context'
import { formatDateTime } from '~/lib/format'
import { printable, printableName } from '~/lib/printable'
import { OrganizationsQueryState } from './organizations-gate'
import { refreshRoles } from './queries'
import { RoleDialog } from './role-dialogs'
import { useRoles } from './use-roles'
import { organizationMessageFor, systemPermissionWords } from './words'

function PermissionList({ permissions }: { permissions: readonly string[] }) {
  if (permissions.length === 0) {
    return <p className='text-sm text-muted-foreground'>No permissions: members can do nothing.</p>
  }
  return (
    <ul className='flex flex-col gap-1.5 text-sm'>
      {permissions.map((key) => {
        const words = systemPermissionWords(key)
        return (
          <li key={key} className='flex flex-wrap items-baseline gap-x-2'>
            {words ? <span>{words.label}</span> : null}
            <code className='font-mono text-xs break-all text-muted-foreground'>
              <bdi dir='ltr'>{printable(key)}</bdi>
            </code>
          </li>
        )
      })}
    </ul>
  )
}

function RoleCard({
  role,
  onEdit,
  onDelete,
}: {
  role: OrganizationRole
  onEdit: (role: OrganizationRole) => void
  onDelete: (role: OrganizationRole) => void
}) {
  const titleId = useId()
  return (
    <section
      aria-labelledby={titleId}
      data-testid='role'
      data-key={role.key}
      className='flex flex-col gap-3 rounded-xl border bg-card p-5 text-card-foreground'
    >
      <div className='flex flex-wrap items-start justify-between gap-3'>
        <div className='flex min-w-0 flex-col gap-1'>
          <h3 id={titleId} className='text-base font-semibold break-words'>
            {printableName(role.name)}
          </h3>
          <p className='flex flex-wrap items-center gap-2 text-xs text-muted-foreground'>
            <code className='font-mono'>{printable(role.key)}</code>
            <span className='rounded-full border border-input px-2 py-0.5 font-medium text-foreground'>
              {role.builtIn ? 'Built in' : 'Custom'}
            </span>
            {role.builtIn ? null : (
              <span>
                Version {role.version}, changed {formatDateTime(role.updatedAt)}
              </span>
            )}
          </p>
        </div>
        {role.builtIn ? null : (
          <div className='flex flex-wrap gap-2'>
            <ActionButton
              variant='outline'
              size='sm'
              aria-label={`Edit the role ${printableName(role.name)}`}
              onClick={() => onEdit(role)}
            >
              Edit
            </ActionButton>
            <ActionButton
              variant='outline'
              size='sm'
              aria-label={`Delete the role ${printableName(role.name)}`}
              onClick={() => onDelete(role)}
            >
              Delete
            </ActionButton>
          </div>
        )}
      </div>
      <PermissionList permissions={role.permissions} />
      {role.builtIn ? (
        <p className='text-xs text-muted-foreground'>
          Built-in roles are Tula’s own: they cannot be edited or deleted.
        </p>
      ) : null}
    </section>
  )
}

/**
 * The roles of an environment: the two built-in roles, read-only, and the custom roles with
 * their permissions, created, changed and deleted here.
 *
 * Changes carry the version the role was listed at (`If-Match`); a stale one is said as
 * "changed since you opened it" and never retried over the other change.
 *
 * @returns The screen.
 */
export function RolesScreen() {
  const queryClient = useQueryClient()
  const environment = useEnvironment()
  const roles = useRoles()
  const [dialog, setDialog] = useState<{ role: OrganizationRole | null } | null>(null)
  const [deleting, setDeleting] = useState<OrganizationRole | null>(null)
  const remove = useDeleteOrganizationRole({
    request: useEnvironmentRequest({ headers: { 'If-Match': etag(deleting?.version ?? 0) } }),
  })

  async function reload(key: string): Promise<OrganizationRole | null> {
    const fresh = await roles.refetch()
    return fresh.data?.data.find((entry) => entry.key === key) ?? null
  }

  function closeDeletion() {
    remove.reset()
    setDeleting(null)
  }

  function runDeletion() {
    if (deleting === null) {
      return
    }
    remove.mutate(
      { key: deleting.key },
      {
        onSuccess: async () => {
          await refreshRoles(queryClient)
          notify('Role deleted')
          closeDeletion()
        },
      }
    )
  }

  return (
    <>
      <PageHeader
        title='Roles'
        description='A role is a set of permissions. Every organization has the two built-in roles; add your own to give members exactly the access your application needs.'
        actions={<ActionButton onClick={() => setDialog({ role: null })}>Create role</ActionButton>}
      />
      <OrganizationsQueryState query={roles} label='Loading roles'>
        {(list) => {
          const builtIn = list.data.filter((role) => role.builtIn)
          const custom = list.data.filter((role) => !role.builtIn)
          return (
            <>
              <section className='flex flex-col gap-3' aria-labelledby='built-in-roles'>
                <h2 id='built-in-roles' className='text-base font-semibold'>
                  Built-in roles
                </h2>
                <ul className='grid gap-4 lg:grid-cols-2'>
                  {builtIn.map((role) => (
                    <li key={role.key}>
                      <RoleCard role={role} onEdit={() => undefined} onDelete={() => undefined} />
                    </li>
                  ))}
                </ul>
              </section>
              <section className='flex flex-col gap-3' aria-labelledby='custom-roles'>
                <h2 id='custom-roles' className='text-base font-semibold'>
                  Custom roles
                </h2>
                <p className='text-sm text-muted-foreground'>
                  {custom.length} of {MAX_CUSTOM_ROLES} custom roles. A role holds at most{' '}
                  {MAX_PERMISSIONS_PER_ROLE} permissions. Giving a role a permission it did not have
                  is a weakening and is asked about first.
                </p>
                {custom.length === 0 ? (
                  <EmptyState title='No custom roles yet'>
                    Create a role such as “Billing manager” with the permissions your application
                    checks. Until then members hold Admin or Member.
                  </EmptyState>
                ) : (
                  <ul className='grid gap-4 lg:grid-cols-2'>
                    {custom.map((role) => (
                      // The environment is part of the key: a card holds open dialogs.
                      <li key={`${environment.id}:${role.key}`}>
                        <RoleCard
                          role={role}
                          onEdit={(entry) => setDialog({ role: entry })}
                          onDelete={setDeleting}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )
        }}
      </OrganizationsQueryState>
      <RoleDialog
        role={dialog?.role ?? null}
        open={dialog !== null}
        onClose={() => setDialog(null)}
        reload={reload}
      />
      <ConfirmDialog
        open={deleting !== null}
        title={`Delete the role ${deleting ? printableName(deleting.name) : ''}?`}
        confirmLabel='Delete role'
        destructive
        requireText={environment.kind === 'production' ? deleting?.key : undefined}
        pending={remove.isPending}
        error={remove.error}
        errorText={organizationMessageFor}
        onConfirm={runDeletion}
        onCancel={closeDeletion}
      >
        A role no member holds can be deleted, and this cannot be undone. A role that is still
        assigned in any organization is refused: give those members another role first.
      </ConfirmDialog>
    </>
  )
}
