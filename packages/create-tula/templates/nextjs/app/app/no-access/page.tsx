import { auth } from '@tula-tech/nextjs/server'
import Link from 'next/link'
import { OrganizationSwitcher } from '../organization-switcher'

/** Where the proxy sends a signed-in visitor whose organization does not grant the page. */
export default async function NoAccess() {
  const { orgId, orgRole } = await auth()
  return (
    <section className='panel' aria-labelledby='no-access-title'>
      <h1 id='no-access-title'>You do not have access to that page</h1>
      <p data-testid='no-access-detail'>
        {orgId
          ? `Your role in this organization (${orgRole}) does not include it.`
          : 'No organization is active for this session.'}
      </p>
      <OrganizationSwitcher />
      <p className='row'>
        <Link href='/dashboard' className='button-link'>
          Back to the dashboard
        </Link>
      </p>
    </section>
  )
}
