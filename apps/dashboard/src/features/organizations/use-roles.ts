import { type OrganizationRole, useListOrganizationRoles } from '~/api/generated/api.gen'
import { useEnvironmentRequest } from '~/features/shell/environment-context'
import { roleKeyLabel } from './words'

/**
 * The roles of the current environment, built-in ones first.
 *
 * @returns The query of `GET /v1/admin/organization-roles`.
 */
export function useRoles() {
  return useListOrganizationRoles({ request: useEnvironmentRequest() })
}

/**
 * What a role is called in a table: its name, and its key when the role is gone (a role
 * cannot be deleted while a member holds it, so this is only a list read mid-change).
 *
 * @param roles - The environment's roles, if they have loaded.
 * @param key - A role key from a membership or an invitation.
 * @returns The role's name written out so that all of it is seen, else its key.
 */
export function roleLabel(roles: readonly OrganizationRole[] | undefined, key: string): string {
  const role = roles?.find((entry) => entry.key === key)
  return role ? roleKeyLabel(role.name) : roleKeyLabel(key)
}
