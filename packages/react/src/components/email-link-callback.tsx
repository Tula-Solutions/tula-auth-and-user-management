import { useEffect, useRef } from 'react'
import type { Appearance } from '../appearance'
import { useTulaContext } from '../context'
import { type EmailLinkStatus, useEmailLinkCallback } from '../hooks/use-email-link-callback'
import { go } from '../navigation'
import { SignedInNotice } from './flow-screens'
import { SwitchLink } from './sign-in'
import { Card, FormError, type HeadingLevel, Root, useUi } from './ui'

/**
 * Props of {@link EmailLinkCallback}.
 *
 * @example
 * ```tsx
 * <EmailLinkCallback signInUrl='/sign-in' afterSignInUrl='/app' />
 * ```
 */
export interface EmailLinkCallbackProps {
  /** Where `<SignIn>` lives, for "Sign in" on a link that cannot be used. Overrides the provider's. */
  signInUrl?: string
  /** Where to go once this tab is signed in. Overrides the provider's `afterSignInUrl`. */
  afterSignInUrl?: string
  /** Called once this tab is signed in, instead of navigating to `afterSignInUrl`. */
  onComplete?: () => void
  /** Theme tokens, colour scheme and class names for this component. */
  appearance?: Appearance
  /** The level of the card's title. Defaults to 1; use 2 when the page has its own `<h1>`. */
  headingLevel?: HeadingLevel
}

/** The outcomes that are drawn as a title, a message and a way back to sign-in. */
type Explained = Exclude<EmailLinkStatus, 'loading' | 'signed_in'>

function Outcome(props: EmailLinkCallbackProps) {
  const { el, t } = useUi()
  const { navigation } = useTulaContext()
  const { status, error } = useEmailLinkCallback()
  const done = useRef(false)
  const latest = useRef({
    onComplete: props.onComplete,
    url: props.afterSignInUrl ?? navigation.afterSignInUrl,
    navigate: navigation.navigate,
  })
  latest.current = {
    onComplete: props.onComplete,
    url: props.afterSignInUrl ?? navigation.afterSignInUrl,
    navigate: navigation.navigate,
  }

  useEffect(() => {
    if (status === 'signed_in' && !done.current) {
      done.current = true
      const { onComplete, url, navigate } = latest.current
      if (onComplete) {
        onComplete()
      } else {
        go(url, navigate)
      }
    }
  }, [status])

  if (status === 'signed_in') {
    return <SignedInNotice focusTitle={false} />
  }
  if (status === 'loading') {
    return (
      <Card title={t.emailLink.loadingTitle}>
        <p {...el('waiting')} role='status'>
          <span {...el('spinner')} aria-hidden='true' />
          <span>{t.emailLink.loadingMessage}</span>
        </p>
      </Card>
    )
  }

  const copy: Record<Explained, { title: string; message: string | null }> = {
    verified: { title: t.emailLink.verifiedTitle, message: t.emailLink.verifiedMessage },
    different_browser: {
      title: t.emailLink.differentBrowserTitle,
      message: t.emailLink.differentBrowserMessage,
    },
    expired: { title: t.emailLink.expiredTitle, message: t.emailLink.expiredMessage },
    none: { title: t.emailLink.noneTitle, message: t.emailLink.noneMessage },
    error: { title: t.emailLink.errorTitle, message: null },
  }
  const { title, message } = copy[status]
  return (
    // The outcome replaces the loading card: move focus to it so it is read out.
    <Card
      key={status}
      title={title}
      focusTitle
      footer={
        <SwitchLink
          prompt=''
          label={t.emailLink.signIn}
          url={props.signInUrl ?? navigation.signInUrl}
        />
      }
    >
      {message ? (
        <p className='tula-text' data-tula-email-link={status}>
          {message}
        </p>
      ) : null}
      <FormError message={status === 'error' ? (error?.message ?? null) : null} />
    </Card>
  )
}

/**
 * The page an emailed sign-in link leads to. Render it at the URL you give `<SignIn>` as
 * `emailLinkUrl` (and list in the environment's allowed redirect URLs).
 *
 * It takes the link's token out of the address bar, checks it, and then says one of three
 * things: you are signed in (and goes to `afterSignInUrl`); continue in the tab where you
 * started; or, when the link was opened in a browser that did not ask for it, open it where
 * you started or use the code from the same email. A link opened elsewhere signs nobody in and
 * is not used up.
 *
 * @param props - URLs, a callback and appearance; all optional.
 * @returns The component.
 * @throws Error outside a `<TulaProvider>`.
 *
 * @example
 * ```tsx
 * // The route your sign-in links lead to, e.g. /auth/link
 * <EmailLinkCallback signInUrl='/sign-in' afterSignInUrl='/app' />
 * ```
 */
export function EmailLinkCallback(props: EmailLinkCallbackProps) {
  return (
    <Root appearance={props.appearance} headingLevel={props.headingLevel}>
      <Outcome {...props} />
    </Root>
  )
}
