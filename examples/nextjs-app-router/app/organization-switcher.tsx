'use client'

import { useOrganization, useOrganizationList } from '@tula-tech/nextjs'

/**
 * Lists the user's organizations and switches the one the session acts in. `has()` here only
 * decides what to show: the server checks the same permission before it renders /billing.
 */
export function OrganizationSwitcher() {
  const { organizations, activeOrganizationId, setActive, isLoaded, error } = useOrganizationList()
  const { role, has } = useOrganization()
  if (error) {
    return <p role='alert'>Your organizations could not be loaded.</p>
  }
  if (!isLoaded) {
    return <p role='status'>Loading organizations…</p>
  }
  return (
    <section aria-labelledby='orgs-title'>
      <h2 id='orgs-title'>Organizations</h2>
      <p data-testid='client-role'>
        {activeOrganizationId ? `Your role here: ${role ?? 'unknown'}` : 'Personal account'}
      </p>
      <p data-testid='client-can-billing'>
        {has({ permission: 'org:billing:read' }) ? 'You can read billing.' : 'No billing access.'}
      </p>
      <ul className='row'>
        {organizations?.map((org) => (
          <li key={org.id}>
            <button
              type='button'
              className='button-link quiet'
              aria-pressed={org.id === activeOrganizationId}
              onClick={() => void setActive(org.id)}
            >
              Switch to {org.name}
            </button>
          </li>
        ))}
        <li>
          <button
            type='button'
            className='button-link quiet'
            aria-pressed={activeOrganizationId === null}
            onClick={() => void setActive(null)}
          >
            Personal account
          </button>
        </li>
      </ul>
    </section>
  )
}
