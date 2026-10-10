# Google, GitHub, Apple, Microsoft, Discord, LinkedIn, X and Facebook (OAuth)

"Continue with Google", GitHub, Apple, Microsoft, Discord, LinkedIn, X or Facebook, and connecting or
disconnecting those accounts in the account page. Each environment uses its own credentials; none ship with Tula.
The reasoning (the callback, the ticket, when accounts are linked) is in
[ADR 0026](../adr/0026-oauth.md).

> **Not verified against the live consoles.** Nothing in this repository has real provider
> credentials: the flow is tested against the API's built-in mock provider. The redirect URI,
> the scopes and the protocol are what the code sends; the console steps in the setup
> checklists are written from each provider's documentation and have not been clicked through.

## Switch it on

Three things per provider, in this order:

1. **Register an app with the provider**, giving it Tula's redirect URI. It is on the API,
   not on your app, and is exactly `PUBLIC_URL/v1/oauth/callback/<provider>`, for example
   `https://auth.example.com/v1/oauth/callback/google`. `GET /v1/admin/oauth-providers` lists
   it as `callbackUrl`. Checklists: [Google](../providers/google.md),
   [GitHub](../providers/github.md), [Apple](../providers/apple.md),
   [Microsoft](../providers/microsoft.md), [Discord](../providers/discord.md),
   [LinkedIn](../providers/linkedin.md), [X](../providers/x.md),
   [Facebook](../providers/facebook.md).
2. **Give Tula the credentials.**
3. **Allow your app's landing page** (the page that renders `<OAuthCallback>`) in
   `urls.allowedRedirectUrls`, exactly.

| Provider | Redirect URI | Scopes Tula asks for | Credentials |
| --- | --- | --- | --- |
| Google | `PUBLIC_URL/v1/oauth/callback/google` | `openid`, `email`, `profile` | client id, client secret |
| GitHub | `PUBLIC_URL/v1/oauth/callback/github` | `read:user`, `user:email` | client id, client secret |
| Apple | `PUBLIC_URL/v1/oauth/callback/apple` (https and a real domain; not `localhost`) | name and email | Services ID, team id, key id, the `.p8` key |
| Microsoft | `PUBLIC_URL/v1/oauth/callback/microsoft` | `openid`, `profile`, `email` | client id, client secret, the tenant (`common`, `organizations`, `consumers` or a tenant id) |
| Discord | `PUBLIC_URL/v1/oauth/callback/discord` | `identify`, `email` | client id, client secret |
| LinkedIn | `PUBLIC_URL/v1/oauth/callback/linkedin` | `openid`, `profile`, `email` | client id, client secret |
| X | `PUBLIC_URL/v1/oauth/callback/x` | `users.read`, `tweet.read` (no email) | OAuth 2.0 client id, client secret |
| Facebook | `PUBLIC_URL/v1/oauth/callback/facebook` | `public_profile` (no email) | app id (as `clientId`), app secret (as `clientSecret`) |

| Where | How |
| --- | --- |
| Dashboard | **Sign-in methods**: configure Google, GitHub, Apple, Microsoft, Discord, LinkedIn, X and Facebook. A saved secret is write-only. |
| `tula.config.ts` | `providers`, with every secret as `env('NAME')`, then `tula apply`. |
| Admin API | `PUT /v1/admin/oauth-providers/<provider>`. |

<!-- snippet: examples/tula-config/tula.config.ts#providers -->
```ts
providers: {
  google: {
    clientId: '1234567890-abc.apps.googleusercontent.com',
    clientSecret: env('GOOGLE_CLIENT_SECRET'),
  },
  github: { clientId: 'Iv1.fedcba9876543210', clientSecret: env('GITHUB_CLIENT_SECRET') },
  apple: {
    clientId: 'app.northline.web',
    teamId: 'A1B2C3D4E5',
    keyId: 'K1L2M3N4O5',
    // The whole .p8 file's contents, in a variable.
    privateKey: env('APPLE_PRIVATE_KEY'),
  },
  microsoft: {
    clientId: '6731de76-14a6-49ae-97bc-6eba6914391e',
    clientSecret: env('MICROSOFT_CLIENT_SECRET'),
    // Which accounts may sign in: 'common', 'organizations', 'consumers' or a tenant id.
    tenant: 'organizations',
  },
  discord: {
    clientId: '1198765432101234567',
    clientSecret: env('DISCORD_CLIENT_SECRET'),
  },
  linkedin: { clientId: '86abcdefgh1234', clientSecret: env('LINKEDIN_CLIENT_SECRET') },
  // X and Facebook are asked for no email address: an account made through either has
  // none, and is never joined to an account with one.
  x: { clientId: 'bEx4bXBsZUNsaWVudElk', clientSecret: env('X_CLIENT_SECRET') },
  // Facebook calls them the app id and the app secret.
  facebook: { clientId: '1234567890123456', clientSecret: env('FACEBOOK_APP_SECRET') },
},
```
<!-- /snippet -->

