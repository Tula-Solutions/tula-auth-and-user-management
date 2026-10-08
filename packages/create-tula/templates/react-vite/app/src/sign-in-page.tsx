import { SignedIn, SignedOut, SignIn } from '@tula/react'
import type { ReactNode } from 'react'

/**
 * The sign-in page: the `<SignIn>` component for a signed-out visitor, and `whenSignedIn`
 * (a redirect into the app, usually) for one who already has a session.
 */
export function SignInPage(props: { whenSignedIn: ReactNode }) {
  return (
    <>
      <SignedOut>
        <SignIn />
      </SignedOut>
      <SignedIn>{props.whenSignedIn}</SignedIn>
    </>
  )
}
