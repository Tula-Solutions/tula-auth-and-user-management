# Sign in with Google: setup checklist

> **Not verified against the live console.** Nothing in this repository has real credentials
> for this provider: the flow is tested against the API's built-in mock provider. The redirect
> URI and the scopes below are what the code sends; the console steps are written from the
> provider's documentation and have not been clicked through.

What an operator does once per environment. Tula never ships shared credentials: each
environment uses its own ([ADR 0026](../adr/0026-oauth.md)).

1. **Find the redirect URI.** `GET /v1/admin/oauth-providers` lists it as `callbackUrl`. It is
   exactly `PUBLIC_URL/v1/oauth/callback/google`, for example
   `https://auth.example.com/v1/oauth/callback/google`. It is on the Tula API, not on your app.
2. **Create the OAuth client** in the Google Cloud console (APIs & Services → Credentials →
   Create credentials → OAuth client ID → *Web application*).
   - *Authorized redirect URIs*: the `callbackUrl`, character for character (scheme, host, no
     trailing slash).
   - *Authorized JavaScript origins*: none needed. The browser never talks to Google's token
     endpoint.
3. **Configure the consent screen**: app name, support email, and the scopes `openid`, `email`
   and `profile` (the only ones Tula asks for). Publish it, or add test users while it is in
   testing.
4. **Give Tula the credentials**:
   ```bash
   curl -X PUT "$TULA_URL/v1/admin/oauth-providers/google" \
     -H "Authorization: Bearer $TULA_SECRET_KEY" -H 'content-type: application/json' \
     -d '{ "clientId": "<client id>.apps.googleusercontent.com", "clientSecret": "<client secret>" }'
   ```
   The secret is stored encrypted and never returned. Send `"enabled": false` to store it
   without offering it yet.
5. **Allow your app's landing page**: add the page that renders `<OAuthCallback>` (for example
   `https://app.example.com/oauth/callback`) to `urls.allowedRedirectUrls`, exactly.

## Native sign-in with an ID token

> **Not verified against Google.** No test makes a request to Google, and no Android or
> iOS app has been run against this. What follows is what the server checks, and what
> Google's documentation says the platforms send; [ADR 0045](../adr/0045-native-id-token-exchange.md)
> lists what is unconfirmed.

An Android or iOS app can sign in with Google's own account sheet (Credential Manager,
Google Sign-In for iOS) instead of a browser tab. Google's SDK hands the app an **ID
token**; the app hands it to Tula, which verifies it and signs the user in. There is no
redirect URL to allow and no client secret on the device.

1. **Create an OAuth client ID per app** in the same Google Cloud project as the web
   client above: one of type *Android* (package name and signing certificate's SHA-1) and
   one of type *iOS* (bundle ID). The web client of step 2 stays: the browser flow uses
   it, and on Android it is what the app asks tokens for.
2. **Tell Tula which client IDs are yours.** The web client ID is the provider's
   `clientId`. The others go in `additionalClientIds`:
   ```bash
   curl -X PUT "$TULA_URL/v1/admin/oauth-providers/google" \
     -H "Authorization: Bearer $TULA_SECRET_KEY" -H 'content-type: application/json' \
     -d '{ "clientId": "<web client id>.apps.googleusercontent.com",
           "additionalClientIds": ["<android client id>.apps.googleusercontent.com",
                                   "<ios client id>.apps.googleusercontent.com"] }'
   ```
   The request replaces the provider's record: leave `clientSecret` out to keep the stored
   one, and **send the whole list every time** (a request without it stores none). At most
   eight, each once, and **not the web client ID itself** (it is accepted already; listing
   it again is refused). They are not secrets. In the dashboard it is the field under the
   client ID on Google's card; in `tula.config.ts` it is
   [`providers.google.additionalClientIds`](../config.md).

   A token is accepted when its audience (`aud`) is one of these client IDs and, if it
   names the app that asked (`azp`), that is one of them too. List the client ID of every
   app that signs in, whichever of the two Google puts it in.

   **Adding a client ID widens who can sign in**: every token Google makes for that client
   ID becomes a sign-in. The audit log records the change as one that weakens security, the
   dashboard asks first, and `tula apply --yes` needs `--allow-weaker`. List only client
   IDs of your own project.
3. **In the app**, start the sign-in, give Google's SDK the nonce, and hand the token back
   ([the calls](../methods/oauth.md#from-a-native-app-with-googles-id-token)):
   - Android: `GetGoogleIdOption.Builder().setServerClientId(<web client id>).setNonce(nonce)`.
   - iOS: the `GIDSignIn` sign-in call that takes a `nonce:` (GoogleSignIn-iOS 9.0.0 or
     later), with `GIDConfiguration(clientID: <ios client id>, serverClientID: <web client
     id>)`.

   The nonce is passed **as the server gave it**. It is good for one sign-in: ask for a
   new one each time, and do not reuse a token Google handed you earlier.

What goes wrong here is always the same answer, `auth.invalid_credentials`, whatever was
wrong with the token: the server does not tell a caller why. The server's log says which
of four it was (`a native ID token was refused`, with `failure`):

| `failure` | What to look at |
| --- | --- |
| `invalid_token` | The token is for a client ID that is not listed (`aud` or `azp`), is expired, was not signed by Google, or carries another nonce: the app passed a nonce of its own, changed it, or was handed a token Google had cached. |
| `nonce_used` | A token was already presented for this sign-in. Each start is good for one token: start again. |
| `invalid_profile` | The token has no subject. |
| `unavailable` | Google's keys could not be had: no answer in time, a request that failed, or an answer that is not Google's key set (check that the server can reach `https://www.googleapis.com/oauth2/v3/certs`). The app gets `service.unavailable` (503), not a failed sign-in: the token was not judged. |

After a `service.unavailable` the sign-in's nonce is used up, like after any other token:
**the app starts a new sign-in** (a new nonce, a new token from Google's SDK) and does not
send the same token again. A token that names a key Google's key set does not have is
`invalid_token`, not `unavailable`.

A start from a client that is not `ios` or `android` is refused (`validation.failed`), and
with Google switched off both steps answer `auth.method_disabled`.

## What goes wrong in the browser flow

`redirect_uri_mismatch` at Google means step 2's URI differs from
`callbackUrl` (often `http` vs `https`, or a trailing slash). `oauth.provider_error` in the app
with a correct URI usually means a wrong client secret. A Google account whose address Google
does not assert verified is refused (`oauth.email_unverified`).
