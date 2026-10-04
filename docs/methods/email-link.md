# Emailed link

A link in the sign-in email. Clicking it in the browser that asked signs that browser in; the
same email carries the 6-digit code for every other case. Off by default, and it needs the
[emailed code](email-code.md).
The reasoning, and why a link cannot work across devices, is in
[ADR 0024](../adr/0024-email-sign-in.md).

## Switch it on

| Where | How |
| --- | --- |
| Dashboard | **Sign-in methods**: "emailed link"; **Settings**: the allowed redirect URL. |
| `tula.config.ts` | `signIn.methods.emailLink` and `urls.allowedRedirectUrls`. |
| Admin API | `PUT /v1/admin/settings`. |

<!-- snippet: examples/tula-config/tula.config.ts#methods -->
```ts
signIn: {
  methods: {
    password: { enabled: true },
    emailCode: { enabled: true },
    emailLink: { enabled: true },
  },
},
```
<!-- /snippet -->

<!-- snippet: examples/tula-config/tula.config.ts#urls -->
```ts
urls: {
  allowedOrigins: ['https://app.northline.app'],
  allowedRedirectUrls: ['https://app.northline.app/auth/callback'],
},
```
<!-- /snippet -->

<!-- snippet: examples/docs-snippets/admin.ts#settings-email -->
```ts
const { data } = await admin.call('getEnvironmentSettings')
await admin.call('replaceEnvironmentSettings', {
  headers: { 'If-Match': ifMatch(data.revision) },
  body: {
    ...data.settings,
    signIn: {
      methods: {
        ...data.settings.signIn?.methods,
        password: { enabled: true },
        emailCode: { enabled: true },
        emailLink: { enabled: true },
      },
    },
    urls: {
      ...data.settings.urls,
      allowedRedirectUrls: ['https://app.example.com/auth/link'],
    },
  },
})
```
<!-- /snippet -->

The page your links lead to must be listed in `urls.allowedRedirectUrls` as the whole URL,
exactly: no prefix or wildcard matching, and a trailing slash or a query makes a different
URL. With `ENVIRONMENT=local`, `http://` URLs on `localhost`, `127.0.0.1` and `[::1]` are
allowed without being listed.

## What the user sees

- **Email me a link** beside the other ways to sign in, then "Check your email" with a field
  for the code from the same email.
- Clicking the link opens a new tab that says the sign-in was confirmed. The tab that asked
  finishes signing in by itself, and the new tab shares its session.
- Opened in **another browser or device**, the link signs nobody in and says to type the code
  where the sign-in was started.

## Security properties and limits

- **A link is honoured only in the browser that asked for it.** The asking browser is given a
  binding; the link's token is accepted only together with it. A user who clicks a link that
  someone else asked for proves nothing and signs nobody in.
- Accepting a link never creates a session. Only the tab holding the attempt's secret
  completes the sign-in.
- The token travels in the URL **fragment**, which a browser never sends to a server, and is
  removed from the address before any request.
- The link's page must be on the **same origin** as the page that asked: the binding is kept
  in that origin's `localStorage` (key `tula.link.<attempt id>`; not a token, and it
  authorizes nothing by itself).
- The limits of the emailed code apply: one email a minute per address, the shared lockout,
  ten-minute attempts.

## SDK calls

Tell the provider where the link's page is (`emailLinkUrl`), and render the callback
component there. The example app's layout and page:

<!-- snippet: examples/nextjs-app-router/app/layout.tsx -->
```tsx
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
```
<!-- /snippet -->

<!-- snippet: examples/nextjs-app-router/app/auth/link/page.tsx -->
```tsx
import { EmailLinkCallback } from '@tula/nextjs'

/**
 * The page an emailed sign-in link leads to (`emailLinkUrl` in the layout). The link's token
 * is in the URL fragment, which never reaches this server: the component reads it in the
 * browser and sends it to the API through the route handler. Whoever opens a link lands here,
 * signed in or not, so the proxy leaves this route public.
 *
 * In a deployed app this exact URL is listed in the environment's `urls.allowedRedirectUrls`;
 * a local API allows any loopback URL.
 */
export default function EmailLinkPage() {
  return <EmailLinkCallback />
}
```
<!-- /snippet -->

`@tula/core`:

<!-- snippet: examples/docs-snippets/core.ts#email-link -->
```ts
const flow = await tula.signIn.start({ identifier: email })
if (tula.signIn.canUseEmailLink()) {
  await flow.prepareFirstFactor({
    strategy: 'email_link',
    // An allowed redirect URL, exactly, on this page's own origin.
    redirectUrl: `${location.origin}/auth/link`,
  })
  const step = await flow.waitForEmailLink({ signal }) // resolves when the link was opened
  return step
}
```
<!-- /snippet -->

<!-- snippet: examples/docs-snippets/core.ts#email-link-landing -->
```ts
const { status } = await tula.signIn.handleEmailLink()
// 'signed_in' | 'verified' | 'different_browser' | 'expired' | 'none'
```
<!-- /snippet -->

Reference: [`@tula/core`](../reference/core.md), [`@tula/react`](../reference/react.md),
[`@tula/nextjs`](../reference/nextjs.md).

## Troubleshooting

| Code | What it means and what to do |
| --- | --- |
| `request.redirect_not_allowed` | The `redirectUrl` is not in `urls.allowedRedirectUrls`, character for character. |
| `link.cross_origin` | The link's page is on another origin than the page asking (a client code: nothing was sent). Put both on one origin. |
| `verification.different_browser` | The link was opened where it was not asked for. Nothing was used up: type the code in the original tab. |
| `verification.expired` | The link is old or already used. Ask for a new email. |
| `auth.method_disabled` | The link (or the code it depends on) is off for this environment. |
| `flow.not_found` | The waiting attempt expired (ten minutes). Start again. |
| `rate_limited` | The address was emailed less than a minute ago. |

A link that always answers "different browser" in the browser that asked means the storage
is unavailable (private mode, blocked storage) or the page is on another origin: the code is
the path that still works.
