import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useCallback } from 'react'
import { SignInScreen } from '~/features/session/sign-in-screen'
import { safeRedirect } from '~/lib/redirect'

export const Route = createFileRoute('/sign-in')({
  // The destination is read from the address, so it is only ever a path of this app.
  validateSearch: (search: Record<string, unknown>): { redirect?: string } =>
    typeof search.redirect === 'string' ? { redirect: safeRedirect(search.redirect) } : {},
  component: SignInRoute,
})

function SignInRoute() {
  const { redirect } = Route.useSearch()
  const router = useRouter()
  const onSignedIn = useCallback(() => {
    const target = new URL(safeRedirect(redirect), 'http://dashboard.invalid')
    void router.navigate({
      to: target.pathname,
      search: router.options.parseSearch(target.search),
      replace: true,
    })
  }, [redirect, router])
  return <SignInScreen onSignedIn={onSignedIn} />
}