<!-- snippet: examples/docs-snippets/admin.ts#providers -->
```ts
await admin.call('updateOAuthProvider', {
  params: { provider: 'google' },
  body: {
    enabled: true,
    clientId: '1234567890-abc.apps.googleusercontent.com',
    clientSecret, // from your secret manager; it is stored encrypted and never returned
  },
})
const { data } = await admin.call('listOAuthProviders')
// data.data[n].callbackUrl is the redirect URI to register with the provider.
```
<!-- /snippet -->

**Without credentials**, in local development only: start the API with
`OAUTH_MOCK_PROVIDER=true`. Every provider is then served by a built-in mock whose consent
page signs in as whatever address is typed into it. The API refuses to start with it unless
`ENVIRONMENT=local` and `PUBLIC_URL` is a loopback address. A project made by `create-tula`
reads the switch from its `.env`.

## What the user sees

- A button per enabled provider above the sign-in and sign-up forms.
- The provider's own consent page, then your app's callback page for a moment, then the app.
- In the account page: the connected accounts, **Connect** for the others and **Disconnect**
  (refused for the last way to sign in).
- A provider account whose address already belongs to a Tula user is connected to that user
  only when both sides have verified the address; otherwise the user is told an account
  exists and to sign in to it first.
- With Microsoft an address counts as verified only when the token carries the
  verified-domain claim (`xms_edov`), which the operator adds to the app registration. A
  token without it signs in an account Tula already knows and nothing else: no sign-up, no
  automatic link ([the checklist](../providers/microsoft.md#what-the-address-proves)).
- With Discord an address counts as verified only when the user object says `verified: true`;
  with LinkedIn only when its userinfo answer says `email_verified: true`. An account with no
  address, or one the provider does not vouch for, signs in where Tula already knows it and
  nothing else ([Discord](../providers/discord.md#what-the-address-proves),
  [LinkedIn](../providers/linkedin.md#what-the-address-proves)).
- **With X and Facebook there is no address at all.** Neither is asked for one. A first
  sign-in makes an account with **no email address**, which is never joined to an account
  that has one: someone who already has an account and chooses "Continue with X" gets a
  second one, unless they connect X from their account page instead. Such an account's
  page shows no address and no password section, it gets no security emails, and its
  provider account cannot be disconnected until it has a passkey
  ([X](../providers/x.md#no-email-address),
  [Facebook](../providers/facebook.md#no-email-address)).

## Security properties and limits

- The provider returns to the API, which sets no cookie and returns no token: it redirects to
  your allow-listed page with a single-use, 60-second ticket in the URL fragment.
- The ticket is honoured only in the tab that started, together with a binding kept in that
  tab's `sessionStorage` (`tula.oauth.<attempt id>`; not a token). This is what stops a
  sign-in being planted in someone else's browser.
- The provider's authorization code is bound to the sign-in that asked for it. With Google,
  GitHub, Microsoft and Discord that is PKCE (an S256 `code_challenge` on the way out, the
  `code_verifier` with the token request; the verifier never leaves the server); with Google,
  Apple and Microsoft it is also the `nonce` in the signed ID token. Apple documents no PKCE and gets none. GitHub's PKCE
  was tested against the built-in mock provider and the requests the adapter builds, not
  against github.com. Discord's OAuth2 page does not mention PKCE: the adapter sends it
  because the client library it uses does, and whether Discord refuses a wrong verifier was
  never observed.
- **LinkedIn has neither.** Its authorization request takes five parameters and none of them
  is a PKCE challenge or a nonce, and its ID token is not documented to carry a nonce. A
  LinkedIn code is bound to the sign-in only by the single-use `state` and by the client
  secret ([why](../adr/0026-oauth.md#discord-and-linkedin)).
- **X has PKCE; Facebook has neither PKCE nor a nonce** in the flow used here (Meta documents
  them only for its OpenID Connect flow). A Facebook code is bound to the sign-in by the
  single-use `state`, the app secret and the exact redirect URI, as LinkedIn's is: the
  weakest binding of the eight providers
  ([why](../adr/0026-oauth.md#x-and-facebook-providers-without-an-address)).
- A provider sign-in is a **first** factor: a user with two-step verification is still asked
  for the second step.
- A provider address that the provider does not assert as verified is refused.
- **An account made through X or Facebook has no email address**, and there is no way to
  add one today. It receives no security notice (a new device, a changed factor), cannot
  sign in by emailed code or link, cannot have a password, and cannot step up once the
  window after its sign-in has passed unless it has a passkey or an authenticator app. Its
  `email` is `null` in the API, in `useUser()` and in the `before_sign_up` hook's question.
- An X account is its numeric user id, never its username; a Facebook account is the
  app-scoped user id, which is another value in another Facebook app. Neither adapter was
  run against the provider, and **what X charges for the API call a sign-in makes was not
  confirmed** ([X: limits](../providers/x.md#limits)). Facebook's profile is read on a
  pinned Graph API version that has to be raised before Meta retires it.
- A Microsoft account is its tenant id and object id, never its address, and its token's
  issuer must be the one of the tenant the token itself names. Neither was run against
  Microsoft: the checks are tested with tokens the tests sign.
- A Discord account is its user id (a snowflake), never its username; a LinkedIn account is
  the `sub` of its ID token, which LinkedIn issues per application; its address is read
  from LinkedIn's userinfo endpoint, in an answer that must carry the same `sub`. Neither
  adapter was run against the provider.
- No provider token is stored. Credentials are sealed with `TULA_MASTER_KEY` and never
  returned.
- Connecting an account needs a recent sign-in ([step-up](two-step-verification.md)).
  Connecting and disconnecting are in the audit log and announced to the user by email.

## SDK calls

`<SignIn>` and `<SignUp>` show the buttons by themselves. The provider is told where the
callback page is (`oauthCallbackUrl`, in the layout shown under
[emailed link](email-link.md#sdk-calls)), and that page renders one component:

<!-- snippet: examples/nextjs-app-router/app/oauth/callback/page.tsx -->
```tsx
import { OAuthCallback } from '@tula/nextjs'

/**
 * Where "Continue with …" and "Connect …" come back to (`oauthCallbackUrl` in the layout).
 * The provider returns the visitor to the API's own host, which sends them here with a
 * one-time ticket in the URL fragment; the component exchanges it through the route handler,
 * so the session's cookies are this app's. The visitor is not signed in yet when they arrive,
 * so the proxy leaves this route public.
 *
 * In a deployed app this exact URL is listed in the environment's `urls.allowedRedirectUrls`;
 * a local API allows any loopback URL.
 */
export default function OAuthCallbackPage() {
  return <OAuthCallback userProfileUrl='/profile' />
}
```
<!-- /snippet -->

`@tula/core`:

<!-- snippet: examples/docs-snippets/core.ts#oauth-start -->
```ts
// Keeps a binding for this tab and navigates to the provider.
await tula.signIn.withOAuth({
  provider: 'google',
  redirectUrl: `${location.origin}/oauth/callback`,
})
```
<!-- /snippet -->

<!-- snippet: examples/docs-snippets/core.ts#oauth-callback -->
```ts
// On /oauth/callback, on every load:
const outcome = await tula.signIn.handleOAuthCallback()
switch (outcome.status) {
  case 'complete': // signed in
    break
  case 'needs_step': // outcome.flow.step is needs_second_factor or needs_factor_enrolment
    break
  case 'linked': // a link started with tula.user.identities.link(): outcome.identity
    break
  case 'different_browser': // this browser did not start it; nothing was completed
    break
  case 'error': // outcome.code: 'oauth.account_exists', 'oauth.access_denied', …
    break
  case 'none': // no OAuth answer in the address
    break
}
```
<!-- /snippet -->

<!-- snippet: examples/docs-snippets/core.ts#oauth-identities -->
```ts
const identities = await tula.user.identities.list()
await tula.user.identities.link({
  provider: 'github',
  redirectUrl: `${location.origin}/oauth/callback`,
})
```
<!-- /snippet -->

### From a native app, with Google's ID token

An Android or iOS app that uses Google's own account sheet gets an ID token from Google's
SDK and hands it over, with no browser and no redirect URL
([what it is](../native-apps.md#signing-in-with-google-without-a-browser),
[setup](../providers/google.md#native-sign-in-with-an-id-token)). Google only:

<!-- snippet: examples/docs-snippets/core.ts#id-token-sign-in -->
```ts
// A native client: `ios` or `android`. A `web` client is refused this sign-in.
const app = createTulaClient({
  publishableKey: 'tula_pk_dev_…',
  baseUrl: 'https://auth.example.com',
  client: 'android',
})
// 1. Start: the server makes the nonce. It is good for this one sign-in.
const pending = await app.signIn.withIdToken({ provider: 'google' })
// 2. Ask Google's SDK for an ID token that carries that nonce, as it is
//    (Credential Manager's `setNonce`, GoogleSignIn-iOS's `nonce:`).
const idToken = await askGoogle(pending.nonce)
// 3. Hand the token over. It is sent once, in a request body, and not kept.
const flow = await pending.exchange(idToken)
// flow.step.status is 'complete' (signed in), or 'needs_second_factor' /
// 'needs_factor_enrolment', answered on the same flow as after any sign-in.
```
<!-- /snippet -->

Every refusal of the token is `auth.invalid_credentials`, and each start is good for one
token: on a refusal, start again and ask Google again. The account-level refusals of the
table below (`oauth.account_exists`, `oauth.email_unverified`) are the same as in a
browser.

`@tula/expo`: the provider's page opens in the system browser and comes back to the
app's custom scheme or app link; the ticket is exchanged with a binding the app keeps in
memory ([expo.md](../expo.md#sign-in-with-a-provider)). Not run on a device yet.

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

Reference: [`@tula/core`](../reference/core.md), [`@tula/react`](../reference/react.md),
[`@tula/nextjs`](../reference/nextjs.md), [`@tula/expo`](../reference/expo.md).

## Troubleshooting

| Code | What it means and what to do |
| --- | --- |
| `oauth.provider_error` | The provider refused the exchange. With a correct redirect URI this is usually a wrong client secret. `tula doctor` prints the redirect URI each enabled provider needs. |
| `oauth.access_denied` | The user cancelled at the provider. |
| `oauth.state_invalid` | The callback's `state` is unknown, used or expired: the user took too long or reloaded the provider's redirect. Start again. |
| `oauth.ticket_invalid` | The ticket was used or is older than 60 seconds. Start again. |
| `oauth.different_browser` | The callback page was opened in a tab that did not start the sign-in. |
| `oauth.email_unverified` | The provider does not vouch for the address. The user verifies it at the provider. |
| `oauth.email_missing` | The provider returned no address (GitHub with every address hidden). |
| `oauth.account_exists` | A Tula account has this address and cannot be linked automatically. The user signs in another way and connects the provider in the account page. |
| `oauth.identity_in_use` | That provider account is connected to another user. |
| `oauth.already_linked` | The user already has an account of this provider connected. |
| `identity.last_sign_in_method` | Disconnecting would leave the account with no way to sign in. |
| `request.redirect_not_allowed` | The callback page is not in `urls.allowedRedirectUrls`. |
| `link.cross_origin` | `redirectUrl` is not on the page's own origin (a client code: nothing was sent). |
| `auth.method_disabled` | The provider is not enabled for this environment. |

`redirect_uri_mismatch` (or its equivalent) on the provider's own page means the URI
registered there differs from `callbackUrl`: usually `http` against `https`, or a trailing
slash.
