import { SignIn } from '@tula/nextjs'
import { safeRedirectPath } from '@tula/nextjs/server'

/**
 * The sign-in page. The proxy sends signed-out visitors here with `redirect_url`: where they
 * were going. Anyone can write that parameter, so it goes through `safeRedirectPath`, which
 * accepts a path on this origin and nothing else.
 */
export default async function SignInPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { redirect_url: target } = await props.searchParams
  return <SignIn signUpUrl='/sign-up' afterSignInUrl={safeRedirectPath(target, '/dashboard')} />
}
