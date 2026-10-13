import {
  type OAuthProvider,
  stepUpMethods,
  type TulaError,
  type UseSignInResult,
  useIdTokenProviders,
  usePasskeys,
} from '@tula-tech/expo'
import { useEffect, useState } from 'react'
import { Linking } from 'react-native'
import { EMAIL_LINK_URL, REDIRECT_URL } from './tula'
import { Action, Note, Problem } from './ui'

// The ways of signing in that leave the app's own screens: a passkey, through the
// platform's sheet; Apple and Google, through their own sheets; any provider, through
// the system browser; and an emailed link, through the mail app. Each is asked for with a
// button, and a sheet or a browser the user closed is said in plain words: nothing was done.

// #region email-link
/** Whether the URL the app was started with has been looked at: once per run of the app. */
let startUrlRead = false

/**
 * Hand every URL the app is opened with to the sign-in. A URL that is not the client's
 * emailed-link URL with a link in it is none of the sign-in's business (`openEmailLink`
 * resolves `null` and changes nothing), so the app's other links are handled beside this.
 */
export function useEmailLinks(signIn: UseSignInResult) {
  const { openEmailLink } = signIn
  useEffect(() => {
    if (!startUrlRead) {
      startUrlRead = true
      // A link that started the app: this run of the app asked for none, so nothing is
      // sent and the screen says to ask again here. It is handed over to have that said.
      void Linking.getInitialURL().then((url) => (url ? openEmailLink(url) : null))
    }
    const opened = Linking.addEventListener('url', ({ url }) => void openEmailLink(url))
    return () => opened.remove()
  }, [openEmailLink])
}

/** Ask for the emailed link, where the environment offers one and the app has an app link. */
export function EmailLinkSignIn(props: { signIn: UseSignInResult; offered: readonly string[] }) {
  if (!EMAIL_LINK_URL || !props.offered.includes('email_link')) {
    return null
  }
  return (
    <Action
      quiet
      label='Email me a link instead'
      onPress={() => void props.signIn.prepareFirstFactor({ strategy: 'email_link' })}
    />
  )
}

/**
 * Finish a sign-in whose link was opened. Opening the link asks for this by itself; the
 * button is for when that got no answer (the link may have been taken all the same) and
 * for a link the screen then calls used. Where no link was taken it changes nothing.
 */
export function EmailLinkFinish(props: { signIn: UseSignInResult }) {
  const { step } = props.signIn
  if (step?.status !== 'needs_first_factor' || step.prepared?.strategy !== 'email_link') {
    return null
  }
  return (
    <Action
      quiet
      label='I opened the link: finish signing in'
      pending={props.signIn.isPending}
      onPress={() => void props.signIn.finishEmailLink()}
    />
  )
}

/**
 * What a link that was not used is, in the app's words: the client's own sentences for the
 * two codes speak of a browser and of a code. Nothing was sent for the first, and the link
 * still works where it was asked for.
 */
export function emailLinkProblem(error: TulaError | null): string | null {
  switch (error?.code) {
    case 'verification.different_browser':
      return 'That link was asked for somewhere else, or before this app was last closed. Ask for a new one here, or type the code from the email.'
    case 'verification.expired':
      return 'That link has been used, replaced by a newer email, or is too old. If you opened it a moment ago, finish signing in below; otherwise ask for a new one.'
    default:
      return null
  }
}
// #endregion

// #region passkey-sign-in
/**
 * Sign in with a passkey. No address is typed: the platform's sheet lists the passkeys the
 * device holds for the app's domain. The button is left out where the device, or this build
 * of the app, has no passkeys.
 */
export function PasskeySignIn(props: { signIn: UseSignInResult }) {
  const { supported } = usePasskeys()
  if (!supported) {
    return null
  }
  return (
    <Action
      quiet
      label='Sign in with a passkey'
      pending={props.signIn.isPending}
      onPress={() => void props.signIn.withPasskey()}
    />
  )
}
// #endregion

