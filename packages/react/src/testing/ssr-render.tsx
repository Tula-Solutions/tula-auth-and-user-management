import { renderToString } from 'react-dom/server'
import {
  EmailLinkCallback,
  OAuthCallback,
  SignedIn,
  SignedOut,
  SignIn,
  SignUp,
  TulaLoading,
  TulaProvider,
  UserButton,
  UserProfile,
} from '../index'

// Run by `package.test.tsx` in a process of its own, with plain `bun run`: no test preload, so
// no DOM. It renders every component the way a server does and prints the HTML. A component
// that touched `window` or `document` while rendering would throw here.
if (typeof (globalThis as { window?: unknown }).window !== 'undefined') {
  throw new Error('ssr-render: expected no DOM globals')
}

const html = renderToString(
  <TulaProvider
    publishableKey='tula_pk_dev_unit00000000000000000000000000'
    baseUrl='https://auth.test'
    signInUrl='/sign-in'
    appearance={{ theme: { light: { primary: '#0f766e' } } }}
  >
    <TulaLoading>
      <p>loading</p>
    </TulaLoading>
    <SignedIn>
      <p>in</p>
    </SignedIn>
    <SignedOut>
      <p>out</p>
    </SignedOut>
    <SignIn
      signUpUrl='/sign-up'
      afterSignInUrl='/app'
      emailLinkUrl='/auth/link'
      oauthCallbackUrl='/oauth/callback'
    />
    <EmailLinkCallback />
    <OAuthCallback />
    <SignUp />
    <UserButton />
    <UserProfile />
  </TulaProvider>
)
process.stdout.write(html)
