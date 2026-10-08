import { SignedIn, SignedOut } from '@tula/react'
import type { ReactNode } from 'react'

/**
 * A protected route: its children are rendered only for a signed-in visitor, and `fallback`
 * (a redirect to the sign-in page, usually) for everyone else. Neither is rendered while the
 * session is still loading. This hides a page; the data behind it is protected by the server
 * that verifies the session's access token.
 */
export function Protected(props: { children: ReactNode; fallback: ReactNode }) {
  return (
    <>
      <SignedIn>{props.children}</SignedIn>
      <SignedOut>{props.fallback}</SignedOut>
    </>
  )
}