// #region native-provider-sign-in
/**
 * Sign in with Apple's or Google's own sheet: no browser, and no address typed. A button
 * is drawn only once its sheet is known to be there, so a build without the native module
 * (Expo Go), an Android phone for Apple, or a phone without Google Play services shows
 * none. For Apple the hook hands the sheet the hash of the server's nonce and passes the
 * name the sheet gives on; the app does neither.
 */
export function NativeProviderSignIn(props: { signIn: UseSignInResult }) {
  const { signIn } = props
  const { apple, google } = useIdTokenProviders()
  return (
    <>
      {apple ? (
        <Action
          quiet
          label='Sign in with Apple'
          pending={signIn.isPending}
          onPress={() => void signIn.withIdToken({ provider: 'apple' })}
        />
      ) : null}
      {google ? (
        <Action
          quiet
          label='Sign in with Google'
          pending={signIn.isPending}
          onPress={() => void signIn.withIdToken({ provider: 'google' })}
        />
      ) : null}
    </>
  )
}
// #endregion

/** The providers this example has a browser button for, and what each button says. */
const PROVIDERS: { provider: OAuthProvider; name: string }[] = [
  { provider: 'google', name: 'Google' },
  { provider: 'github', name: 'GitHub' },
]

// #region provider-sign-in
/**
 * Sign in with a provider the environment offers: the provider's page opens in the system
 * browser, and the app is opened again at `REDIRECT_URL` with a ticket that only this
 * client can exchange.
 */
export function ProviderSignIn(props: { signIn: UseSignInResult; offered: readonly string[] }) {
  const { signIn } = props
  // Only an exchange that got no answer can be sent again, and only after a round trip.
  const [asked, setAsked] = useState(false)
  const unanswered =
    asked && (signIn.error?.code === 'network.failed' || signIn.error?.code === 'network.timeout')

  return (
    <>
      {PROVIDERS.filter(({ provider }) => props.offered.includes(provider)).map(
        ({ provider, name }) => (
          <Action
            key={provider}
            quiet
            label={`Continue with ${name}`}
            pending={signIn.isPending}
            onPress={() => {
              setAsked(true)
              void signIn.withProvider({ provider, redirectUrl: REDIRECT_URL })
            }}
          />
        )
      )}
      {unanswered ? (
        // The ticket is kept for a minute, in memory: the browser need not open again.
        <Action quiet label='Try again' onPress={() => void signIn.retryProvider()} />
      ) : null}
    </>
  )
}
// #endregion

/** What a closed sheet or a closed browser leaves behind: a sentence, not an error. */
export function Dismissed(props: { signIn: UseSignInResult }) {
  return props.signIn.dismissed ? (
    <Note>Nothing was done. Try again when you are ready.</Note>
  ) : null
}

// #region passkeys
/**
 * Add a passkey to the signed-in account. The server asks for a recent authentication
 * first; where the account already has a passkey, that is proven with one.
 */
export function PasskeySection() {
  const passkeys = usePasskeys()
  const [added, setAdded] = useState<string | null>(null)

  if (!passkeys.supported) {
    return <Note>Passkeys are not available on this device or in this build of the app.</Note>
  }
  const proofs = stepUpMethods(passkeys.error)
  return (
    <>
      <Action
        label='Add a passkey'
        pending={passkeys.isPending}
        onPress={() => {
          setAdded(null)
          void passkeys.add().then((passkey) => setAdded(passkey ? passkey.name : null))
        }}
      />
      {added ? <Note>{`Saved as “${added}”.`}</Note> : null}
      {/* A dismissed sheet added nothing, and is not an error. */}
      {passkeys.dismissed ? <Note>No passkey was added.</Note> : null}
      <Problem error={passkeys.error} />
      {proofs.includes('passkey') ? (
        <Action
          quiet
          label='Confirm with a passkey you already have'
          onPress={() => void passkeys.stepUp()}
        />
      ) : null}
      {passkeys.error?.code === 'auth.step_up_required' && !proofs.includes('passkey') ? (
        // This small example has no screen for the other proofs (a password, a code).
        <Note>Sign out and sign in again, then add the passkey.</Note>
      ) : null}
    </>
  )
}
// #endregion
