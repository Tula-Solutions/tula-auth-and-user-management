import { type Identity, isStepUpRequired, type TulaError } from '@tula/core'
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react'
import type { Appearance } from '../appearance'
import { useTulaContext } from '../context'
import { toTulaError } from '../errors'
import { type OAuthCallbackStatus, useOAuthCallback } from '../hooks/use-oauth-callback'
import { useClientConfig } from '../hooks/use-password-checklist'
import { useStepUp } from '../hooks/use-step-up'
import { formatText } from '../localization'
import { go, safeUrl } from '../navigation'
import { SignedInNotice, useCompletion, useEnrolmentCompletion } from './flow-screens'
import { AppleMark, GitHubMark, GoogleMark } from './icons'
import { canEnrolTotp, drawableFactors, FactorEnrolmentScreen, SecondFactorScreen } from './mfa'
import { SwitchLink } from './sign-in'
import {
  Button,
  Card,
  FormError,
  Heading,
  type HeadingLevel,
  Root,
  Status,
  useScreenChanged,
  useUi,
} from './ui'

/** The providers this version can draw a button for, with their names and marks. */
const PROVIDERS = {
  google: { name: 'Google', mark: <GoogleMark /> },
  github: { name: 'GitHub', mark: <GitHubMark /> },
  apple: { name: 'Apple', mark: <AppleMark /> },
} as const satisfies Record<string, { name: string; mark: ReactNode }>

type KnownProvider = keyof typeof PROVIDERS

function isKnown(provider: string): provider is KnownProvider {
  return Object.hasOwn(PROVIDERS, provider)
}

/** A provider's name as shown: its own for a known one, the server's word otherwise. */
function providerName(provider: string): string {
  return isKnown(provider) ? PROVIDERS[provider].name : provider
}

/**
 * The providers to draw buttons for: the ones the environment has enabled **and** this version
 * knows, where the app named the page to return to and the tab can keep the round trip's
 * binding. Decided after mount: storage is not touched during render.
 */
function useOfferedProviders(callbackUrl: string | undefined): KnownProvider[] {
  const { client } = useTulaContext()
  const enabled = useClientConfig()?.signIn.oauth
  const [usable, setUsable] = useState(false)
  useEffect(() => {
    setUsable(client.signIn.canUseOAuth())
  }, [client])
  if (!usable || safeUrl(callbackUrl, 'http://localhost') === null) {
    return []
  }
  // A provider this version does not know is left out, never guessed.
  return (enabled ?? []).filter(isKnown)
}

/** The page's own URL for the callback. Only ever called from an event handler. */
function resolveCallbackUrl(url: string | undefined): string | null {
  return typeof window === 'undefined' ? null : safeUrl(url, window.location.href)
}

/**
 * "Continue with Google / GitHub / Apple": one button per provider the environment offers.
 *
 * Each is a neutral button with the provider's mark and its name as text, so the name is what
 * a screen reader announces. Choosing one asks the API for the provider's page and sends the
 * browser there; nothing else happens on this page. Draws nothing when no provider is offered,
 * when the app gave no `oauthCallbackUrl`, or where the tab cannot keep the round trip's
 * binding.
 *
 * **Brand rules an app must check itself before shipping.** These buttons follow each
 * provider's basic rules as far as a neutral, themeable button can (Google's "G" in its own
 * colours on a neutral surface; GitHub's and Apple's marks in the text colour; "Continue with
 * …" wording). They are not the providers' own button artwork: Google's and Apple's review
 * guidelines (and the App Store's rule that an app offering other social sign-ins also offers
 * Sign in with Apple) apply to your app, with your theme, and are yours to verify.
 *
 * @param props.callbackUrl - The page that renders `<OAuthCallback>`.
 * @param props.placement - Whether the divider is drawn `before` or `after` the buttons.
 * @returns The buttons, or nothing.
 */
