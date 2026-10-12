# Passkeys

Signing in with a fingerprint, face or screen lock (WebAuthn): from a button, from the
address field's autofill, as the second step after a password, and as a step-up. Users add,
rename and remove passkeys in the account page. Off by default.
The reasoning is in [ADR 0027](../adr/0027-passkeys.md).

> **Tested with a virtual authenticator only** (Chromium's, through the DevTools protocol).
> No physical authenticator, platform passkey manager or other browser has been exercised.

## Switch it on

Three settings in the same document: the method, the relying party and the origins.

| Where | How |
| --- | --- |
| Dashboard | **Sign-in methods**: passkeys and the passkey domain; **Settings**: allowed origins. |
| `tula.config.ts` | `signIn.methods.passkey`, `passkeys.rpId`, `urls.allowedOrigins`. |
| Admin API | `PUT /v1/admin/settings`. |

<!-- snippet: examples/tula-config/tula.config.ts#passkeys -->
```ts
passkeys: { rpId: 'northline.app' },
```
<!-- /snippet -->

<!-- snippet: examples/docs-snippets/admin.ts#settings-passkeys -->
```ts
const { data } = await admin.call('getEnvironmentSettings')
await admin.call('replaceEnvironmentSettings', {
  headers: { 'If-Match': ifMatch(data.revision) },
  body: {
    ...data.settings,
    signIn: {
      methods: {
        ...data.settings.signIn?.methods,
        password: { enabled: true },
        passkey: { enabled: true },
      },
    },
    passkeys: { rpId: 'example.com' },
    urls: { ...data.settings.urls, allowedOrigins: ['https://app.example.com'] },
  },
})
```
<!-- /snippet -->

- **`passkeys.rpId`** is the domain a passkey is bound to: the registrable domain your sign-in
  pages share (`example.com` covers `app.example.com`), or `localhost` in development. There
  is no default; the method cannot be switched on without it.
- **Every origin that uses passkeys is listed in `urls.allowedOrigins`** and is the `rpId` or
  a subdomain of it. This holds in the `local` tier too: list `http://localhost:<port>`
  explicitly, and open the page at `localhost`, not `127.0.0.1`.
- **Changing `rpId` orphans every passkey made under the old one.** Decide it first.
- **Https is required** outside `localhost`.

### From a native app

An iOS or Android app uses the same relying party, once the app is
[registered](../native-apps.md#register-an-app) and your domain serves the two association
files. Its requests carry no `Origin` and say `x-tula-client: ios` or `android`; what the
API accepts is the origin the platform writes for a registered app. For an iOS app that is
`https://<rpId>`, a page's origin, so it must also be an entry of `urls.allowedOrigins`;
an Android app needs no entry. [Passkeys from an app](../native-apps.md#passkeys-from-an-app)
has the rules. No SDK of this repository runs the ceremony on a device yet.

More in [self-host.md](../self-host.md#passkeys).

## What the user sees

- **Sign in with a passkey** on the sign-in page, and their passkeys offered in the address
  field's autofill. No address is typed and there is no second step.
- After a password, where a second step is in force anyway (they have an authenticator app, or
  the environment requires two steps): "Use your passkey to finish signing in".
- In the account page: the list (name, whether it is synced, last use), **Add a passkey**,
  rename and remove. Removing asks first, and the last way to sign in cannot be removed.
- In the "Confirm it is you" dialog: **Use your passkey**.
- A dismissed browser dialog is said quietly, not as an error, and the button works again.
- Where the browser has no WebAuthn the controls are left out.

## Security properties and limits

- Every response from a page is verified against the request's own `Origin`, which must be
  allowed and belong to `rpId`; user verification is always required.
- A request with no `Origin` is accepted only from a registered native app: an Android app
  by the origin its signing certificate gives (one per registered fingerprint), an iOS app
  by `https://<rpId>` once an iOS app is registered **and that origin is allowed** (it is
  also a page's: a response made on a page you did not allow is never accepted as an
  app's). The comparison is exact, and nothing in a body chooses the origin or the relying
  party.
- The server refuses what a phone reports as another app; it cannot prove that a request
  came from an app. Neither platform's origin has been seen from a device
  ([ADR 0027](../adr/0027-passkeys.md#native-apps-added-2026-10-09-tula-31)).
- A challenge is 32 random bytes, used once, valid five minutes.
- A passkey sign-in satisfies two-step verification by itself.
- A passkey sign-in by a user whose address is unverified asks for the emailed code
  (`needs_email_verification`) and then completes without a second factor.
- A failed passkey sign-in is always `auth.invalid_credentials`, whatever the reason.
- A user may hold at most ten passkeys. Adding, renaming and removing need a recent sign-in.
- A signature counter that does not grow is refused and recorded.
- An administrator's factor reset removes a user's passkeys as well
  ([two-step verification](two-step-verification.md#switch-it-on)).

## SDK calls

`<SignIn>` shows the button and runs the autofill request; `<UserProfile>` has the section.
Neither needs a prop:

<!-- snippet: examples/nextjs-app-router/app/profile/page.tsx -->
```tsx
import { UserProfile } from '@tula/nextjs'

/** The account page. The proxy protects it; the component talks to the API from the browser. */
export default function ProfilePage() {
  return <UserProfile afterSignOutUrl='/' />
}
```
<!-- /snippet -->

`@tula/core`:

<!-- snippet: examples/docs-snippets/core.ts#passkey-sign-in -->
```ts
if (tula.signIn.canUsePasskey()) {
  // The browser's passkey dialog; no address is typed.
  const flow = await tula.signIn.withPasskey()
  if (flow.step.status === 'complete') {
    // Signed in: a passkey needs no second step.
  }
}
```
<!-- /snippet -->

<!-- snippet: examples/docs-snippets/core.ts#passkey-autofill -->
```ts
// Offer passkeys in the address field's autofill (`autocomplete="username webauthn"`).
void tula.signIn.withPasskey({ autofill: true, signal })
```
<!-- /snippet -->

<!-- snippet: examples/docs-snippets/core.ts#passkey-manage -->
```ts
const passkey = await tula.user.passkeys.add({ name: 'Work laptop' })
await tula.user.passkeys.rename({ passkeyId: passkey.id, name: 'Laptop' })
const all = await tula.user.passkeys.list()
await tula.user.passkeys.remove({ passkeyId: passkey.id })
```
<!-- /snippet -->

One WebAuthn request can be pending per page: abort the autofill request (its `signal`)
before starting another ceremony. The components do this themselves.

`@tula/expo`: the same calls, with the platform's passkey sheet where a browser has
`navigator.credentials`. The app is registered as a [native app](../native-apps.md) first;
a dismissed sheet is `dismissed`, never an error ([expo.md](../expo.md#passkeys)). Not run
on a device yet.

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

Reference: [`@tula/core`](../reference/core.md), [`@tula/react`](../reference/react.md),
[`@tula/expo`](../reference/expo.md).

## Troubleshooting

| Code | What it means and what to do |
| --- | --- |
| `request.origin_not_allowed` | The page's origin is not in `urls.allowedOrigins`, or is not `rpId` or a subdomain of it. In local development, list the exact `http://localhost:<port>`. From a native app: the request named no `x-tula-client` of `ios` or `android`, no app of that platform is registered, or (iOS) `https://<rpId>` is not in `urls.allowedOrigins`. An app that is not the registered one, on a platform that has one, is the generic `auth.invalid_credentials` when it finishes: only its answer shows it. |
| `auth.method_disabled` | Passkeys are off, or `passkeys.rpId` is not set. |
| `auth.invalid_credentials` | The sign-in was refused: unknown passkey, wrong domain, a stale challenge, no user verification, an app build whose signing certificate is not a registered fingerprint. The reason is not said, on purpose. |
| `passkey.registration_failed` | The API could not accept the new passkey (wrong origin or relying party, an expired challenge, no user verification). |
| `passkey.already_registered` | That passkey is already on the account. |
| `passkey.already_on_device` | The authenticator already holds a passkey for this account (a client code). |
| `passkey.limit_reached` | Ten passkeys. Remove one first. |
| `passkey.last_sign_in_method` | Removing it would leave no way to sign in. |
| `passkey.cancelled` | The browser's dialog was dismissed or timed out (a client code; not an error for the user). |
| `passkey.unsupported` | The browser has no WebAuthn, or the page is not a secure context (a client code). |
| `auth.step_up_required` | The sign-in is too old for this change. Prove it again; see [step-up](two-step-verification.md#sdk-calls). |
| `validation.failed` | Switching the method on without `passkeys.rpId`, or with an `rpId` that is not a host name. |
