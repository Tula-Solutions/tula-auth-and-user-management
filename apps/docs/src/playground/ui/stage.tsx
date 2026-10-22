import type { TulaClient } from '@tula-tech/core'
import {
  EmailLinkCallback,
  OAuthCallback,
  SignedIn,
  SignedOut,
  SignIn,
  SignUp,
  TulaProvider,
  UserProfile,
} from '@tula-tech/react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { type PlaygroundConfig, themeOverrides } from '../config'
import {
  approveOAuth,
  denyOAuth,
  type OAuthProfile,
  type OAuthRequest,
  PROVIDER_NAMES,
  type Sandbox,
  sandboxProfiles,
} from '../sandbox'
import { type SiteScheme, useAuthState } from './hooks'

/** The addresses inside the sandbox. They are never requested: the page only reads them. */
export const SANDBOX_PATHS = {
  signIn: '/sign-in',
  signUp: '/sign-up',
  account: '/account',
  oauthCallback: '/auth/callback',
  emailLink: '/auth/email-link',
}

/** What the stage shows besides the configured component. */
export type View =
  | { kind: 'screen' }
  | { kind: 'consent'; request: OAuthRequest }
  | { kind: 'oauth-callback' }
  | { kind: 'email-link'; where: 'here' | 'other'; url: string }

/** The label of the address bar for a view. */
export function addressOf(config: PlaygroundConfig, view: View): string {
  switch (view.kind) {
    case 'consent':
      return `${PROVIDER_NAMES[view.request.provider].toLowerCase()}.sandbox/authorize`
    case 'oauth-callback':
      return `acme.example${SANDBOX_PATHS.oauthCallback}`
    case 'email-link':
      return `acme.example${SANDBOX_PATHS.emailLink}`
    default:
      return `acme.example${SANDBOX_PATHS[config.screen === 'account' ? 'account' : config.screen === 'sign-up' ? 'signUp' : 'signIn']}`
  }
}

/** Props of {@link Consent}. */
interface ConsentProps {
  sandbox: Sandbox
  request: OAuthRequest
  appName: string
  onDone(): void
}

/**
 * The sandbox's own consent screen, standing in for a provider's page: generic, with the
 * provider's name as text and no imitation of its design. Approving returns to the app with a
 * ticket; declining returns with the error a provider sends.
 */
function Consent({ sandbox, request, appName, onDone }: ConsentProps) {
  const profiles = sandboxProfiles(request.provider)
  const [chosen, setChosen] = useState(0)
  const name = PROVIDER_NAMES[request.provider]
  const approve = useRef<HTMLButtonElement>(null)
  useEffect(() => approve.current?.focus(), [])
  const finish = (back: string) => {
    sandbox.page.set(back)
    onDone()
  }
  return (
    <section className='pg-consent' aria-labelledby='pg-consent-title'>
      <p className='pg-consent-brand'>
        <span className='pg-wordmark'>{name}</span>
        <span className='pg-consent-sandbox'>Sandbox consent screen</span>
      </p>
      <h3 id='pg-consent-title'>
        {appName} wants to sign you in with {name}
      </h3>
      <p className='pg-muted'>
        This page is part of the sandbox. It stands in for the page {name} would show and asks for
        nothing real. Choose who you are, then approve or cancel.
      </p>
      <fieldset className='pg-choice'>
        <legend>Sign in as</legend>
        {profiles.map((profile, at) => (
          <label key={profile.subject} className='pg-choice-row'>
            <input
              type='radio'
              name='pg-profile'
              checked={chosen === at}
              onChange={() => setChosen(at)}
            />
            <span>
              <strong>{profile.name}</strong>
              <small>
                {profile.email}
                {at === 0 ? ' · has an account already' : ` · new to ${appName}`}
              </small>
            </span>
          </label>
        ))}
      </fieldset>
      <div className='pg-row'>
        <button
          ref={approve}
          type='button'
          className='pg-btn pg-btn-primary'
          onClick={() =>
            finish(
              approveOAuth(
                sandbox.world,
                request.attemptId,
                profiles[chosen] ?? (profiles[0] as OAuthProfile)
              )
            )
          }
        >
          Approve
        </button>
        <button
          type='button'
          className='pg-btn'
          onClick={() => finish(denyOAuth(sandbox.world, request.attemptId))}
        >
          Cancel
        </button>
      </div>
    </section>
  )
}

/** Props of {@link Stage}. */
export interface StageProps {
  sandbox: Sandbox
  config: PlaygroundConfig
  scheme: SiteScheme
  view: View
  /** Changes whenever the component must be rebuilt (new settings, a reset). */
  epoch: number
  go(view: View): void
  /** The component asked to go to another screen of the sandbox app. */
  show(screen: PlaygroundConfig['screen']): void
}

