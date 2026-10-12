import { type OAuthProvider, stepUpMethods, type UseSignInResult, usePasskeys } from '@tula/expo'
import { useState } from 'react'
import { REDIRECT_URL } from './tula'
import { Action, Note, Problem } from './ui'

// The two ways of signing in that leave the app's own screens: a passkey, through the
// platform's sheet, and a provider, through the system browser. Both are asked for with a
// button, and a sheet or a browser the user closed is said in plain words: nothing was done.

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

/** The providers this example has a button for, and what each button says. */
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

/** What a closed passkey sheet or a closed browser leaves behind: a sentence, not an error. */
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
