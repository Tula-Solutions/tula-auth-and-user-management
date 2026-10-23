import { createAdminClient, ifMatch } from '@tula-tech/admin'
import { createTulaClient, isTulaError } from '@tula-tech/core'

// The organization calls shown in docs/organizations.md and docs/roles-and-permissions.md,
// through `@tula-tech/admin` (the operator's side, with the secret key) and `@tula-tech/core`
// (the signed-in user's side). Copied by region (`bun run docs:generate`) and compiled by
// `bun run typecheck:scripts`. Nothing here runs.

/** The environment's secret key (`tula_sk_…`), read from the server's own configuration. */
declare const secretKey: string

const admin = createAdminClient({ baseUrl: 'https://auth.example.com', secretKey })
const tula = createTulaClient({
  publishableKey: 'tula_pk_dev_…',
  baseUrl: 'https://auth.example.com',
})

/** Switch organizations on in the environment's settings, under the revision that was read. */
export async function switchOnOrganizations() {
  // #region settings-organizations
  const { data } = await admin.call('getEnvironmentSettings')
  await admin.call('replaceEnvironmentSettings', {
    headers: { 'If-Match': ifMatch(data.revision) },
    body: {
      ...data.settings,
      organizations: {
        ...data.settings.organizations,
        enabled: true,
        // Let a signed-in user create organizations, up to five each.
        allowUserCreated: true,
        maxCreatedPerUser: 5,
      },
    },
  })
  // #endregion
}

/** Create an organization and its first member from the server, with the secret key. */
export async function createFromTheServer(userId: string) {
  // #region admin-create-organization
  const { data: organization } = await admin.call('createOrganization', {
    body: { name: 'Acme', slug: 'acme' },
  })
  // The first member holds a role of your choosing: `admin` is built in.
  await admin.call('addOrganizationMember', {
    params: { id: organization.id },
    body: { userId, role: 'admin' },
  })
  // #endregion
  return organization
}

/** Define a custom role, give it one more permission, and read the roles back. */
export async function defineRole() {
  // #region admin-define-role
  const { data: role } = await admin.call('createOrganizationRole', {
    body: {
      key: 'billing_manager',
      name: 'Billing manager',
      permissions: ['org:billing:read', 'org:billing:write'],
    },
  })
  // A change needs the version that was read; a stale one is refused (412).
  await admin.call('updateOrganizationRole', {
    params: { key: role.key },
    headers: { 'If-Match': ifMatch(role.version) },
    body: { permissions: [...role.permissions, 'org:invoices:read'] },
  })
  const { data: roles } = await admin.call('listOrganizationRoles')
  // roles.data holds the built-in `admin` and `member` and every custom role.
  // #endregion
  return roles
}

/** The signed-in user creates an organization, makes it the one the session acts in, and leaves it. */
export async function createAndSwitch() {
  // #region core-organizations
  try {
    const organization = await tula.organizations.create({ name: 'Acme', slug: 'acme' })
    // The access token is replaced with one that carries the organization's claims.
    await tula.organizations.setActive(organization.id)
    // tula.state.organizationId === organization.id

    const { data, meta, activeOrganizationId } = await tula.organizations.list({ page: 1 })
    // data[n] has `role` and `permissions`; activeOrganizationId is the one just chosen.
    // `meta.totalPages` says whether to ask for `{ page: 2 }`.

    // `null` is the personal account.
    await tula.organizations.setActive(null)
    return { data, meta, activeOrganizationId }
  } catch (error) {
    if (isTulaError(error) && error.code === 'organization.slug_taken') {
      // Ask for another slug.
    }
    throw error
  }
  // #endregion
}