function Gate({ sandbox }: { sandbox: Sandbox }) {
  const [busy, setBusy] = useState(false)
  return (
    <div className='pg-gate'>
      <h3>You are signed out</h3>
      <p className='pg-muted'>
        The account screen shows a signed-in user. Sign the demo account in to see it.
      </p>
      <button
        type='button'
        className='pg-btn pg-btn-primary'
        disabled={busy}
        onClick={() => {
          setBusy(true)
          sandbox.signInAsDemo().finally(() => setBusy(false))
        }}
      >
        {busy ? 'Signing in…' : 'Sign in as the demo account'}
      </button>
    </div>
  )
}

function Screen({ config, sandbox }: { config: PlaygroundConfig; sandbox: Sandbox }) {
  const state = useAuthState(sandbox.client)
  if (config.screen === 'sign-up') {
    return <SignUp headingLevel={3} />
  }
  if (config.screen === 'account') {
    return (
      <>
        <SignedIn>
          <UserProfile headingLevel={3} />
        </SignedIn>
        <SignedOut>{state.status === 'loading' ? null : <Gate sandbox={sandbox} />}</SignedOut>
      </>
    )
  }
  return <SignIn headingLevel={3} />
}

function Provider(props: {
  client: TulaClient
  config: PlaygroundConfig
  scheme: SiteScheme
  navigate(url: string): void
  children: ReactNode
}) {
  const { client, config, scheme, navigate, children } = props
  const origin = window.location.origin
  const at = (path: string) => `${origin}${path}`
  return (
    <TulaProvider
      client={client}
      navigate={navigate}
      signInUrl={at(SANDBOX_PATHS.signIn)}
      signUpUrl={at(SANDBOX_PATHS.signUp)}
      afterSignInUrl={at(SANDBOX_PATHS.account)}
      afterSignUpUrl={at(SANDBOX_PATHS.account)}
      afterSignOutUrl={at(SANDBOX_PATHS.signIn)}
      oauthCallbackUrl={at(SANDBOX_PATHS.oauthCallback)}
      emailLinkUrl={config.settings.methods.emailLink ? at(SANDBOX_PATHS.emailLink) : undefined}
      appearance={{ theme: themeOverrides(config), colorScheme: scheme }}
    >
      {children}
    </TulaProvider>
  )
}

/**
 * The frame: the configured component on the sandbox's client, and the pages a round trip
 * passes through (a provider's consent screen, the callback pages).
 *
 * @param props - The sandbox, the configuration, and where the frame is.
 * @returns The frame.
 */
export function Stage(props: StageProps) {
  const { sandbox, config, scheme, view, epoch, go, show } = props
  const navigate = (url: string) => {
    const path = new URL(url, window.location.origin).pathname
    if (path === SANDBOX_PATHS.signIn) {
      go({ kind: 'screen' })
      show('sign-in')
    } else if (path === SANDBOX_PATHS.signUp) {
      go({ kind: 'screen' })
      show('sign-up')
    } else if (path === SANDBOX_PATHS.account) {
      go({ kind: 'screen' })
      show('account')
    }
  }
  const provider = (children: ReactNode, key = `${epoch}-${view.kind}`) => (
    <Provider client={sandbox.client} config={config} scheme={scheme} navigate={navigate} key={key}>
      {children}
    </Provider>
  )

  if (view.kind === 'consent') {
    return (
      <Consent
        sandbox={sandbox}
        request={view.request}
        appName={config.settings.appName}
        onDone={() => go({ kind: 'oauth-callback' })}
      />
    )
  }
  if (view.kind === 'oauth-callback') {
    return provider(<OAuthCallback headingLevel={3} />)
  }
  // The component stays mounted while a link is opened: the sign-in that asked for it is
  // waiting in it, and finishes when the link has been proven, as the reader's own tab would.
  const screen = (
    <div hidden={view.kind !== 'screen'}>
      {provider(
        <Screen config={config} sandbox={sandbox} key={`${config.screen}-${epoch}`} />,
        `${epoch}-screen`
      )}
    </div>
  )
  if (view.kind === 'email-link' && view.where === 'here') {
    return (
      <>
        {screen}
        {provider(<EmailLinkCallback headingLevel={3} />)}
      </>
    )
  }
  if (view.kind === 'email-link') {
    return (
      <>
        {screen}
        <OtherBrowser sandbox={sandbox} url={view.url} config={config} scheme={scheme} />
      </>
    )
  }
  return screen
}

function OtherBrowser(props: {
  sandbox: Sandbox
  url: string
  config: PlaygroundConfig
  scheme: SiteScheme
}) {
  const [other] = useState(() => props.sandbox.another(props.url))
  return (
    <>
      <p className='pg-other' role='note'>
        A different browser: it has no sign-in waiting, so the link proves nothing here.
      </p>
      <Provider
        client={other.client}
        config={props.config}
        scheme={props.scheme}
        navigate={() => {}}
      >
        <EmailLinkCallback headingLevel={3} />
      </Provider>
    </>
  )
}
