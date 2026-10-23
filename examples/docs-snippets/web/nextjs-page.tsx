import { auth } from '@tula-tech/nextjs/server'
import { notFound } from 'next/navigation'

// The server-side `has()` shown in docs/organizations.md. Copied by region
// (`bun run docs:generate`) and compiled by `bun run typecheck:scripts`. Nothing here runs.

// #region nextjs-has
// app/billing/page.tsx
export default async function Billing() {
  const { isSignedIn, orgId, orgRole, has } = await auth()
  // The proxy already refused a visitor without the permission; check again, because a page
  // must not depend on a matcher covering it.
  if (!isSignedIn || !has({ permission: 'org:billing:read' })) {
    notFound()
  }
  return (
    <p>
      {orgRole} of {orgId} may read billing.
    </p>
  )
}
// #endregion
