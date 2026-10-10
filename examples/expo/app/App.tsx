import { TulaProvider, useAuth } from '@tula/expo'
import { useState } from 'react'
import { HomeScreen, SignInScreen, SignUpScreen } from './src/screens'
import { tula } from './src/tula'
import { Note, Screen } from './src/ui'

// #region app
/** The app: the provider around everything, and one screen chosen by who is signed in. */
export default function App() {
  return (
    <TulaProvider client={tula}>
      <Screens />
    </TulaProvider>
  )
}

function Screens() {
  const { status } = useAuth()
  const [wantsAccount, setWantsAccount] = useState(false)

  if (status === 'loading') {
    // The secure store is being read and, if it holds a session, the session refreshed.
    return (
      <Screen title='Tula example'>
        <Note>Loading…</Note>
      </Screen>
    )
  }
  if (status === 'signed-in') {
    return <HomeScreen />
  }
  return wantsAccount ? (
    <SignUpScreen onSignIn={() => setWantsAccount(false)} />
  ) : (
    <SignInScreen onSignUp={() => setWantsAccount(true)} />
  )
}
// #endregion