export function OAuthButtons(props: {
  callbackUrl: string | undefined
  placement?: 'before' | 'after'
}) {
  const { el, t } = useUi()
  const { client } = useTulaContext()
  const providers = useOfferedProviders(props.callbackUrl)
  const [pending, setPending] = useState<KnownProvider | null>(null)
  const [error, setError] = useState<TulaError | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  if (providers.length === 0) {
    return null
  }
  const choose = async (provider: KnownProvider) => {
    const redirectUrl = resolveCallbackUrl(props.callbackUrl)
    if (redirectUrl === null || pending !== null) {
      return
    }
    setPending(provider)
    setError(null)
    try {
      // Navigates away on success: the button stays pending until the page is replaced.
      await client.signIn.withOAuth({ provider, redirectUrl })
    } catch (caught) {
      if (mounted.current) {
        setError(toTulaError(caught))
        setPending(null)
      }
    }
  }
  const divider = (
    <p {...el('divider')}>
      <span>{t.oauth.divider}</span>
    </p>
  )
  return (
    <>
      {props.placement === 'before' ? divider : null}
      <div {...el('oauthButtons')}>
        <FormError message={error?.message ?? null} />
        {providers.map((provider) => (
          <Button
            key={provider}
            kind='secondary'
            pending={pending === provider}
            disabled={pending !== null && pending !== provider}
            onClick={() => void choose(provider)}
          >
            <span {...el('oauthIcon')}>{PROVIDERS[provider].mark}</span>
            {formatText(t.oauth.continueWith, { provider: PROVIDERS[provider].name })}
          </Button>
        ))}
      </div>
      {props.placement === 'before' ? null : divider}
    </>
  )
}

/** Props of {@link OAuthCallback}. */
export interface OAuthCallbackProps {
  /** Where "Sign in" leads when the round trip did not sign the user in. Defaults to the provider's `signInUrl`. */
  signInUrl?: string
  /** Where to go once signed in. Defaults to the provider's `afterSignInUrl`. */
  afterSignInUrl?: string
  /** Where "Back to your account" leads after connecting an account. Defaults to the provider's `userProfileUrl`. */
  userProfileUrl?: string
  /** Called instead of navigating once signed in. */
  onComplete?: () => void
  /** Called once a provider account was connected to the signed-in user. */
  onLinked?: (identity: Identity) => void
  appearance?: Appearance
  headingLevel?: HeadingLevel
}

type Explained = Exclude<OAuthCallbackStatus, 'loading' | 'signed_in' | 'needs_step'>

