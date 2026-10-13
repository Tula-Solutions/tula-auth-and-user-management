import type { ThemeOverrides, TulaScreens, TulaScreensState } from '@tula/expo/native-screens'
import { TulaAccountView, TulaAuthView } from '@tula/expo/native-screens'
import { useEffect, useState } from 'react'
import { REDIRECT_URL, setup } from './src/native-tula'
import { Action, Note, Screen } from './src/ui'

// The app on Tula's native screens. The sign-in, the sign-up, the second step and the
// account are drawn by the native SDKs; what is left for the app is which of the two
// screens is on, and where it goes when one of them is done.
//
// Nothing of this file was run: see `README.md`, "What was run, and what was not".

// #region native-theme
/**
 * The app's colours, in the tokens `@tula/react` takes. A constant: the screens check the
 * values each time the object changes, and a value they refuse is left out.
 */
const THEME: ThemeOverrides = {
  light: { primary: '#1f4fd8' },
  dark: { primary: '#8aa4ff' },
  radius: '8px',
}
// #endregion

/** The app: one native screen, chosen by who is signed in. */
export default function NativeApp() {
  if (!setup.tula) {
    return (
      <Screen title='Set up .env.local'>
        <Note>
          This app needs the address of a Tula API and a publishable key. Copy .env.example to
          .env.local in the app's folder, fill both in, and start the app again.
        </Note>
        {setup.unset.map((name) => (
          <Note key={name}>{`Not set: ${name}`}</Note>
        ))}
        {setup.refused ? <Note>{setup.refused}</Note> : null}
      </Screen>
    )
  }
  return <Screens tula={setup.tula} />
}

// #region native-app
/**
 * What the native client says of its session: a status and two ids, and never a token. It
 * is the native client's state, told to JavaScript; the app keeps no session of its own.
 */
function useScreensState(tula: TulaScreens): { state: TulaScreensState; failed: string | null } {
  const [state, setState] = useState(tula.getState())
  const [failed, setFailed] = useState<string | null>(null)
  useEffect(() => {
    const stop = tula.addListener(setState)
    setState(tula.getState())
    // The stored session is read once. A read that fails leaves the state `loading`.
    tula.load().catch((error: unknown) => {
      setFailed(error instanceof Error ? error.message : 'The session could not be read.')
    })
    return stop
  }, [tula])
  return { state, failed }
}

function Screens(props: { tula: TulaScreens }) {
  const { tula } = props
  const { state, failed } = useScreensState(tula)
  // Which screen is on is the app's: the sign-in screen stays until it says it is done
  // (backup codes of a setup inside a sign-in are shown before that), and the account
  // screen until its sign-out went through.
  const [screen, setScreen] = useState<'auth' | 'account' | null>(null)
  const [refused, setRefused] = useState<readonly string[]>([])

  if (screen === null && state.status === 'loading') {
    return (
      <Screen title='Tula example'>
        <Note>Loading…</Note>
        {failed ? <Note>{failed}</Note> : null}
        {failed ? <Action label='Sign in' onPress={() => setScreen('auth')} /> : null}
      </Screen>
    )
  }
  const shown = screen ?? (state.status === 'signed-in' ? 'account' : 'auth')
  return shown === 'account' ? (
    <TulaAccountView
      tula={tula}
      theme={THEME}
      style={{ flex: 1 }}
      onThemeRefused={setRefused}
      // Called for a sign-out the server was told of, never for one that failed.
      onSignedOut={() => setScreen('auth')}
    />
  ) : (
    <>
      {refused.length > 0 ? <Note>{`Theme values left out: ${refused.join(', ')}`}</Note> : null}
      <TulaAuthView
        tula={tula}
        theme={THEME}
        redirectUrl={REDIRECT_URL}
        style={{ flex: 1 }}
        onThemeRefused={setRefused}
        // Where the app goes after a sign-in is decided here and nowhere else.
        onSignedIn={() => setScreen('account')}
      />
    </>
  )
}
// #endregion
