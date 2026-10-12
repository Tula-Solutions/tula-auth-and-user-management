# Expo

`@tula/expo` puts Tula into an Expo app on iOS and Android. It is **headless**: a client, a
provider and hooks. It draws no screen; the screens are your app's, and the hooks tell them
which one the server is asking for. The reasoning is in
[ADR 0046](adr/0046-expo-sdk.md), for passkeys and providers
[ADR 0048](adr/0048-expo-passkeys-and-providers.md), and for Apple's and Google's own
sheets, the device key and the config plugin
[ADR 0051](adr/0051-expo-native-providers-and-device-keys.md).

> **Not yet run on a phone.** The package is tested against the real API in process with a
> stand-in for the secure store, and the [example app](../examples/expo/README.md) was
> installed, type-checked and bundled for iOS and Android on Expo SDK 57, with the passkey
> and the browser module in it, before Apple's and Google's sheets, the device key and
> the config plugin were added: **with those it was not installed, bundled or built**. Its
> iOS build did not complete
> ([what it needs](../examples/expo/README.md#building-for-ios)), so it has not been
> opened in Expo Go, a simulator or on a device. **No passkey sheet, no system browser and
> no provider's sheet has been opened by this package, no key was made in a phone's
> secure hardware, and the config plugin was never run by Expo**: all of it is tested with
> stand-ins.
> What was not verified:
> [the package](plans/phase-2-unverified.md#step-213-tulaexpo-tula-36-adr-0046),
> [passkeys and providers](plans/phase-2-unverified.md#step-213-passkeys-and-provider-sign-in-in-tulaexpo-tula-48-adr-0048),
> [Apple's and Google's sheets, the device key and the plugin](plans/phase-2-unverified.md#step-213-native-google-and-apple-and-a-device-key-in-tulaexpo-tula-55-adr-0051).

## What this version does

| | |
| --- | --- |
| Sign-up | An address and a password (or no password, where the environment allows it), then the emailed code. |
| Sign-in | A password, a code by email, a code by text message. A [passkey](#passkeys), through the platform's sheet. A [provider](#sign-in-with-a-provider) (Google, GitHub and the others), through the system browser. [Apple's and Google's own sheets](#apples-and-googles-own-sheets). A second step with an authenticator app, a backup code, a texted code or a passkey. A new password where the old one has expired. |
| Passkeys | Added to the signed-in account, and used to prove a recent authentication. |
| Password reset | A code by email, sent together with the new password. |
| Session | Kept across restarts in the device's secure store; refreshed when a token is asked for; [bound to a key the device keeps](#a-session-bound-to-a-device-key), where the app gives the client a key store; the account's devices listed and signed out. |
| Native configuration | [A config plugin](#the-config-plugin): Associated Domains, the Sign in with Apple entitlement and Google's client ids, said once. |

**Not in this version**: [the emailed link](#the-emailed-link). A
sign-in that offers only a way the client cannot do (a link; a passkey for a client with
no passkey sheet; a provider for a client with neither a browser nor that provider's
sheet) is answered with the screen `not_supported`, not with an error.

**Expo web is not supported**: the package
refuses to create a client there; a web build uses [`@tula/react`](../packages/react/README.md).

## Install

`@tula/expo` works with Expo SDK 57 (`expo-secure-store` 57, React 19, React Native 0.86)
and needs no native module beyond `expo-secure-store`, which Expo Go includes.

```bash
bunx expo install expo-secure-store
bun add @tula/expo
```

Five more are optional, each behind an entry point of its own, so that an app installs
only what it offers:

| For | Install | Import | Expo Go |
| --- | --- | --- | --- |
| Sign-in with a provider | `bunx expo install expo-web-browser` | `systemBrowser` from `@tula/expo/browser` | Included. |
| Passkeys | `bun add react-native-passkey` (3.6 or later) | `passkeySheet` from `@tula/expo/passkeys` | **Not included**: a development build. |
| Sign in with Apple's sheet | `bunx expo install expo-apple-authentication` | `appleSheet` from `@tula/expo/apple` | Included (iOS). |
| Google's sheet | `bun add react-native-nitro-google-signin react-native-nitro-modules` (2.3 or later) | `googleSheet` from `@tula/expo/google` | **Not included, and the import itself throws there**: load this entry point in a development build only. |
| A session bound to a device key | `bun add @pagopa/io-react-native-crypto` (1.2.5 or later) | `hardwareDeviceKeys` from `@tula/expo/device-key` | **Not included**: there the sessions are not bound. |

Each can be replaced by an object of your own with the same two or three functions
(`BrowserSession`, `PasskeySheet`, `IdTokenSheet`, `DeviceKeyStore`): the package calls
no native module by itself. Why these modules, and what was read of each, is in
[ADR 0051](adr/0051-expo-native-providers-and-device-keys.md); none of the last three
was ever installed or called for this package.

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
    // The platform's passkey sheet (`react-native-passkey`) and the system browser's
    // authentication session (`expo-web-browser`). Both are optional: leave one out, with
    // its import and its package, and the app offers no passkey, or no provider.
    passkeys: passkeySheet,
    browser: systemBrowser,
    // Sign in with Apple's own sheet (`expo-apple-authentication`) and Google's
    // (`react-native-nitro-google-signin`). Optional in the same way; Google's is given
    // only where the app was configured with a client id.
    apple: appleSheet,
    ...(googleWebClientId && {
      google: googleSheet({
        webClientId: googleWebClientId,
        ...(googleIosClientId && { iosClientId: googleIosClientId }),
      }),
    }),
    // The device's key store (`@pagopa/io-react-native-crypto`): a session is bound to a
    // key made there, and every refresh proves it. Leave it out where the environment's
    // session profile has `deviceBinding: 'none'`.
    deviceKeys: hardwareDeviceKeys,
  })
}
```
<!-- /snippet -->

`passkeys`, `browser`, `apple`, `google` and `deviceKeys` are the optional options; a
client made without one offers no passkey, no provider, not that provider's sheet, or
binds no session, and refuses the call before any request.

The client kind (`ios` or `android`) comes from the platform, and the refresh token goes
to the secure store: neither is an option, and passing `client`, `storage` or `deviceKey`
is refused (an app hands over a key store, `deviceKeys`, never a key). Both values above are public. The API's address is the one **the phone**
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
message is the client's sentence for the code, or the server's own message for a code the
client does not know). **Its `cause` is not**: for
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
          {/* A passkey needs no address: it is offered before one is typed. */}
          <PasskeySignIn signIn={signIn} />
          {/* Neither does Apple's or Google's own sheet. */}
          <NativeProviderSignIn signIn={signIn} />
          <Dismissed signIn={signIn} />
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
          {offered.includes('passkey') && !emailed ? <PasskeySignIn signIn={signIn} /> : null}
          {emailed ? null : <ProviderSignIn signIn={signIn} offered={offered} />}
          <Dismissed signIn={signIn} />
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

## Passkeys

A passkey is asked for through the platform's own sheet (Apple's authorization sheet,
Android's Credential Manager). The package hands the sheet the options exactly as the
server issued them and sends back what the sheet returned; nothing of a ceremony is kept.

**What the app and the environment need first.** A passkey belongs to a domain, and the
platform lets an app use it only when that domain says the app is its own:

1. `passkeys.rpId` in the environment's settings is that domain, and the passkey sign-in
   method is on ([passkeys](methods/passkeys.md)).
2. The app is registered under [native apps](native-apps.md): the team and bundle ID on
   iOS, the package name and the signing certificate's SHA-256 fingerprints on Android.
   The server builds the two association files from that, and the domain has to serve
   them over `https`.
3. On iOS, `https://<rpId>` is also among the environment's allowed origins, and the app
   has `webcredentials:<rpId>` under Associated Domains (`ios.associatedDomains` in the
   Expo config).
4. The app is a development or release build with `react-native-passkey` in it.

Without the registration the server refuses the request before any ceremony
(`request.origin_not_allowed`). **A local API cannot do this**: there is no passkey for
`localhost` or an address on the local network, so trying it on a phone takes a public
`https` address (a tunnel). Nobody has done that with this package yet.

<!-- snippet: examples/expo/app/src/ways.tsx#passkey-sign-in -->
```tsx
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
```
<!-- /snippet -->

- `useSignIn().withPasskey()` signs in with no address typed. A passkey as the **second**
  step is `submitSecondFactorWithPasskey()`, on `useSignIn` and `useResetPassword`.
- `usePasskeys()` is for the signed-in user: `add()` makes a passkey and saves it,
  `stepUp()` proves a recent authentication with one. Listing, renaming and removing need
  no sheet: `useTula().user.passkeys`.
- **`supported`** (and the flow hooks' `screen`) says whether a passkey can be asked for:
  the client has a sheet and the device has passkeys (iOS 15, Android 9). Leave the
  controls out where it is `false`; a call made anyway is `passkey.unsupported`, before
  any request.
- **A dismissed sheet is not an error and not a sign-in.** The hook's `dismissed` is
  `true`, its `error` stays `null`, nothing was sent, and the action works again. The
  same goes for a sheet the system took away and one nobody answered in time. On the
  client itself it is the error code `passkey.cancelled`.
- **One request at a time.** A platform shows one passkey sheet, and a request made while
  one is out is refused, never queued and never joined to the first (each request answers
  its own challenge). In the hooks: a second tap on the same hook while its action is
  pending does nothing, and an action while a sheet another part of the app opened is
  still out fails with **`flow.busy`**, before any request. That is an `error`, not
  `dismissed`: nobody closed anything. **The client called directly says
  `passkey.cancelled` for the same case** (`client.signIn.withPasskey()` and the others):
  `@tula/core` has one code for every refusal of that kind, so a direct caller cannot
  tell "busy" from "dismissed" and should use the hooks or keep its own flag.
- **A sheet that never answers gives its place up after five minutes**, the lifetime of
  the challenge it was opened for. A native module can leave a request unsettled (an app
  sent to the background with the sheet up). After five minutes the action ends as a
  ceremony nobody answered (`dismissed`, like a timeout), passkeys work again, and
  anything the abandoned sheet answers later is dropped and never sent. Until then
  passkey actions are `flow.busy`.
- A device that already holds a passkey of the account is `passkey.already_on_device`;
  anything else the sheet fails with is `passkey.failed`. The module's own message is
  never shown or kept: it can quote a domain or a native error.

<!-- snippet: examples/expo/app/src/ways.tsx#passkeys -->
```tsx
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
```
<!-- /snippet -->

What is **not** offered: passkeys in a field's autofill (the platforms' APIs for it are
not wrapped), and enrolling a passkey inside a sign-in.

## Sign-in with a provider

The provider's page opens in the system browser's authentication session
(`ASWebAuthenticationSession` on iOS, a Custom Tab on Android), never in a web view of the
app, and the browser hands the app the URL it was sent back to.

**The redirect URL** is where that round trip ends. It is listed, character for character,
in the environment's allowed redirect URLs
([ADR 0044](adr/0044-app-link-and-custom-scheme-redirects.md)), and is one of:

| Kind | Example | For |
| --- | --- | --- |
| The app's custom scheme | `com.example.app:/oauth/callback` | A provider that binds its code with PKCE: Google, GitHub, Microsoft, Discord, X. Refused for Apple, LinkedIn and Facebook. |
| An `https` app link | `https://app.example.com/oauth/callback` | Every provider. The path is one of the app's `appLinkPaths` ([native apps](native-apps.md)), and the domain is associated with the app (`applinks:` on iOS, an intent filter with `autoVerify` on Android). |

<!-- snippet: examples/expo/app/src/tula.ts#redirect-url -->
```ts
/**
 * Where a provider sign-in comes back to: the app's own scheme (`scheme` in `app.json`),
 * listed character for character in the environment's allowed redirect URLs. A custom
 * scheme is accepted for a provider that binds its code with PKCE (Google, GitHub,
 * Microsoft, Discord, X); for the others the app needs an `https` app link.
 */
export const REDIRECT_URL = 'com.example.tula:/oauth/callback'
```
<!-- /snippet -->

<!-- snippet: examples/expo/app/src/ways.tsx#provider-sign-in -->
```tsx
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
```
<!-- /snippet -->

`useSignIn().withProvider({ provider, redirectUrl })` does the whole round trip and leaves
the flow on `complete`, or on the second step the server asks for. Outside a component,
`signInWithProvider(client, input)` returns the outcome as a value.

- **The server decides whether the redirect URL is allowed.** A refusal is
  `request.redirect_not_allowed` (400), thrown before any browser opens. For a URL that
  *is* listed, `error.params.reason` says why it cannot be used here:
  `provider_without_pkce` (a custom scheme with Apple, LinkedIn or Facebook: use an app
  link) or `client_not_native`. A URL that is not listed has no reason. The package does
  not judge the URL itself.
- **A closed browser is not an error and not a sign-in**: `dismissed` is `true` (the
  outcome `cancelled`), and the button works again.
- **The ticket is honoured only with the binding this client was given.** The server
  hands the binding out at the start; the package keeps it in memory and nowhere else, so
  it is gone when the app is ended, and a round trip does not survive that. A callback
  URL that reaches the app some other way (a link someone sent) completes nothing.
- **What the browser comes back with is checked before anything is sent.** Only the
  redirect URL that was asked for, exactly, followed by a fragment, is read: the platforms
  match by scheme (iOS) or by prefix (Android), so another URL can come back. Anything
  else, a return with no ticket in it, and a ticket for a round trip this client did not
  start are refused **without a request**: the hook's error is `oauth.ticket_invalid` or
  `oauth.different_browser`, and the outcome `refused` with `unexpected_return`,
  `no_answer` or `not_started_here`.
- **That check is exact, and whether the platforms pass it has not been observed.** The
  URL has to come back character for character. Nobody has looked at what iOS or Android
  actually hands back: the slash form of a custom scheme (`com.example.app:/oauth/callback`
  against `com.example.app:///oauth/callback`), the case of an `https` link's host, a
  trailing slash. **A platform that rewrites any of that turns every real sign-in into
  `refused` with `unexpected_return`.** If you see that on a device, it is this and not
  your configuration; accepting more than the exact string is a decision for
  [ADR 0048](adr/0048-expo-passkeys-and-providers.md), because another app can register
  the same scheme, and is not something to work around in an app.
- **One round trip at a time**: a second while the browser is open is `flow.busy`.
- An exchange that got no answer (`network.failed`, `network.timeout`, `rate_limited`)
  can be sent again for a minute with `retryProvider()` (`retryProviderSignIn`): the
  ticket is held in memory for that long, and the browser need not open again.
- Nothing of the round trip (the ticket, the binding, the provider's code) is written to
  the secure store, a log line, an error or a URL the package builds.

**Connecting a provider to a signed-in account** is `linkProvider(client, input)`. The
server makes that attempt a browser's, so its redirect URL must be an `https` app link:
a custom scheme is refused with `client_not_native`.

**Do not hand incoming URLs to the client yourself.** The package reads the returned URL
from the browser session and nowhere else; `client.signIn.withOAuth` and
`handleOAuthCallback` called directly are refused or find nothing. A deep link your app
receives is untrusted input and is no part of a sign-in.

On iOS an `https` redirect URL is asked for as a universal link (iOS 17.4 and later);
`@tula/expo/browser` sets that by itself. **Whether a Custom Tab on Android hands an app
link back to the app, with its fragment, has not been observed**: the custom scheme is the
path more likely to work there until someone has run it.

## Apple's and Google's own sheets

Sign in with Apple's sheet and Google's account sheet hand the app an **ID token**; the
server signs the user in for it ([ADR 0045](adr/0045-native-id-token-exchange.md),
[ADR 0047](adr/0047-native-apple-sign-in.md), [the method](methods/oauth.md)). No browser
opens and no redirect URL is involved. **Neither sheet has been shown by this package**:
what follows is tested with stand-ins for both modules and with tokens the server's mock
provider makes.

**What the environment needs first.**

- **Apple**: the provider is enabled, and the app is registered under
  [native apps](native-apps.md) as an iOS app: its bundle ID is the audience the server
  accepts in Apple's token. With no iOS app registered the method is off. iOS only.
- **Google**: the provider is enabled, and the **web** client id you give `googleSheet`
  is the provider's `clientId` or one of its `additionalClientIds`: it is the audience of
  the token Google's sheet returns.

<!-- snippet: examples/expo/app/src/ways.tsx#native-provider-sign-in -->
```tsx
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
```
<!-- /snippet -->

`useSignIn().withIdToken({ provider })` starts the attempt, shows the sheet and exchanges
the token, and leaves the flow on `complete` or on the second step the server asks for.
Outside a component, `signInWithIdToken(client, { provider })` returns the outcome as a
value.

- **A control is hidden until its sheet is known to be there.** `useIdTokenProviders()`
  answers `{ google, apple }`, both `false` until the sheets have answered, which is after
  the first render. A sheet is there when the client was created with it, its native
  module is in the build, and the device has the sign-in (Sign in with Apple needs iOS 13
  and is not on Android; Google's is asked of Play services on Android). In Expo Go, on
  the wrong platform or on a phone without the sign-in the button is simply not drawn. A
  call made anyway is refused with `storage.failed` before any request; like the emailed
  link's, that message is written for another case, so do not show it for this one.
- **A dismissed sheet is not an error and not a sign-in**: `dismissed` is `true`, `error`
  stays `null`, no token was sent, and the button works again (the outcome `cancelled`).
  The next try starts an attempt of its own: an attempt takes one token.
- **The nonce is the package's business.** The server makes a nonce for every attempt and
  accepts the token only with it. Google's sheet is handed the nonce as it is. Apple's is
  handed its SHA-256 in lowercase hexadecimal, which is the one form the server accepts
  from Apple; the package takes the hash, so your app never does.
- **Apple's name travels beside the token.** Apple gives the user's name to the app once,
  at the first sign-in, and never in the token; the package passes it on, and the server
  uses it to name a **new** account and for nothing else.
- **One sheet at a time, of any kind**: a call while a provider's sheet, a passkey sheet or
  the browser of the same client is out is `flow.busy`, before any request.
- **A sheet that never answers gives its place up after five minutes.** The sign-in then
  ends as `dismissed`, and whatever the abandoned sheet answers later is dropped and
  never sent.
- A sheet that fails for another reason is the code `internal`; the module's own message
  is never shown or kept. The server's refusal of a token is `auth.invalid_credentials`,
  whatever was wrong with it.
- The ID token is sent once, in a JSON body, and is written to no store, log line or
  error.

**`@tula/expo/google` cannot be imported in Expo Go**: the Google module makes its native
object when it is imported. An app that must also start in Expo Go keeps that import out
of the bundle it runs there. `@tula/expo/apple` can be imported anywhere.

## A session bound to a device key

Give the client a key store and its sessions are **bound to a device key**
([device binding](device-binding.md), [ADR 0043](adr/0043-device-binding.md)): the first
sign-in makes a P-256 key the device keeps and does not hand out, the server binds the
session to it, and every refresh carries a proof signed by it. A refresh token copied off
the phone is then of no use without the phone's key.

The key store is the client's `deviceKeys` option, as in
[the client above](#the-client-and-the-provider). `hardwareDeviceKeys`
(`@tula/expo/device-key`) is over `@pagopa/io-react-native-crypto`: the Secure Enclave on iOS,
the Keystore (StrongBox where the phone has one) on Android. **No key was ever made with
it for this package**: that the key cannot be exported is what the module's source says,
not something seen on a device. `deviceKeys` takes any `DeviceKeyStore` (three functions),
so an app can put another module behind it; tests use a software key.

**The server's profile decides** (`deviceBinding` of the session profile, for new sign-ins
only):

| Profile | With a key store | Without one, or where the device cannot keep such a key |
| --- | --- | --- |
| `optional` (the default for a native client) | The session is bound. | The session is not bound. |
| `required` | The session is bound. | The sign-in is refused: `device.binding_required`. |
| `none` | The sign-in is refused: `device.binding_not_supported`. Create the client without `deviceKeys`. | The session is not bound. |

"Cannot keep such a key" is Expo Go and any build without the module, and a device whose
key store refused to make the key; the package finds the second out at the first sign-in
of a run and sends that sign-in, and the run's later ones, without a proof. Whether a
session is bound is `deviceBound` on the entries of `useSession().sessions`.

**A lost key ends the session on the device, before any request.** The stored refresh
token of a bound session is marked with its key (the public key's x coordinate, in the
same secure-store entry). When the app starts, the key is looked for first:

| What the key store says | What the app sees |
| --- | --- |
| The same key is there. | Signed in; refreshes carry a proof. |
| No key was there (one was made just now), or another one is. | **Signed out, with no request and no error.** The entry is removed. The user signs in again, and that session is bound to the new key. |
| There is no key store in this build any more. | The same: signed out. |
| It could not say (a locked phone, a Keychain error). | `storage.failed`, **the session kept**; the provider asks again. A key that could not be reached is never taken for a key that is gone. |

What that leaves, each of it on purpose:

- **The server is not told.** The dropped session stays in the account's list until it
  ends by its profile, or the user ends it from a device that is signed in.
- **A key that stops working while the app runs** is `device.key_failed` at the next
  refresh, with the session kept. No `device.*` code signs the app out; the next start
  looks at the key again.
- **Whether a reinstall loses the key is the platform's and was not observed.** On
  Android an uninstall removes the app's data and its keys together. On iOS a Keychain
  item can outlive an uninstall, the token and the key alike: if both do the session goes
  on, and if only the token does the user is signed out as above.
- **The key can be used only while the phone is unlocked** (iOS), whatever the secure
  store's own class is: a token asked for from a background task on a locked phone is
  `storage.failed` or `device.key_failed`, and the session is kept.
- **A device does not outlive its session.** The key earns nothing at the next sign-in:
  no factor is skipped for it, and the server recognises nobody by it.

## The config plugin

`@tula/expo/plugin` writes, into the app's Expo configuration, what the native side needs
for all of the above, from one place. **Expo has never run it**: it is tested on plain
configuration objects, and no prebuild was made with it.

<!-- snippet: examples/expo/app/app.config.ts#config -->
```ts
export default function config(context: { config: ExpoConfigLike }): ExpoConfigLike {
  const plugins: unknown[] = [
    // Each native module's own plugin stays in the list: `withTula` writes what a
    // configuration can say and no native file. Google's patches the iOS Podfile, and is
    // given the same reversed client id `withTula` writes.
    'expo-apple-authentication',
    ...(iosClientId
      ? [
          [
            'react-native-nitro-google-signin',
            { iosUrlScheme: reversedGoogleClientId(iosClientId) },
          ],
        ]
      : []),
  ]
  return withTula(
    { ...context.config, plugins },
    {
      // `webcredentials:<domain>` under Associated Domains: what a passkey needs on iOS.
      ...(domain && { domains: [domain] }),
      // The Sign in with Apple entitlement.
      apple: true,
      ...(webClientId && {
        google: { webClientId, ...(iosClientId && { iosClientId }) },
      }),
    }
  )
}
```
<!-- /snippet -->

| Option | What it adds |
| --- | --- |
| `domains` | `webcredentials:<domain>` under `ios.associatedDomains`: what a passkey needs on iOS. |
| `appLinks` (`{ domain, paths }`) | `applinks:<domain>` on iOS and, for each exact path, a verified `https` intent filter on Android: where a provider sign-in can return to. |
| `apple: true` | `ios.usesAppleSignIn` and the Sign in with Apple entitlement. |
| `google` (`{ webClientId, iosClientId? }`) | The ids under `extra.tula.google`; with an iOS id, `GIDClientID` and the reversed client id as a URL scheme. |

- It is a function, `withTula(config, props)`: call it in `app.config.ts`, or name
  `['@tula/expo/plugin', props]` in `plugins`. It only adds, adds nothing twice, and a
  wrong value is a `TypeError` that names the option.
- **It writes no native file.** A native module that has a config plugin of its own is
  still listed in `plugins`: `expo-apple-authentication`, and
  `react-native-nitro-google-signin`, whose plugin changes the iOS Podfile and wants the
  reversed iOS client id (`reversedGoogleClientId(iosClientId)` gives it the same value).
- It registers nothing with Tula: the app's bundle ID, package name, fingerprints and
  link paths are still entered under [native apps](native-apps.md), and the redirect URLs
  under the environment's settings.

## The emailed link

**An Expo app cannot sign in with an emailed link, and the package refuses to ask for
one**: `prepareFirstFactor({ strategy: 'email_link' })` fails with `storage.failed` before
any request, and a step that offers only a link is the screen `not_supported`. The hooks
never offer `email_link`, so only code that calls the client directly meets that error.
It carries `@tula/core`'s message for `storage.failed`, which is written for a page that
cannot use its storage: **do not show that message to a user for this case**; say that the
code in the email is the way. The server
honours a link only in the client that asked for it, and a link in an email opens the mail
app's browser, which is not the app. **The code in the same email is the way**: ask for
`email_code` and let the user type the six digits. Opening a link in the app (a deep link,
with the binding kept on the device) is not built.

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
          {/* What the server knows: a key signed for the session. Not whose hands it is in. */}
          {session.deviceBound ? ', bound to a device key' : ''}
        </Note>
      ))}
      <PasskeySection />
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
| Refresh token | The secure store: the Keychain on iOS, Keystore-encrypted storage on Android. For a [bound session](#a-session-bound-to-a-device-key), followed in the same entry by the public x coordinate of its key. | AsyncStorage, a file, a log line, an error, a URL. |
| The device key | The device's key store; the package holds its alias and its public half. | Anywhere the package could read it: it never sees the private key. |
| A provider's ID token | Memory, from the sheet's answer to the one request that sends it. | Storage, a log line, an error. |

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
    sign-out or a newer write in between calls a *waiting* try off. A try that is already
    inside the store at that moment cannot be recalled: after a sign-out the adapter
    deletes the entry once more when that write is taken (once; a refused delete leaves
    the value there), and after a newer write it adds nothing, so which of the two the
    store holds is the order the native layer completed them in (not observed on a
    phone; the next refresh writes its own token either way). Two tries and no more: a store that refuses for
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
| `storage.failed` | The secure store could not be read or written (a locked phone with the default access class, a full or broken Keychain), or, when the app starts with a bound session, the device's key store could not say whether the key is there. The running app keeps its session and its tokens work; try again later. After a refresh it means the newest refresh token is in memory only: see [what follows if the app is ended then](#where-the-tokens-are). |
| `network.failed` | No answer from the API. The session is kept. Check `baseUrl`: not `localhost` on a device, and `https` in a release build on iOS. |
| `network.timeout` | No answer in time. The session is kept. |
| `auth.invalid_credentials` | Wrong password or code, or an unknown address; the answer is the same on purpose. |
| `flow.not_found` | The attempt expired (ten minutes). Start again. |
| `passkey.unsupported` | The client has no passkey sheet, or the device has no passkeys. Hide the control (`usePasskeys().supported`). |
| `passkey.failed` | The sheet failed for a reason it did not name. Most often the app and the domain are not associated: check the association files, the Associated Domains entry and the registered app. |
| `request.origin_not_allowed` | For a passkey: no app of this platform is registered for the environment, or (iOS) `https://<rpId>` is not an allowed origin. |
| `request.redirect_not_allowed` | The redirect URL of a provider sign-in is not listed, or (`params.reason`) is listed and cannot be used with this provider or client. |
| `oauth.different_browser`, `oauth.ticket_invalid` | What came back from the browser was not this client's round trip. Start the sign-in again. |
| `flow.busy` | A provider sign-in is already under way, or a passkey sheet or a provider's own sheet is still out (for five minutes at most). |
| `device.key_failed` | The device key could not be found or did not sign (a locked phone, a key store that failed). The session is kept; try again later. |
| `device.binding_required` | The session profile needs a device key and this client has none: no `deviceKeys`, a build without the module, or a device that cannot keep such a key. |
| `device.binding_not_supported` | The session profile binds nothing and the client sent a proof. Create the client without `deviceKeys`. |
| `device.proof_invalid` | The server refused a proof. The session is kept and nothing is retried. A proof carries the phone's time, so a clock that is far off is one cause. |
| `internal` | From `withIdToken`: the provider's sheet failed for a reason that was not a dismissal. |
| `rate_limited` | Too many tries or messages. Wait for `Retry-After` (`error.retryAfterMs`). |

A `TypeError` when the client is created: the platform is not iOS or Android, an option
the package decides was passed, or the key is a secret key (never put one in an app).

## Testing your app

Your screens can be tested without a phone: `secureStoreStorage(store)` takes any object
with `expo-secure-store`'s three functions and two constants, and `@tula/core`'s
`createTulaClient` takes the result as its `storage`.

Reference: [`@tula/expo`](reference/expo.md), [`@tula/core`](reference/core.md). Method
pages: [password](methods/password.md), [emailed code](methods/email-code.md),
[passkeys](methods/passkeys.md), [providers](methods/oauth.md),
[sessions](methods/sessions.md).
