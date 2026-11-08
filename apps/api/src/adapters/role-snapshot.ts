import { permissionsHash } from '@tula-tech/contract'
import type { OrganizationRoleRecord } from '~/ports/organization-store'

/**
 * The snapshot a role's write stores for the version the role now has (ADR 0068): its
 * permissions sorted by code point and deduplicated, and their hash. Shared by both adapters so
 * that the list stored is the list hashed.
 *
 * @param role - The role as written.
 * @returns The snapshot's fields, without the tenant columns.
 */
export async function roleSnapshot(role: OrganizationRoleRecord) {
  const permissions = [...new Set(role.permissions)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return {
    roleId: role.id,
    roleKey: role.key,
    version: role.version,
    permissions,
    permissionsHash: await permissionsHash(permissions),
  }
}
