# Expo

`@tula/expo` puts Tula into an Expo app on iOS and Android. It is **headless**: a client, a
provider and hooks. It draws no screen; the screens are your app's, and the hooks tell them
which one the server is asking for. An app that would rather show Tula's own screens takes
[the native ones](#tulas-native-screens) instead, from a package of their own,
`@tula/expo-screens` ([ADR 0063](adr/0063-expo-native-screens.md)). The reasoning for the headless client is in
[ADR 0046](adr/0046-expo-sdk.md), for passkeys and providers
[ADR 0048](adr/0048-expo-passkeys-and-providers.md), and for Apple's and Google's own
sheets, the device key and the config plugin
[ADR 0052](adr/0052-expo-native-providers-and-device-keys.md), and for an emailed link
opened in the app [ADR 0055](adr/0055-expo-emailed-link.md).

> **Not yet run on a phone.** The package is tested against the real API in process with a
> stand-in for the secure store, and the [example app](../examples/expo/README.md) was
> installed, type-checked and bundled for iOS and Android on Expo SDK 57, with the passkey
> and the browser module in it, before Apple's and Google's sheets, the device key and
> the config plugin were added: **with those it was not installed, bundled or built**. Its
> iOS build did not complete
> ([what it needs](../examples/expo/README.md#building-for-ios)), so it has not been
> opened in Expo Go, a simulator or on a device. **No passkey sheet, no system browser and
> no provider's sheet has been opened by this package, no key was made in a phone's
> secure hardware, and no emailed link ever opened
> an app**: all of it is tested with stand-ins. An earlier form of the config plugin, which
> also carried the native screens' option, was run by Expo once, by `expo prebuild` in a
> scratch app ([below](#the-config-plugin)); no app was built from what it wrote, and
> neither plugin was run by Expo as it is now.
> What was not verified:
> [the package](plans/phase-2-unverified.md#step-213-tulaexpo-tula-36-adr-0046),
> [passkeys and providers](plans/phase-2-unverified.md#step-213-passkeys-and-provider-sign-in-in-tulaexpo-tula-48-adr-0048),
> [Apple's and Google's sheets, the device key and the plugin](plans/phase-2-unverified.md#step-213-native-google-and-apple-and-a-device-key-in-tulaexpo-tula-55-adr-0052),
> [the emailed link](plans/phase-2-unverified.md#step-213-an-emailed-link-opened-in-tulaexpo-tula-73-adr-0055),
> [the native screens](plans/phase-2-unverified.md#step-216-the-expo-native-screens-tula-62-adr-0063).

## What this version does

| | |
| --- | --- |
| Sign-up | An address and a password (or no password, where the environment allows it), then the emailed code. |
| Sign-in | A password, a code by email, a code by text message. An [emailed link](#the-emailed-link), opened in the app. A [passkey](#passkeys), through the platform's sheet. A [provider](#sign-in-with-a-provider) (Google, GitHub and the others), through the system browser. [Apple's and Google's own sheets](#apples-and-googles-own-sheets). A second step with an authenticator app, a backup code, a texted code or a passkey. A new password where the old one has expired. |
| Passkeys | Added to the signed-in account, and used to prove a recent authentication. |
| Password reset | A code by email, sent together with the new password. |
| Session | Kept across restarts in the device's secure store; refreshed when a token is asked for; [bound to a key the device keeps](#a-session-bound-to-a-device-key), where the app gives the client a key store; the account's devices listed and signed out. |
| Native configuration | [A config plugin](#the-config-plugin): Associated Domains, the Sign in with Apple entitlement and Google's client ids, said once. |
| Screens | None in `@tula/expo`. [Tula's native screens](#tulas-native-screens) (SwiftUI, Compose) are another package, `@tula/expo-screens`, on a native client of their own. |

A sign-in that offers only a way the client cannot do (an emailed link for a client with
no `emailLinkUrl`; a passkey for a client with no passkey sheet; a provider for a client
with neither a browser nor that provider's sheet) is answered with the screen
`not_supported`, not with an error.

**Expo web is not supported**: the package
refuses to create a client there; a web build uses [`@tula/react`](../packages/react/README.md).

## Install

`@tula/expo` works with Expo SDK 57 (`expo-secure-store` 57, React 19, React Native 0.86)
and needs no native module beyond `expo-secure-store`, which Expo Go includes.

To start from a project that already has the stack and an app, see [the native path of the
quickstart](quickstart.md#the-native-path) (`create-tula --framework expo`). A simulator and
an emulator need no account; a phone, a passkey, Apple's and Google's own sheets and an app
link each need an Apple or a Google account and an identifier of your own, and [one
table](native-apps.md#what-needs-your-own-accounts) says which needs what.

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

[Tula's native screens](#tulas-native-screens) are no entry point of `@tula/expo`: they
are the package `@tula/expo-screens`, installed apart, which needs `expo` itself and a
development build.

Each of the five can be replaced by an object of your own with the same two or three functions
(`BrowserSession`, `PasskeySheet`, `IdTokenSheet`, `DeviceKeyStore`): the package calls
no native module by itself. Why these modules, and what was read of each, is in
[ADR 0052](adr/0052-expo-native-providers-and-device-keys.md); none of the last three
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
    // Where an emailed sign-in link leads: with it the client can ask for one, and reads a
    // URL the app is opened with only when it is this one, followed by the link.
    ...(EMAIL_LINK_URL && { emailLinkUrl: EMAIL_LINK_URL }),
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
/**
 * Sign in with a password, or with a code or a link emailed to the address where the
 * environment offers one.
 */
export function SignInScreen(props: { onSignUp(): void }) {
  const signIn = useSignIn()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const step = signIn.step
  // An emailed link the app is opened with finishes this sign-in, if this sign-in asked.
  useEmailLinks(signIn)
  const linkProblem = emailLinkProblem(signIn.error)

  switch (signIn.screen) {
    case null:
      return (
        <Screen title='Sign in'>
          <Field kind='email' label='Email' value={email} onChangeText={setEmail} />
          {linkProblem ? <Note>{linkProblem}</Note> : <Problem error={signIn.error} />}
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
          {emailed ? null : <EmailLinkSignIn signIn={signIn} offered={offered} />}
          {emailed ? (
            <>
              {/* An email with a link carries the code too: the code works on any device. */}
              <Note>
                If {email} can sign in, an email is on its way: open its link on this phone, or type
                its 6-digit code.
              </Note>
              <Field kind='code' label='Code' value={code} onChangeText={setCode} />
              <Action
                label='Sign in'
                pending={signIn.isPending}
                onPress={() => void signIn.attemptFirstFactor({ strategy: 'email_code', code })}
              />
              {/* A link whose answer was lost may have been taken: this asks once more. */}
              <EmailLinkFinish signIn={signIn} />
            </>
          ) : null}
          {offered.includes('passkey') && !emailed ? <PasskeySignIn signIn={signIn} /> : null}
          {emailed ? null : <ProviderSignIn signIn={signIn} offered={offered} />}
          <Dismissed signIn={signIn} />
          {linkProblem ? <Note>{linkProblem}</Note> : <Problem error={signIn.error} />}
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
receives is untrusted input and is no part of a provider sign-in. The one URL an app hands
over is the one it was opened with, to `openEmailLink`, which reads it only when it is the
client's own [emailed-link URL](#the-emailed-link).

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
| No key was there (the key store said so twice, and then made one), or another one is. | **Signed out, with no request and no error.** The entry is removed. The user signs in again, and that session is bound to the new key. |
| There is no key store in this build any more. | The same: signed out. |
| It could not say (a locked phone, a Keychain error). | `storage.failed`, **the session kept**; the provider asks again. A key that could not be reached is never taken for a key that is gone. |

A key is made only after the key store said "not found" two times in a row; a key found
at the second look is the key, and anything else it says is the last row. A token is
marked only when the server's own answer says the session is bound to this device's key
(the access token's `cnf.jkt`): a sign-in that started with a proof and was not
completed marks nothing, and neither does the refresh of a session that is not bound.

What that leaves, each of it on purpose:

- **Removing the entry is not undone, and it rests on what the key store says.** Nobody
  has seen on a phone what it says while the phone is locked. If it ever says "not found"
  twice for a key that is there, and then makes one, the user is signed out and signs in
  again.
- **A call into the key store that never answers ends with the call's deadline**:
  `network.timeout`, nothing sent, the session kept.
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

## Tula's native screens

An app that does not want to draw its own screens can show Tula's: the
[SwiftUI screens](swift.md) on iOS and the [Compose screens](kotlin.md) on Android, as two
React Native views with the same props on both platforms. They are the screens a Swift or
a Kotlin app gets, on the same native clients; nothing is drawn in React Native. They are
the package **`@tula/expo-screens`**, apart from `@tula/expo` and not built on it: Expo
links a package's native module into every app that installs the package, so the module
is in a package only an app that wants the screens installs. An app on the headless client
compiles none of it. The reasoning is in [ADR 0063](adr/0063-expo-native-screens.md).

> **Written and partly compiled; never run.** The Android half was compiled, with the
> Kotlin SDK's sources in it, inside a scratch Expo SDK 57 app, while the module was still
> part of `@tula/expo`. On iOS the two libraries
> were compiled as pods and one of the module's two Swift files was type-checked against
> them; the file that talks to Expo's module API **was not compiled** (it needs Swift 6.2,
> and the Mac it was tried on had Xcode 16.4). **Nothing native was compiled after the
> module moved into `@tula/expo-screens`**, and that the package is linked by Expo's
> autolinking from where it is now was not tried. **No screen was drawn through this
> package**: not in a simulator, not in an emulator, not on a phone, and no JavaScript of it
> was bundled or run outside the package's tests, which stand in for the native module.
> [What was run and what was not](plans/phase-2-unverified.md#step-216-the-expo-native-screens-tula-62-adr-0063).

```bash
bunx expo install expo   # already there in an Expo app: 57 or later
bun add @tula/expo-screens
```

Then name the package's config plugin, `'@tula/expo-screens/plugin'`, in the `plugins` list
of the app's configuration (`app.json` or `app.config.ts`).

The native module is part of `@tula/expo-screens` (`ios/` and `android/` of the package)
and is meant to be linked by Expo's autolinking: there is no further package to install,
and `@tula/expo` is not needed for it. **Only an app that installs `@tula/expo-screens`
gets the module**: an app that has `@tula/expo` alone links and compiles nothing of it.
An app that does install it compiles all of it (on iOS that includes the one file nobody
has compiled, below). It is **not in Expo Go**: the app needs a development build, and
importing `@tula/expo-screens` in a build made before the package was installed throws.

iOS 16 and Android 9 (API 28) are the lowest versions. The Android module declares
`minSdkVersion 28` itself, and the package's config plugin, `@tula/expo-screens/plugin`,
raises the project's `android.minSdkVersion` Gradle property to 28 when the native project
is generated. It takes no options, imports nothing, adds the property where there is none,
raises a lower one (the one value already there that it changes) and never lowers a
higher one. Without the plugin an app whose minimum is below 28 fails its manifest merge
(the manifest merger's documented behaviour for a library with a higher minimum; not
tried here). On an older Android the set-up throws `screens.unsupported`. The plugin was
not run by Expo since it became this package's own.

**On Android the module compiles the Kotlin SDK against older libraries than the SDK is
tested on.** Nothing of the Kotlin SDK is published, so the module compiles a copy of its
sources with the app's own Kotlin, and an Expo SDK 57 app's Kotlin (2.1) cannot read the
set of libraries the SDK's own build uses. Every library is therefore behind:

| Library | The module compiles against | The SDK is tested on |
| --- | --- | --- |
| `kotlinx-serialization-json` | 1.8.1 | 1.11.0 |
| `kotlinx-coroutines-android` | 1.10.2 | 1.11.0 |
| Compose `ui` and `foundation` | 1.8.3 | 1.11.4 |
| `activity-compose` | 1.10.1 | 1.13.0 |
| Credential Manager (`credentials`, `credentials-play-services-auth`) | 1.5.0 | 1.6.0 |
| `googleid` | 1.1.1 | 1.2.1 |

The Kotlin SDK's tests (the JVM tests, the emulator UI tests) all ran on the right-hand
column. On the left-hand one the SDK was compiled, and nothing more: no test of it ran
against those versions, and no screen was drawn with them. A test in the repository fails
when a version on either side changes without the written list of differences changing
with it. [ADR 0063](adr/0063-expo-native-screens.md) has what was tried and what was only
read from the published artifacts.

### One session owner

**An app is on the native screens or on the headless client, never on both.** The native
screens run on the native client (`TulaClient` of the Swift or the Kotlin SDK), and that
client owns the session: it keeps the refresh token (the Keychain on iOS; sealed by a
Keystore key on Android), refreshes it, and binds it to a device key where asked.
`createTulaExpoClient` of `@tula/expo` makes another client with another stored session.
Neither package stops an app from installing both and making both; the
[example](../examples/expo/README.md) runs the headless client, and its other root, on the
native screens, is a set of files it does not load unless they are copied in.

**What happens in an app that creates both**, in plain words: the user has two separate
sessions, and neither client knows of the other's.

- Signing in on a native screen does not sign the headless client in: `useAuth()` and the
  hooks still say signed out, and `getToken()` of the headless client has no token. The
  other way round is the same: a sign-in through the hooks leaves `tula.getState()` of the
  native screens signed out, and `<TulaAuthView>` still draws the sign-in.
- If the user signs in through both, the server has two sessions of that user from this
  phone, each with a refresh token of its own: one in the secure store, one in the native
  client's storage. The account's session list shows both.
- Signing out through one ends that one. The other stays signed in, on the phone and on
  the server, until it is signed out too or ended from the session list.
- Where sessions are bound to a device key, the two clients keep different keys.

Nothing copies a session from one to the other, and nothing should.

<!-- snippet: examples/expo/screens/src/native-tula.ts#native-screens -->
```ts
function createScreens(publishableKey: string, baseUrl: string) {
  return createTulaScreens({
    publishableKey,
    // The address of the Tula API as the phone reaches it: never `localhost` on a device.
    baseUrl,
    // What the screens may offer. Each is a switch and nothing else: the native client
    // makes its own passkey sheet, browser session and device key, and JavaScript is
    // handed none of them. A way that is switched off is not drawn.
    passkeys: true,
    browser: true,
    apple: true,
    deviceBinding: true,
    // Android only: Google's own sheet, for the environment's Google provider.
    ...(googleWebClientId && { googleWebClientId }),
  })
}
```
<!-- /snippet -->

`createTulaScreens(options)` makes the process's one native client and returns what
JavaScript may see of its session. Call it once, outside any component. Every option is a
string or a boolean:

| Option | What it does |
| --- | --- |
| `publishableKey`, `baseUrl` | The environment's publishable key and the API's address. |
| `sessionProfile` | The session profile to ask for, where the environment marks it `clientSelectable`. |
| `deviceBinding` | Bind sessions to a key the device keeps ([above](#a-session-bound-to-a-device-key)): the native SDK's own key store, not `@tula/expo/device-key`. |
| `passkeys` | Offer passkeys through the system's sheet (iOS) or Credential Manager (Android). |
| `apple` | iOS only: offer the Sign in with Apple sheet. |
| `browser` | Offer the other providers in the system's browser. A provider is drawn only where the screen is also given a `redirectUrl`. |
| `googleWebClientId` | Android only: the client ID of the environment's Google provider, for Google's own sheet. Not a secret. |

A way that is not switched on is not drawn. The options that hand the headless client a
storage, a sheet or a key store (`storage`, `secureStore`, `deviceKeys`, `fetch`
and the others) are refused with a `TypeError`: the native client makes its own. Calling
`createTulaScreens` again with the same options (a reload of the JavaScript) is fine; with
other options it throws `screens.already_configured`, because two native clients over one
stored token would each refresh it.

### The two views

<!-- snippet: examples/expo/screens/NativeApp.tsx#native-app -->
```tsx
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
```
<!-- /snippet -->

| Prop | `<TulaAuthView>` | `<TulaAccountView>` | |
| --- | --- | --- | --- |
| `tula` | yes | yes | What `createTulaScreens()` returned. |
| `mode` | yes | | `'sign-in'` (the default) or `'sign-up'`: the flow the screen opens with. |
| `redirectUrl` | yes | | Where a provider's page comes back to. The server judges it; without it no provider that needs the browser is drawn. |
| `onSignedIn` | yes | | Called once per completed sign-in or sign-up, with nothing. |
| `onSignedOut` | | yes | Called for a sign-out the server was told of, never for one that failed. |
| `theme`, `onThemeRefused` | yes | yes | [Below](#the-theme-of-the-native-screens). |
| `style`, `testID` | yes | yes | React Native's. Give the view its size (`{ flex: 1 }`). |

- **Where the app goes after a sign-in is `onSignedIn` and nothing else.** The screens
  read no URL, no deep link and no intent, and neither view takes a destination. Backup
  codes of an authenticator set up inside a sign-in are shown before `onSignedIn` is
  called, so go on when it is called and not when the state says `signed-in`.
- **A failed sign-out is not a sign-out**: the account screen stays, says that the session
  may still be active and offers the sign-out again; `onSignedOut` is not called.
- **A view that leaves its window does not keep a half-finished sign-in.** On Android the
  screen is disposed when its view is detached from the window (a navigator that detaches
  an inactive screen, `removeClippedSubviews`): the open flow is discarded and its fields
  are emptied, and the view starts over when it comes back. On iOS the screen is taken out
  of its parent controller; whether SwiftUI then closes it was not observed, so do not
  count on the flow being there. Keep the view mounted and attached while someone signs in.
- **The words are the native screens' own** (English). There is no prop for them in this
  version: text a JavaScript bundle hands to a native screen is a decision of its own.
- What each screen draws, and what it never does (nothing is emailed or texted by arriving
  at a step; a step with no screen is "not supported"), is the native SDKs':
  [swift.md](swift.md) and [kotlin.md](kotlin.md).

### What JavaScript sees of the session

`tula.getState()` is the last state the native client told: `{ status: 'loading' }`,
`{ status: 'signed-out' }` or `{ status: 'signed-in', sessionId, userId }`.
`tula.addListener(listener)` is told of every change, `tula.load()` reads the stored
session once, and `tula.signOut()` ends the session and rejects when the server could not
be told. JavaScript keeps that state and nothing else: it is not a second session, and
nothing is decided from it that the native client does not decide.

| | Where | Crosses to JavaScript |
| --- | --- | --- |
| Refresh token | The native client's storage: the Keychain (iOS), a Keystore-sealed entry (Android). | **Never**: no function returns it and no event or prop holds it. |
| Access token | The native client's memory. | Only as the answer of `tula.getToken()`, for the app's own backend. It is returned and not kept; ask again for each request. Never in an event or a prop. |
| The session's state | The native client. | A status, the session's id and the user's id. |
| A password, a code, a setup key, backup codes | The native screen that shows them, while it is open. | Never. |

A failed call throws `TulaError` with a code and the client's sentence for it. Only a
code crosses from the native side, and only one of a closed set: the module's own codes,
the native client's own (`network.failed`, `storage.failed` and the others) and the codes
of the API's contract as the installed package knows them. Anything else that arrives
where a code goes is `internal` by the time JavaScript sees it. So **a code a newer server
has gained is `internal` here until the app is built with a newer `@tula/expo-screens`**: do not
branch on a code this version does not list. A server's own text, and what the system
threw, have no path across. That is what the native sources say and what the package's
tests hold from their text; no error has crossed a bridge in a running app.
The module's own codes are `screens.not_configured`, `screens.already_configured`,
`screens.invalid_options` and `screens.unsupported`; a code this version has no sentence
for is `internal`.

### Keep the Android token file out of backups

On Android the native client keeps the refresh token sealed by a Keystore key in a
preferences file, `dev.tula.auth.tokens.xml`. **That file is in Android's backups** (Auto
Backup, and the device-to-device transfer) **unless the app excludes it**, and only the app
can: the module does not, and the config plugin sets no backup rule. The key never leaves
the device, so the copy is of no use on another one, and it should not be in a backup at
all.

Exclude the file exactly as a Kotlin app does:
[Keep the file out of backups](kotlin.md#keep-the-file-out-of-backups) has the two rule
files, `res/xml/data_extraction_rules.xml` (read by Android 12 and later) and
`res/xml/backup_rules.xml` (Android 11 and earlier), and the two attributes of the
`<application>` element that name them. Both files are needed. The native screens use the
default file name, so the path in the rules is `dev.tula.auth.tokens.xml` as written
there.

In an Expo app those files belong to the generated Android project: add them with a
config plugin of the app's own, or by hand in an `android/` directory the app keeps. If
the app already has backup rules (another library's, or its own), add the three
`<exclude>` lines to them instead of replacing the files. None of this was tried in an
Expo app. After a restore or a transfer the user is signed out, by design.

### The theme of the native screens

`theme` takes the tokens of `@tula/contract/theme`, the ones `@tula/react` takes:
`light` and `dark` with the colours, and the shared ones (`radius` and the others) beside
them.

<!-- snippet: examples/expo/screens/NativeApp.tsx#native-theme -->
```tsx
/**
 * The app's colours, in the tokens `@tula/react` takes. A constant: the screens check the
 * values each time the object changes, and a value they refuse is left out.
 */
const THEME: ThemeOverrides = {
  light: { primary: '#1f4fd8' },
  dark: { primary: '#8aa4ff' },
  radius: '8px',
}
```
<!-- /snippet -->

**A theme value is untrusted and is checked twice.** In JavaScript every value goes
through the contract's `isValidThemeValue` for its token before it is handed to the native
view; a value that fails, and a name that is no token, are left out, and
`onThemeRefused` is called with the tokens' names (`light.primary`, `radius`) and never
with a value. The native screens then apply their own copy of the grammar and refuse what
they cannot draw (`oklch()` or a `%` length, for example); a value refused there is
the default's, and is not reported back. Keep the object the same between renders.

## The config plugin

`@tula/expo/plugin` writes, into the app's Expo configuration, what the native side needs
for the headless client, from one place. It is tested on plain configuration objects.
**Expo has not run it as it is now.** An earlier form of it, which also carried the native
screens' option (since moved to `@tula/expo-screens/plugin`,
[above](#tulas-native-screens)), was run once: `expo prebuild` (Expo 57.0.28) in a scratch
app on 2026-10-13, with `nativeScreens`, `domains`, `appLinks` and `apple`, wrote the
entitlements, the intent filter and the Gradle property the tests expect; `google` was not
among the options, and no app was built from the result
([what was run](plans/phase-2-unverified.md#step-216-the-expo-native-screens-tula-62-adr-0063)).

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
      // `applinks:<domain>` on iOS and a verified intent filter for the exact path on
      // Android: what has the operating system open the emailed link in the app.
      ...(linkDomain && linkPath && { appLinks: [{ domain: linkDomain, paths: [linkPath] }] }),
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
| `appLinks` (`{ domain, paths }`) | `applinks:<domain>` on iOS and, for each exact path, a verified `https` intent filter on Android: where a provider sign-in can return to, and what has an [emailed link](#the-emailed-link) open the app. |
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

A sign-in can be finished with the link in an email, opened in the app
([ADR 0055](adr/0055-expo-emailed-link.md)). **No emailed link has opened an app through
this package, on a phone or in a simulator**: what follows is tested against the real API
in process, with the URL handed to the package as an operating system would hand it over
([what was not verified](plans/phase-2-unverified.md#step-213-an-emailed-link-opened-in-tulaexpo-tula-73-adr-0055)).

**What it needs** is one `https` app link, for example
`https://app.example.com/sign-in/link`:

- given to the client as `emailLinkUrl`: an `https` URL with no query, no fragment, no
  user name (`@`), no backslash and no white space, or the client is not created (a
  `TypeError`). Without it the client asks for no link
  (`storage.failed` before any request) and a step that offers only a link is the screen
  `not_supported`;
- listed, character for character, in the environment's allowed redirect URLs. **A custom
  scheme is not accepted for an emailed link**, by the server
  (`request.redirect_not_allowed`, `not_a_provider_sign_in`) or by `emailLinkUrl`;
- opened by the app and not by a browser: its path is one of the app's `appLinkPaths`
  ([native apps](native-apps.md)) and its domain is associated with the app (`appLinks`
  of [the config plugin](#the-config-plugin)). On Android one path hands the app every
  link of the domain: the package still reads only this one.

<!-- snippet: examples/expo/app/src/tula.ts#email-link-url -->
```ts
/**
 * The app link an emailed sign-in link leads to: an `https` URL of a domain associated with
 * the app, listed character for character in the environment's allowed redirect URLs.
 * `app.config.ts` gives the same variable to the config plugin. Unset, the app asks for no
 * link: the code in the email is the way.
 */
export const EMAIL_LINK_URL = process.env.EXPO_PUBLIC_TULA_EMAIL_LINK_URL || undefined
```
<!-- /snippet -->

**Asking for the link** is `prepareFirstFactor({ strategy: 'email_link' })` on a sign-in
whose step offers it. The link leads to `emailLinkUrl` and nowhere else: the hook takes no
redirect URL. **Opening it** is `openEmailLink(url)`, with every URL the app is opened
with (React Native's `Linking`):

<!-- snippet: examples/expo/app/src/ways.tsx#email-link -->
```tsx
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
```
<!-- /snippet -->

What `openEmailLink` does with a URL:

| The URL | What happens |
| --- | --- |
| Anything but `emailLinkUrl`, character for character, followed by `#` and a link: another path, a longer one, another host, a query, another case, no fragment | Resolves `null`. Nothing is sent and nothing changes: it is some other link of your app's. |
| A link this hook's sign-in did not ask for, or whose binding the client no longer keeps: asked for on another phone, in another app, by another sign-in of this app, more than fifteen minutes ago, or before the app was ended and started again | The error `verification.different_browser`. **Nothing is sent and nothing is used up**: the link still works where it was asked for, and so does the code. |
| The link this sign-in asked for | Sent to the server once, with the binding. Then the sign-in is asked to finish: the step is `complete`, or what the server asks for next (a second step). |
| That link, already used, replaced by a newer email or older than ten minutes | The error `verification.expired`. "Used" includes used by this app a moment ago, with the answer lost: try `finishEmailLink()` before asking for a new one. |

- **The link's binding is kept in memory only**, for fifteen minutes at most, and is
  dropped when the link is accepted, when the sign-in completes another way and on
  `reset()`. Never the secure store, AsyncStorage, a file, a log line, an error or a URL.
- **Accepting a link signs nobody in.** The server's answer to the link carries no token.
  The sign-in that asked holds the attempt's secret, in memory, and is the one that
  finishes; it is asked once, right after the link was taken. If that call got no answer,
  the hook's `error` is that call's (`network.failed`, …) and `finishEmailLink()` asks
  again: the link itself is spent by then.
- **A link whose own request got no answer may have been taken.** `network.failed` and
  `network.timeout` from `openEmailLink` do not say the server never saw the link: it may
  have taken it and the answer was lost. The link is then spent, opening the same URL
  again is `verification.expired`, and nothing is asked on a guess. **`finishEmailLink()`
  is what to try**, after a lost answer and after `verification.expired` for a link this
  sign-in asked for: it signs in when the link was taken and otherwise changes nothing
  (the step is the same, and nothing is counted against the sign-in), so it can be a
  button on the "check your email" screen. A refusal the server sent (`rate_limited`,
  `auth.method_disabled`) spent nothing, and the same URL can be opened again.
- **An app that was ended in between cannot finish with the link.** A phone may end an
  app in the background while its user reads the email. The app that starts again holds
  neither the binding nor the sign-in that asked, so the link is refused without a
  request, and the code of that email is of no use either (the sign-in it belongs to went
  with the app). The user asks again; say so on the screen. Keeping a sign-in across a
  restart would mean storing its secret, and that is not done
  ([ADR 0055](adr/0055-expo-emailed-link.md)).
- **Offer the code field beside "check your email".** The same email carries a 6-digit
  code, which works on whatever device the email is read:
  `attemptFirstFactor({ strategy: 'email_code', code })`.
- **A mail app that opens links in its own browser never opens your app.** The link then
  lands on whatever your domain serves at that path, in a browser that asked for nothing:
  nothing is spent, and a page there that presented the link would be answered
  `verification.different_browser`. Serve a page at that address that says to open the
  email on the phone that asked, or to type the code. Which mail apps do this was not
  looked at.
- **Word the two errors by `error.code`**: the client's own sentences for them speak of a
  browser and of a code.
- One at a time: `flow.busy` while another link is being opened or a provider's round
  trip is under way.

Without the hooks: `requestEmailLink(client, flow)`, `openEmailLink(client, flow, url)`,
which resolves to an outcome (`accepted` with the step, `expired`, or `refused` with
`unexpected_url`, `no_link` or `not_started_here`) and throws only what a retry can cure,
and `isEmailLink(client, url)`, which says without a request whether a URL is the
client's emailed-link URL with a link in it.

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
| The binding of an [emailed link](#the-emailed-link) | Memory, for fifteen minutes at most: from the request that asked for the link to the one that presents it. | The secure store, AsyncStorage, a file, a log line, an error, a URL. |

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
| `storage.failed` | The secure store could not be read or written (a locked phone with the default access class, a full or broken Keychain), or, when the app starts with a bound session, the device's key store could not say whether the key is there. The running app keeps its session and its tokens work; try again later. After a refresh it means the newest refresh token is in memory only: see [what follows if the app is ended then](#where-the-tokens-are). From asking for an emailed link, before any request: the client was created without `emailLinkUrl`. |
| `network.failed` | No answer from the API. The session is kept. Check `baseUrl`: not `localhost` on a device, and `https` in a release build on iOS. From `openEmailLink`: the link may have been taken all the same; try `finishEmailLink()`. |
| `network.timeout` | No answer in time. The session is kept. From `openEmailLink`: as for `network.failed`. |
| `auth.invalid_credentials` | Wrong password or code, or an unknown address; the answer is the same on purpose. |
| `flow.not_found` | The attempt expired (ten minutes). Start again. |
| `passkey.unsupported` | The client has no passkey sheet, or the device has no passkeys. Hide the control (`usePasskeys().supported`). |
| `passkey.failed` | The sheet failed for a reason it did not name. Most often the app and the domain are not associated: check the association files, the Associated Domains entry and the registered app. |
| `request.origin_not_allowed` | For a passkey: no app of this platform is registered for the environment, or (iOS) `https://<rpId>` is not an allowed origin. |
| `request.redirect_not_allowed` | The redirect URL of a provider sign-in, or the `emailLinkUrl` of an emailed link, is not listed, or (`params.reason`) is listed and cannot be used with this provider or client. |
| `verification.different_browser` | From `openEmailLink`: the link was not asked for by this sign-in, in this run of the app. Nothing was sent and nothing was used up. Ask for a new link here, or use the code. Word it yourself: the client's sentence speaks of a browser. |
| `verification.expired` | From `openEmailLink`: the link is used, replaced by a newer email or older than ten minutes. If this sign-in asked for it, try `finishEmailLink()` first (the link may have been used by this app, with the answer lost); otherwise ask for a new one. |
| `oauth.different_browser`, `oauth.ticket_invalid` | What came back from the browser was not this client's round trip. Start the sign-in again. |
| `flow.busy` | A provider sign-in is already under way, an emailed link is being opened, or a passkey sheet or a provider's own sheet is still out (for five minutes at most). |
| `device.key_failed` | The device key could not be found or did not sign (a locked phone, a key store that failed). The session is kept; try again later. |
| `device.binding_required` | The session profile needs a device key and this client has none: no `deviceKeys`, a build without the module, or a device that cannot keep such a key. |
| `device.binding_not_supported` | The session profile binds nothing and the client sent a proof. Create the client without `deviceKeys`. |
| `device.proof_invalid` | The server refused a proof. The session is kept and nothing is retried. A proof carries the phone's time, so a clock that is far off is one cause. |
| `internal` | From `withIdToken`: the provider's sheet failed for a reason that was not a dismissal. |
| `rate_limited` | Too many tries or messages. Wait for `Retry-After` (`error.retryAfterMs`). |

A `TypeError` when the client is created: the platform is not iOS or Android, an option
the package decides was passed, `emailLinkUrl` is not a plain `https` URL (it has a query, a fragment, a user name, a
backslash or white space),
or the key is a secret key (never put one in an app).

## Testing your app

Your screens can be tested without a phone: `secureStoreStorage(store)` takes any object
with `expo-secure-store`'s three functions and two constants, and `@tula/core`'s
`createTulaClient` takes the result as its `storage`.

Reference: [`@tula/expo`](reference/expo.md), [`@tula/core`](reference/core.md). Method
pages: [password](methods/password.md), [emailed code](methods/email-code.md),
[passkeys](methods/passkeys.md), [providers](methods/oauth.md),
[sessions](methods/sessions.md).