function CallbackScreens(props: OAuthCallbackProps) {
  const { el, t } = useUi()
  const { navigation } = useTulaContext()
  const result = useOAuthCallback()
  const { status, signIn } = result
  const step = signIn.step
  const screen = `${status}:${step?.status ?? ''}`
  const focusTitle = useScreenChanged(screen)
  const { finish } = useCompletion(
    // Never "already signed in": this page decides from the round trip alone.
    { step, isPending: true },
    {
      onComplete: props.onComplete ? () => props.onComplete?.() : undefined,
      url: props.afterSignInUrl ?? navigation.afterSignInUrl,
    }
  )
  const confirmEnrolment = useEnrolmentCompletion(signIn, finish)
  const linked = useRef(false)
  const onLinked = useRef(props.onLinked)
  onLinked.current = props.onLinked

  useEffect(() => {
    // A sign-in the exchange itself completed.
    if (status === 'signed_in') {
      finish(step)
    }
    if (status === 'linked' && result.identity && !linked.current) {
      linked.current = true
      onLinked.current?.(result.identity)
    }
  }, [status, step, finish, result.identity])

  const signInUrl = props.signInUrl ?? navigation.signInUrl
  const restart = () => go(signInUrl, navigation.navigate)

  if (status === 'signed_in') {
    return <SignedInNotice key={screen} focusTitle={focusTitle} />
  }
  if (status === 'loading') {
    return (
      <Card title={t.oauth.loadingTitle}>
        <p {...el('waiting')} role='status'>
          <span {...el('spinner')} aria-hidden='true' />
          <span>{t.oauth.loadingMessage}</span>
        </p>
      </Card>
    )
  }
  if (status === 'needs_step') {
    // The same screens `<SignIn>` draws for these steps: the provider was only the first factor.
    if (step?.status === 'needs_second_factor') {
      const methods = drawableFactors(step.options)
      if (methods.length > 0) {
        return (
          <SecondFactorScreen
            key={screen}
            methods={methods}
            focusTitle
            isPending={signIn.isPending}
            error={signIn.error}
            submit={(proof) => signIn.submitSecondFactor(proof).then(finish)}
            submitPasskey={(signal) =>
              signIn.submitSecondFactorWithPasskey({ signal }).then(finish)
            }
            onRestart={restart}
          />
        )
      }
    }
    if (step?.status === 'needs_factor_enrolment' && canEnrolTotp(step.methods)) {
      return (
        <FactorEnrolmentScreen
          key={screen}
          focusTitle
          isPending={signIn.isPending}
          error={signIn.error}
          start={signIn.startTotpEnrolment}
          confirm={confirmEnrolment}
          onRestart={restart}
        />
      )
    }
  }

  const refused: { title: string; message: string | null } =
    result.code === 'oauth.account_exists'
      ? { title: t.oauth.accountExistsTitle, message: t.oauth.accountExistsMessage }
      : result.code === 'oauth.access_denied'
        ? { title: t.oauth.cancelledTitle, message: result.message }
        : { title: t.oauth.refusedTitle, message: result.message }
  const copy: Record<Explained, { title: string; message: string | null }> = {
    none: { title: t.oauth.noneTitle, message: t.oauth.noneMessage },
    different_browser: {
      title: t.oauth.differentBrowserTitle,
      message: t.oauth.differentBrowserMessage,
    },
    linked: {
      title: t.oauth.linkedTitle,
      message: formatText(t.oauth.linkedMessage, {
        provider: providerName(result.identity?.provider ?? ''),
      }),
    },
    refused,
    error: { title: t.oauth.errorTitle, message: null },
  }
  // `needs_step` with a step this version cannot draw ends here as well.
  const shown: Explained = status === 'needs_step' ? 'error' : status
  const { title, message } = copy[shown]
  return (
    // The outcome replaces the loading card: move focus to it so it is read out.
    <Card
      key={screen}
      title={title}
      focusTitle
      footer={
        shown === 'linked' ? (
          <SwitchLink
            prompt=''
            label={t.oauth.backToAccount}
            url={props.userProfileUrl ?? navigation.userProfileUrl}
          />
        ) : (
          <SwitchLink prompt='' label={t.oauth.signIn} url={signInUrl} />
        )
      }
    >
      {message ? (
        <p className='tula-text' data-tula-oauth={result.code ?? shown}>
          {message}
        </p>
      ) : null}
      <FormError
        message={
          shown === 'error'
            ? (result.error?.message ?? (status === 'needs_step' ? t.unsupported.message : null))
            : null
        }
      />
      {result.canRetry ? (
        // The request got no answer: the round trip is still open, so asking again can work.
        <Button onClick={result.retry}>{t.oauth.tryAgain}</Button>
      ) : null}
    </Card>
  )
}

/**
 * The page an OAuth sign-in returns to. Put it at the URL you give as `oauthCallbackUrl` and
 * list in the environment's allowed redirect URLs.
 *
 * It reads the single-use ticket the API put in the URL fragment (removing it from the address
 * before anything is sent), exchanges it together with what this tab kept when it started, and
 * says what happened: signed in (and goes on to `afterSignInUrl`); the second-factor or
 * enrolment screen for a user who still has one to pass (the provider is only the first
 * factor); an account that already exists and how to connect the provider to it; a sign-in
 * that was cancelled, expired or started in another browser; or, for a link started from
 * `<UserProfile>`, that the account is now connected.
 *
 * @param props - Destinations, callbacks and appearance.
 * @returns The landing page's card.
 *
 * @example
 * ```tsx
 * // at /oauth/callback
 * <OAuthCallback afterSignInUrl='/' signInUrl='/sign-in' userProfileUrl='/account' />
 * ```
 */
export function OAuthCallback(props: OAuthCallbackProps) {
  return (
    <Root appearance={props.appearance} headingLevel={props.headingLevel}>
      <CallbackScreens {...props} />
    </Root>
  )
}

/**
 * The "Connected accounts" section of `<UserProfile>`: the provider accounts the user can sign
 * in with, a way to connect one for each provider the environment offers, and a way to
 * disconnect one.
 *
 * Connecting sends the browser to the provider and back to `oauthCallbackUrl`. Disconnecting
 * the last way to sign in is refused by the server; its message says what to do first. Both
 * are sensitive changes and go through `useStepUp()`.
 *
 * @param props.callbackUrl - The page that renders `<OAuthCallback>`.
 * @returns The section, or nothing where the environment has no provider enabled.
 */
