import Link from 'next/link'
import { OrganizationSwitcher } from '../organization-switcher'

/**
 * Switch the organization the session acts in. A page of its own, not part of the dashboard:
 * the list is fetched from the browser, which an environment without organizations refuses.
 */
export default function Organizations() {
  return (
    <section className='panel' aria-labelledby='organizations-title'>
      <h1 id='organizations-title'>Your organizations</h1>
      <OrganizationSwitcher />
      <p className='row'>
        <Link href='/billing' className='button-link'>
          Billing
        </Link>
        <Link href='/dashboard' className='button-link quiet'>
          Back to the dashboard
        </Link>
      </p>
    </section>
  )
}
