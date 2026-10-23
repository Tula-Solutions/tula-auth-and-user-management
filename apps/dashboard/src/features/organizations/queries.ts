import type { QueryClient } from '@tanstack/react-query'

/** The path every organization query's key begins with (the generated keys are paths). */
const ORGANIZATIONS_PATH = '/v1/admin/organizations'
const ROLES_PATH = '/v1/admin/organization-roles'

function startsWith(prefixes: readonly string[]) {
  return (query: { queryKey: readonly unknown[] }) =>
    typeof query.queryKey[0] === 'string' &&
    prefixes.some((prefix) => (query.queryKey[0] as string).startsWith(prefix))
}

/**
 * Ask again for everything the organization screens show: the list, an organization, its
 * members and its invitations, and a user's memberships.
 *
 * @param queryClient - The app's query client.
 * @returns A promise that settles once every such query on screen has been read again.
 */
export async function refreshOrganizations(queryClient: QueryClient): Promise<void> {
  await queryClient.invalidateQueries({
    predicate: (query) =>
      startsWith([ORGANIZATIONS_PATH])(query) ||
      (typeof query.queryKey[0] === 'string' &&
        /^\/v1\/admin\/users\/[^/]+\/organizations/.test(query.queryKey[0])),
  })
}

/**
 * Ask again for the roles of the environment.
 *
 * @param queryClient - The app's query client.
 * @returns A promise that settles once every role query on screen has been read again.
 */
export async function refreshRoles(queryClient: QueryClient): Promise<void> {
  await queryClient.invalidateQueries({ predicate: startsWith([ROLES_PATH]) })
}
