import { TulaProvider } from '@tula/react'
import type { ReactNode } from 'react'

/**
 * The page emailed sign-in links lead to. In a deployed app this exact URL is listed in the
 * environment's `urls.allowedRedirectUrls`; a local API allows any loopback URL.
 */
export const EMAIL_LINK_PATH = '/auth/link'
/**
 * The page an OAuth sign-in returns to. List its full URL in the environment's allowed redirect
 * URLs (any loopback URL is allowed in the local tier).
 */
export const OAUTH_CALLBACK_PATH = '/oauth/callback'

const API_URL: string = import.meta.env.VITE_TULA_API_URL ?? 'http://localhost:3003'
/** The environment's publishable key. It is public: it names the environment and grants nothing. */
export const PUBLISHABLE_KEY: string = import.meta.env.VITE_TULA_PUBLISHABLE_KEY ?? ''

/**
 * The provider wrapper: everything under it can use the `@tula/react` components and hooks.
 * `navigate` is the app's own router, so that a sign-in moves between pages without a reload.
 */
export function AuthProvider(props: { navigate(url: string): void; children: ReactNode }) {
  return (
    <TulaProvider
      publishableKey={PUBLISHABLE_KEY}
      baseUrl={API_URL}
      navigate={props.navigate}
      signInUrl='/sign-in'
      signUpUrl='/sign-up'
      afterSignInUrl='/'
      emailLinkUrl={EMAIL_LINK_PATH}
      oauthCallbackUrl={OAUTH_CALLBACK_PATH}
      afterSignUpUrl='/'
      afterSignOutUrl='/sign-in'
    >
      {props.children}
    </TulaProvider>
  )
}
