import { SignedIn, SignedOut, TulaProvider, UserButton } from '@tula/nextjs'
import { auth } from '@tula/nextjs/server'
import type { Metadata } from 'next'
import Link from 'next/link'
import type { ReactNode } from 'react'
import '@tula/react/styles.css'
import './globals.css'

export const metadata: Metadata = {
  title: 'Northline',
  description: 'An example Next.js app whose authentication is @tula/nextjs.',
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  // What the server knows about the session goes to the provider, so the first paint (on the
  // server and after hydration) already shows the right header.
  const { sessionId } = await auth()
  return (
    <html lang='en'>
      <body>
        <TulaProvider
          publishableKey={process.env.NEXT_PUBLIC_TULA_PUBLISHABLE_KEY ?? ''}
          initialState={sessionId ? { sessionId } : null}
          signInUrl='/sign-in'
          signUpUrl='/sign-up'
          afterSignInUrl='/dashboard'
          afterSignUpUrl='/dashboard'
          afterSignOutUrl='/'
          // Pages of this app an emailed link and an OAuth provider lead back to.
          emailLinkUrl='/auth/link'
          oauthCallbackUrl='/oauth/callback'
          userProfileUrl='/profile'
        >
          <header className='top'>
            <Link href='/' className='brand'>
              <span className='brand-mark' aria-hidden='true'>
                N
              </span>
              Northline
            </Link>
            <nav className='top-actions' aria-label='Account'>
              <SignedIn>
                <Link href='/dashboard'>Dashboard</Link>
                <UserButton />
              </SignedIn>
              <SignedOut>
                <Link href='/sign-in'>Sign in</Link>
              </SignedOut>
            </nav>
          </header>
          <main className='page'>{children}</main>
        </TulaProvider>
      </body>
    </html>
  )
}