export function ConnectedAccountsSection(props: { callbackUrl: string | undefined }) {
  const { el, t } = useUi()
  const { client } = useTulaContext()
  const offered = useOfferedProviders(props.callbackUrl)
  // Where the environment has no provider enabled there is nothing to connect or to use, and
  // the section (with its request) is left out altogether.
  const available = (useClientConfig()?.signIn.oauth?.length ?? 0) > 0
  const withStepUp = useStepUp()
  const titleId = useId()
  const [identities, setIdentities] = useState<Identity[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<TulaError | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const mounted = useRef(true)

  const load = useCallback(async () => {
    try {
      const next = await client.user.identities.list()
      if (mounted.current) {
        setIdentities(next)
      }
    } catch (caught) {
      if (mounted.current) {
        setError(toTulaError(caught))
      }
    }
  }, [client])
  useEffect(() => {
    mounted.current = true
    if (available) {
      void load()
    }
    return () => {
      mounted.current = false
    }
  }, [load, available])

  /** Run one action; a step-up the user declined is their choice, not an error to show. */
  const run = async (name: string, work: () => Promise<void>) => {
    setBusy(name)
    setError(null)
    setMessage(null)
    try {
      await work()
    } catch (caught) {
      if (mounted.current && !isStepUpRequired(caught)) {
        setError(toTulaError(caught))
      }
    } finally {
      if (mounted.current) {
        setBusy(null)
      }
    }
  }
  const connect = (provider: KnownProvider) =>
    run(`connect:${provider}`, async () => {
      const redirectUrl = resolveCallbackUrl(props.callbackUrl)
      if (redirectUrl !== null) {
        await withStepUp(() => client.user.identities.link({ provider, redirectUrl }))
      }
    })
  const disconnect = (identity: Identity) =>
    run(identity.id, async () => {
      await withStepUp(() => client.user.identities.unlink({ identityId: identity.id }))
      await load()
      if (mounted.current) {
        setMessage(
          formatText(t.userProfile.disconnected, { provider: providerName(identity.provider) })
        )
      }
    })

  const connectable = offered.filter(
    (provider) => !identities?.some((identity) => identity.provider === provider)
  )
  if (
    !available ||
    (identities !== null && identities.length === 0 && connectable.length === 0 && !error)
  ) {
    return null
  }
  return (
    <section {...el('section')} aria-labelledby={titleId}>
      <Heading offset={1} {...el('sectionTitle')} id={titleId}>
        {t.userProfile.connectedTitle}
      </Heading>
      <FormError message={error?.message ?? null} />
      {identities === null ? (
        <p className='tula-text'>{error ? null : t.userProfile.connectedLoading}</p>
      ) : identities.length === 0 ? (
        <p className='tula-text'>{t.userProfile.connectedEmpty}</p>
      ) : (
        <ul {...el('identityList')}>
          {identities.map((identity) => (
            <li key={identity.id} {...el('identityItem')}>
              <span {...el('oauthIcon')}>
                {isKnown(identity.provider) ? PROVIDERS[identity.provider].mark : null}
              </span>
              <span className='tula-identity-name'>{providerName(identity.provider)}</span>
              <Button
                kind='danger'
                pending={busy === identity.id}
                disabled={busy !== null && busy !== identity.id}
                aria-label={formatText(t.userProfile.disconnectLabel, {
                  provider: providerName(identity.provider),
                })}
                onClick={() => void disconnect(identity)}
              >
                {t.userProfile.disconnect}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {connectable.length > 0 ? (
        <div {...el('oauthButtons')}>
          {connectable.map((provider) => (
            <Button
              key={provider}
              kind='secondary'
              pending={busy === `connect:${provider}`}
              disabled={busy !== null && busy !== `connect:${provider}`}
              onClick={() => void connect(provider)}
            >
              <span {...el('oauthIcon')}>{PROVIDERS[provider].mark}</span>
              {formatText(t.userProfile.connect, { provider: PROVIDERS[provider].name })}
            </Button>
          ))}
        </div>
      ) : null}
      <Status message={message} />
    </section>
  )
}
