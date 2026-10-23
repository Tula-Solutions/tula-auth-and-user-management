import { Link } from '@tanstack/react-router'
import { useGetOrganization, useListUserOrganizations } from '~/api/generated/api.gen'
import { DataTable, Pagination } from '~/components/data-table'
import { Section } from '~/components/page'
import { QueryState } from '~/components/states'
import { OrganizationsOff } from '~/features/organizations/organizations-gate'
import { roleLabel, useRoles } from '~/features/organizations/use-roles'
import { isDisabled, lastManagerOrganizationIds } from '~/features/organizations/words'
import { useEnvironmentRequest } from '~/features/shell/environment-context'
import { formatDateTime } from '~/lib/format'
import { printable, printableName } from '~/lib/printable'
import type { EnvironmentScope } from './users-screen'

/** How many memberships one page of the user's table holds. */
export const USER_ORGANIZATIONS_PAGE_SIZE = 10

/**
 * The organizations a user belongs to, with their role in each: a section of the user's
 * page, with a link to each organization.
 *
 * While organizations are switched off the server answers nothing about them, and the
 * section says so instead of showing an error.
 *
 * @param props - `userId` and the environment's `scope`, for the links.
 * @param page - The page of memberships shown, from 1.
 * @param onPage - Show another page.
 * @returns The section.
 */
export function UserOrganizations({
  userId,
  scope,
  page,
  onPage,
}: {
  userId: string
  scope: EnvironmentScope
  page: number
  onPage: (page: number) => void
}) {
  const memberships = useListUserOrganizations(
    userId,
    { page, size: USER_ORGANIZATIONS_PAGE_SIZE },
    { request: useEnvironmentRequest() }
  )
  const roles = useRoles()
  return (
    <Section
      title='Organizations'
      description='The organizations this user belongs to, and the role they hold in each.'
    >
      {memberships.data === undefined && !memberships.isPending && isDisabled(memberships.error) ? (
        <OrganizationsOff />
      ) : (
        <QueryState query={memberships} label='Loading organizations'>
          {(list) =>
            list.data.length === 0 ? (
              <p className='text-sm text-muted-foreground'>
                This user does not belong to any organization.
              </p>
            ) : (
              <>
                <DataTable
                  caption='Organizations of this user'
                  rows={list.data}
                  rowKey={(membership) => membership.organizationId}
                  columns={[
                    {
                      header: 'Organization',
                      cell: (membership) => (
                        <Link
                          to='/w/$workspaceId/p/$projectId/e/$environmentId/organizations/$organizationId'
                          params={{ ...scope, organizationId: membership.organizationId }}
                          className='font-medium text-link underline underline-offset-4'
                        >
                          {printableName(membership.name)}
                        </Link>
                      ),
                    },
                    {
                      header: 'Slug',
                      cell: (membership) => (
                        <code className='text-xs'>{printable(membership.slug)}</code>
                      ),
                    },
                    {
                      header: 'Role',
                      cell: (membership) => roleLabel(roles.data?.data, membership.role),
                    },
                    { header: 'Joined', cell: (membership) => formatDateTime(membership.joinedAt) },
                  ]}
                />
                <Pagination label='Organizations' meta={list.meta} onPage={onPage} />
              </>
            )
          }
        </QueryState>
      )}
    </Section>
  )
}

function OrganizationLink({ id, scope }: { id: string; scope: EnvironmentScope }) {
  const organization = useGetOrganization(id, { request: useEnvironmentRequest() })
  return (
    <Link
      to='/w/$workspaceId/p/$projectId/e/$environmentId/organizations/$organizationId'
      params={{ ...scope, organizationId: id }}
      className='text-link underline underline-offset-4'
    >
      {organization.data ? printableName(organization.data.name) : `Organization ${id}`}
    </Link>
  )
}

/**
 * The organizations that stop a user from being deleted: the ones the server's refusal
 * (`user.last_organization_manager`) names, each with a link, so that an operator can give
 * the organization another manager.
 *
 * @param props - `error`: what the deletion threw; `scope`: for the links.
 * @returns The list; nothing for any other failure.
 */
export function LastManagerOrganizations({
  error,
  scope,
}: {
  error: unknown
  scope: EnvironmentScope
}) {
  const ids = lastManagerOrganizationIds(error)
  if (ids.length === 0) {
    return null
  }
  return (
    <span className='mt-3 block text-foreground'>
      <span className='block font-medium'>Organizations that need another manager:</span>
      <ul className='mt-1 list-disc pl-5'>
        {ids.map((id) => (
          <li key={id}>
            <OrganizationLink id={id} scope={scope} />
          </li>
        ))}
      </ul>
    </span>
  )
}
