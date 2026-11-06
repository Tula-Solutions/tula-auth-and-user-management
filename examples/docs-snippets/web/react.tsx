import { useOrganization, useOrganizationList } from '@tula-tech/react'

// The organization hooks shown in docs/organizations.md. Copied by region
// (`bun run docs:generate`) and compiled by `bun run typecheck:scripts`. Nothing here runs.

// #region react-switcher
/** Lists the user's organizations and switches the one the session acts in. */
export function OrganizationSwitcher() {
  const { organizations, activeOrganizationId, setActive, isLoaded, error } = useOrganizationList()
  if (error) {
    return <p role='alert'>Your organizations could not be loaded.</p>
  }
  if (!isLoaded) {
    return <p role='status'>Loading…</p>
  }
  return (
    <ul>
      {organizations?.map((organization) => (
        <li key={organization.id}>
          <button
            type='button'
            aria-pressed={organization.id === activeOrganizationId}
            onClick={() => void setActive(organization.id)}
          >
            {organization.name}
          </button>
        </li>
      ))}
      <li>
        <button type='button' onClick={() => void setActive(null)}>
          Personal account
        </button>
      </li>
    </ul>
  )
}
// #endregion

// #region react-has
/** A link only members who may read billing see. `has()` decides what to show, not what to allow. */
export function BillingLink() {
  const { organization, has } = useOrganization()
  if (!organization || !has({ permission: 'org:billing:read' })) {
    return null
  }
  return <a href='/billing'>Billing for {organization.name}</a>
}
// #endregion
