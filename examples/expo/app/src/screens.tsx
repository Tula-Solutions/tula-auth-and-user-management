import { useSession, useSignIn, useSignUp, useUser } from '@tula/expo'
import { useState } from 'react'
import { Action, Field, Note, Problem, Screen } from './ui'

// The screens of the example: sign up, sign in with a password or an emailed code, and the
// signed-in screen. Each draws the screen the hook names and nothing else; the last branch
// of every `switch` is "not supported", for a step this version of the app has no screen for.

/** Shown instead of a guess when the server asks for something this app cannot do. */
function NotSupported(props: { onBack(): void }) {
  return (
    <Screen title='Not supported'>
      <Note>
        This version of the app cannot finish this step. Update the app, or sign in another way.
      </Note>
      <Action label='Start again' onPress={props.onBack} />
    </Screen>
  )
}

// #region sign-up
/** Sign up with an email address and a password, then prove the address with the emailed code. */
export function SignUpScreen(props: { onSignIn(): void }) {
  const signUp = useSignUp()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')

  switch (signUp.screen) {
    case null:
      return (
        <Screen title='Create an account'>
          <Field kind='email' label='Email' value={email} onChangeText={setEmail} />
          <Field kind='new-password' label='Password' value={password} onChangeText={setPassword} />
          <Problem error={signUp.error} />
          <Action
            label='Sign up'
            pending={signUp.isPending}
            onPress={() => void signUp.start({ email, password })}
          />
          <Action quiet label='I have an account' onPress={props.onSignIn} />
        </Screen>
      )
    case 'needs_email_verification':
      return (
        <Screen title='Check your email'>
          <Note>We sent a 6-digit code to {email}.</Note>
          <Field kind='code' label='Code' value={code} onChangeText={setCode} />
          <Problem error={signUp.error} />
          <Action
            label='Verify'
            pending={signUp.isPending}
            onPress={() => void signUp.verifyEmail({ code })}
          />
          <Action quiet label='Send a new code' onPress={() => void signUp.resendCode()} />
        </Screen>
      )
    case 'complete':
      // The client is signed in by now, and the app shows its signed-in screen instead.
      return null
    default:
      return <NotSupported onBack={signUp.reset} />
  }
}
// #endregion

// #region sign-in
/** Sign in with a password, or with a code emailed to the address where the environment offers one. */
export function SignInScreen(props: { onSignUp(): void }) {
  const signIn = useSignIn()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const step = signIn.step

  switch (signIn.screen) {
    case null:
      return (
        <Screen title='Sign in'>
          <Field kind='email' label='Email' value={email} onChangeText={setEmail} />
          <Problem error={signIn.error} />
          <Action
            label='Continue'
            pending={signIn.isPending}
            onPress={() => void signIn.start({ identifier: email })}
          />
          <Action quiet label='Create an account' onPress={props.onSignUp} />
        </Screen>
      )
    case 'needs_password':
      return (
        <Screen title='Your password'>
          <Field kind='password' label='Password' value={password} onChangeText={setPassword} />
          <Problem error={signIn.error} />
          <Action
            label='Sign in'
            pending={signIn.isPending}
            onPress={() => void signIn.submitPassword({ password })}
          />
          <Action quiet label='Start again' onPress={signIn.reset} />
        </Screen>
      )
    case 'needs_first_factor': {
      // The server says which ways this environment offers; the app shows the ones it has.
      const offered = step?.status === 'needs_first_factor' ? step.strategies : []
      const emailed = step?.status === 'needs_first_factor' && step.prepared !== undefined
      return (
        <Screen title='Sign in'>
          {offered.includes('password') && !emailed ? (
            <>
              <Field kind='password' label='Password' value={password} onChangeText={setPassword} />
              <Action
                label='Sign in'
                pending={signIn.isPending}
                onPress={() => void signIn.submitPassword({ password })}
              />
            </>
          ) : null}
          {offered.includes('email_code') && !emailed ? (
            // Nothing is emailed on arrival: the user asks.
            <Action
              quiet
              label='Email me a code instead'
              onPress={() => void signIn.prepareFirstFactor({ strategy: 'email_code' })}
            />
          ) : null}
          {emailed ? (
            <>
              <Note>If {email} can sign in, a 6-digit code is on its way.</Note>
              <Field kind='code' label='Code' value={code} onChangeText={setCode} />
              <Action
                label='Sign in'
                pending={signIn.isPending}
                onPress={() => void signIn.attemptFirstFactor({ strategy: 'email_code', code })}
              />
            </>
          ) : null}
          <Problem error={signIn.error} />
          <Action quiet label='Start again' onPress={signIn.reset} />
        </Screen>
      )
    }
    case 'needs_email_verification':
      return (
        <Screen title='Check your email'>
          <Field kind='code' label='Code' value={code} onChangeText={setCode} />
          <Problem error={signIn.error} />
          <Action
            label='Verify'
            pending={signIn.isPending}
            onPress={() => void signIn.verifyEmail({ code })}
          />
        </Screen>
      )
    case 'complete':
      return null
    default:
      // A second step, an expired password, or a step from a newer server: this small
      // example has no screen for them and says so.
      return <NotSupported onBack={signIn.reset} />
  }
}
// #endregion

// #region signed-in
/**
 * Who is signed in, the devices the account is signed in on, and the way out. Signing out
 * is the app's to do (`App.tsx`): this screen is gone the moment the app is signed out,
 * so it could not say that the server was not told.
 */
export function HomeScreen(props: { onSignOut(): void }) {
  const { user } = useUser()
  const { sessions, sessionId } = useSession()

  return (
    <Screen title='Signed in'>
      <Note>{user?.email ?? 'Loading your account…'}</Note>
      {sessions?.map((session) => (
        <Note key={session.id}>
          {session.id === sessionId ? 'This device' : 'Another device'}, signed in{' '}
          {new Date(session.createdAt).toLocaleString()}
        </Note>
      ))}
      <Action label='Sign out' onPress={props.onSignOut} />
    </Screen>
  )
}
// #endregion
