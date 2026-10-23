import { auth } from '@tula-tech/nextjs/server'
import { notFound } from 'next/navigation'

/**
 * A page that needs a permission of the active organization. The proxy already refused a
 * visitor without `org:billing:read`; the page checks again, because it must not depend on
 * the proxy's matcher covering it.
 */
export default async function Billing() {
  const { isSignedIn, orgId, orgRole, has } = await auth()
  if (!isSignedIn || !has({ permission: 'org:billing:read' })) {
    notFound()
  }
  return (
    <section className='panel' aria-labelledby='billing-title'>
      <h1 id='billing-title'>Billing</h1>
      <p>The server checked your organization’s permission offline, from the session.</p>
      <dl className='facts'>
        <dt>Organization</dt>
        <dd data-testid='billing-org'>{orgId}</dd>
        <dt>Role</dt>
        <dd data-testid='billing-role'>{orgRole}</dd>
      </dl>
    </section>
  )
}
