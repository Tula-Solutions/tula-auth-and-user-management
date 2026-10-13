import { TulaProvider, useAuth } from '@tula/expo'
import { useState } from 'react'
import { HomeScreen, SignInScreen, SignUpScreen } from './src/screens'
import { setup } from './src/tula'
import { Action, Note, Screen } from './src/ui'

// #region app
/** The app: the provider around everything, and one screen chosen by who is signed in. */
export default function App() {
  if (!setup.tula) {
    // No client: `.env.local` is missing a value, or holds one the client refuses.
    return <SetUpScreen unset={setup.unset} refused={setup.refused} />
  }
  return (
    <TulaProvider client={setup.tula}>
      <Screens />
    </TulaProvider>
  )
}

function Screens() {
  const { status, loadError, signOut } = useAuth()
  const [wantsAccount, setWantsAccount] = useState(false)
  // Kept here and not on the signed-in screen: the app is signed out, and that screen
  // gone, before a sign-out the server was not told of is known to have failed.
  const [signOutFailed, setSignOutFailed] = useState(false)
  const leave = () => {
    signOut().then(
      () => setSignOutFailed(false),
      () => setSignOutFailed(true)
    )
  }

  if (status === 'loading') {
    // The secure store is being read and, if it holds a session, the session refreshed.
    // The provider keeps trying whatever went wrong; `loadError` is the last try's reason,
    // for what waiting does not cure (a wrong key, an address the phone cannot reach).
    return (
      <Screen title='Tula example'>
        <Note>Loading…</Note>
        {loadError ? <Note>{`Still trying: ${loadError.message} (${loadError.code})`}</Note> : null}
      </Screen>
    )
  }
  if (status === 'signed-in') {
    return <HomeScreen onSignOut={leave} />
  }
  if (signOutFailed) {
    // A sign-out the server was not told of is not a sign-out: the session may live on.
    return (
      <Screen title='Not signed out everywhere'>
        <Note>
          This app has forgotten your session, but the server could not be told. Until it is, the
          session may still be active. Try again when you are online.
        </Note>
        {/* Signing out again sends the sign-out that did not arrive. */}
        <Action label='Try again' onPress={leave} />
        <Action quiet label='Continue' onPress={() => setSignOutFailed(false)} />
      </Screen>
    )
  }
  return wantsAccount ? (
    <SignUpScreen onSignIn={() => setWantsAccount(false)} />
  ) : (
    <SignInScreen onSignUp={() => setWantsAccount(true)} />
  )
}
// #endregion

/**
 * What a first run shows before `.env.local` is written: the names of what is missing, and
 * never a value (a wrong one may be a secret key pasted into the wrong place).
 */
function SetUpScreen(props: { unset: string[]; refused: string | null }) {
  return (
    <Screen title='Set up .env.local'>
      <Note>
        This app needs the address of a Tula API and a publishable key. Copy .env.example to
        .env.local in the app's folder, fill both in, and start the app again.
      </Note>
      {props.unset.map((name) => (
        <Note key={name}>{`Not set: ${name}`}</Note>
      ))}
      {props.refused ? <Note>{props.refused}</Note> : null}
    </Screen>
  )
}
