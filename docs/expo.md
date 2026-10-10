# Expo

`@tula/expo` puts Tula into an Expo app on iOS and Android. It is **headless**: a client, a
provider and hooks. It draws no screen; the screens are your app's, and the hooks tell them
which one the server is asking for. The reasoning is in
[ADR 0046](adr/0046-expo-sdk.md).

> **Not yet run on a phone.** The package is tested against the real API in process with a
> stand-in for the secure store, and the [example app](../examples/expo/README.md) was
> installed, type-checked and bundled for iOS and Android on Expo SDK 57. It has not been
> opened in Expo Go, a simulator or on a device.
> [What was not verified](plans/phase-2-unverified.md#step-213-tulaexpo-tula-36-adr-0046)
> has the list.

## What this version does

| | |
| --- | --- |
| Sign-up | An address and a password (or no password, where the environment allows it), then the emailed code. |
| Sign-in | A password, a code by email, a code by text message. A second step with an authenticator app, a backup code or a texted code. A new password where the old one has expired. |
| Password reset | A code by email, sent together with the new password. |
| Session | Kept across restarts in the device's secure store; refreshed when a token is asked for; the account's devices listed and signed out. |

**Not in this version**: sign-in with a provider (Google, Apple and the others), passkeys,
the emailed link, and device binding. A sign-in that offers only those is answered with
the screen `not_supported`, not with an error. **Expo web is not supported**: the package
refuses to create a client there; a web build uses [`@tula/react`](../packages/react/README.md).

## Install

`@tula/expo` works with Expo SDK 57 (`expo-secure-store` 57, React 19, React Native 0.86)
and needs no native module beyond `expo-secure-store`, which Expo Go includes.

```bash
bunx expo install expo-secure-store
bun add @tula/expo
```

Nothing is published yet ([releasing.md](releasing.md)); the
[example app](../examples/expo/README.md) installs the packed packages of a checkout.

## The client and the provider

Create one client, outside any component. Creating it sends nothing and reads nothing.

<!-- snippet: examples/expo/app/src/tula.ts#client -->
```ts
function createClient(publishableKey: string, baseUrl: string) {
  return createTulaExpoClient({
    publishableKey,
    // The address of the Tula API as the phone reaches it: never `localhost` on a device.
    baseUrl,
  })
}
```
<!-- /snippet -->

The client kind (`ios` or `android`) comes from the platform, and the refresh token goes
to the secure store: neither is an option, and passing `client`, `storage` or `deviceKey`
is refused. Both values above are public. The API's address is the one **the phone**
reaches: on a device `localhost` is the phone.

`<TulaProvider>` hands the client to the hooks and finds out who is signed in:

<!-- snippet: examples/expo/app/App.tsx#app -->
```tsx
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
```
<!-- /snippet -->

`useAuth().status` is `loading` until the secure store has been read and, if it held a
session, the session has been refreshed. While the API cannot be reached or the store
cannot be read (a locked phone), it stays `loading` and the provider asks again, 2 to 30
seconds apart: a failure there never signs anybody out.

The provider keeps asking whatever the reason was, also for one that waiting does not
cure. **`useAuth().loadError` is why the last try failed**: a `TulaError` while the
status is `loading` and a try has failed, `null` otherwise, and `null` again as soon as
a try succeeds or somebody signs in. **Its `code` and `message` are safe to show** (the
message is the client's own sentence for the code). **Its `cause` is not**: for
`storage.failed` that is the secure store's own error as the native module raised it, and
for a network failure the runtime's. Do not display or log `cause`. The case to draw it for is a wrong publishable key with a session in the store: the
API answers `auth.invalid_key`, which is about the request and not the session, so the
session is kept, the app stays on its loading screen, and without `loadError` nothing
says why. The same goes for a `baseUrl` the phone cannot reach (`network.failed`) and a
store that cannot be read (`storage.failed`). The example draws it under "Loading…".

## Screens from the server's step

Every flow hook has a `screen`: `null` before the flow starts, then the step the server
answered, or `not_supported`. Draw one screen per value and make the last branch of the
`switch` the "not supported" screen. Never guess an action for a step you have no screen
for: a newer server may ask for something this version of your app cannot do.

Sign-up:

<!-- snippet: examples/expo/app/src/screens.tsx#sign-up -->
```tsx
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
```
<!-- /snippet -->

Sign-in, with a password or an emailed code. The server says which ways the environment
offers (`step.strategies`), whatever the address: it does not say whether the address has
an account, and neither should your words ("if this address can sign in, a code is on its
way").

<!-- snippet: examples/expo/app/src/screens.tsx#sign-in -->
```tsx
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
```
<!-- /snippet -->

An action returns the next step, or `null` when it failed; the failure is the hook's
`error`, a `TulaError` whose `code` is the contract's (`auth.invalid_credentials`,
`verification.invalid_code`, …) and whose `message` can be shown. `reset()` discards the
attempt.

## The signed-in app

<!-- snippet: examples/expo/app/src/screens.tsx#signed-in -->
```tsx
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
```
<!-- /snippet -->

- `useAuth().getToken()` gives an access token for your own backend, refreshed first when
  it is about to run out. Ten calls at once share one refresh.
- **A failed sign-out is not a sign-out.** `signOut()` signs the app out and rejects when
  the server could not be told: the session may live on there. Say so and offer to try
  again; the next `signOut()` delivers it. **Keep that state above the switch between
  signed in and signed out** (the example keeps it in `App.tsx`, above): by the time
  `signOut()` rejects the app is signed out and its signed-in screen is gone, so a
  message kept on that screen is never seen.
- A call that needs a recent sign-in is refused with `auth.step_up_required`
  (`isStepUpRequired`, `stepUpMethods`); `useTula().session.stepUp(proof)` proves it, and
  the call is then repeated.

## Where the tokens are

| Token | Where | Never |
| --- | --- | --- |
| Access token (about a minute) | Memory. | Storage of any kind. |
| Refresh token | The secure store: the Keychain on iOS, Keystore-encrypted storage on Android. | AsyncStorage, a file, a log line, an error, a URL. |

- **The entry stays on the device.** It is not synced and not restored to another phone:
  after a restore or a new phone the user signs in again.
- **By default it can be read only while the phone is unlocked** (`when_unlocked`). An app
  that asks for a token from a background task while the phone is locked gets
  `storage.failed` and keeps its session. Such an app sets
  `secureStore: { keychainAccess: 'after_first_unlock' }` when it creates the client. No
  other class can be chosen. iOS only; Android encrypts with a Keystore key either way.
  **That a read on a locked phone rejects is from Apple's and Expo's documentation and has
  not been observed on a device.** If it resolves "nothing there" instead, the client that
  read it is signed out locally until the app starts again (the store is read once per
  client): it asks the server nothing and neither removes nor overwrites the entry, so the
  next start with the phone unlocked finds the session. A test holds that behaviour of the
  client; which of the two a phone does, nobody has looked at.
- **A store that fails is not "signed out".** A read, a write or a delete the secure store
  refuses is `storage.failed`, and the running app keeps its session.
- **A write the store refuses is tried three times** (again after 50 ms and after 200 ms;
  a read and a delete are asked once). The write that matters is the one after a refresh:
  the server has replaced the refresh token by then, and the store still holds the one it
  replaced. If all three fail:
  - the running app is still signed in and its tokens work. `session.refresh()`,
    `load()` and a sign-in throw `storage.failed`; **`session.getToken()` does not**: it
    was asked for a token and has one that works, so it returns it. An app that only ever
    calls `getToken()` is not told;
  - **the adapter offers the same token to the store twice more by itself**, 1 second
    after the last refusal and 5 seconds after that, with nobody waiting for it. A
    sign-out or a newer write in between calls those tries off, so they never put a token
    back that was removed or replaced. Two tries and no more: a store that refuses for
    longer than about six seconds is not waited for (the numbers are a guess, not a
    measurement of any phone);
  - failing those, every later refresh (about once a minute while the app asks for tokens)
    stores its own token, so the store catches up as soon as one write is taken;
  - **if the app is ended before that, the store holds a token the server has already
    replaced.** Started again inside the session profile's grace window (10 seconds by
    default) it is still signed in: the server hands the same next token out again.
    Started after it, the server takes the replaced token for a reused one
    (`session.reuse_detected`), ends that session, and the user
    signs in again. That is the server doing what it should with a token presented twice;
    the tries make the window small and nothing closes it.
- A value over 2,048 bytes is refused before the store is asked (some iOS releases refuse
  one). A refresh token is about 50 characters.
- Uninstalling the app on iOS does not always remove a Keychain entry. A token found after
  a reinstall is refreshed like any other: it works if its session is still alive on the
  server and is removed if not.

## Offline

- A refresh that gets no answer is repeated once, at once. If that fails too the call
  fails with `network.failed` or `network.timeout` and **the session is kept**: the next
  call tries again.
- Only the server's own word ends a session (`session.*`, `auth.user_banned`).
- A refresh whose answer was lost is safe to repeat inside the session profile's grace
  window (10 seconds by default): the server hands the same next token out again.

## Errors

| Code | What it means and what to do |
| --- | --- |
| `storage.failed` | The secure store could not be read or written (a locked phone with the default access class, a full or broken Keychain). The running app keeps its session and its tokens work; try again later. After a refresh it means the newest refresh token is in memory only: see [what follows if the app is ended then](#where-the-tokens-are). |
| `network.failed` | No answer from the API. The session is kept. Check `baseUrl`: not `localhost` on a device, and `https` in a release build on iOS. |
| `network.timeout` | No answer in time. The session is kept. |
| `auth.invalid_credentials` | Wrong password or code, or an unknown address; the answer is the same on purpose. |
| `flow.not_found` | The attempt expired (ten minutes). Start again. |
| `rate_limited` | Too many tries or messages. Wait for `Retry-After` (`error.retryAfterMs`). |

A `TypeError` when the client is created: the platform is not iOS or Android, an option
the package decides was passed, or the key is a secret key (never put one in an app).

## Testing your app

Your screens can be tested without a phone: `secureStoreStorage(store)` takes any object
with `expo-secure-store`'s three functions and two constants, and `@tula/core`'s
`createTulaClient` takes the result as its `storage`.

Reference: [`@tula/expo`](reference/expo.md), [`@tula/core`](reference/core.md). Method
pages: [password](methods/password.md), [emailed code](methods/email-code.md),
[sessions](methods/sessions.md).
