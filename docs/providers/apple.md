# Sign in with Apple: setup checklist

> **Not verified against the live console.** Nothing in this repository has real credentials
> for this provider: the flow is tested against the API's built-in mock provider. The redirect
> URI and the scopes below are what the code sends; the console steps are written from the
> provider's documentation and have not been clicked through.

What an operator does once per environment ([ADR 0026](../adr/0026-oauth.md)). Needs a paid
Apple Developer account.

1. **Find the redirect URI.** `GET /v1/admin/oauth-providers` lists it as `callbackUrl`:
   exactly `PUBLIC_URL/v1/oauth/callback/apple`. Apple requires `https` and a real domain:
   `localhost` does not work. Use the mock provider locally.
2. **Create an App ID** (Certificates, Identifiers & Profiles → Identifiers) with *Sign in
   with Apple* enabled, if your app has none.
3. **Create a Services ID** (Identifiers → Services IDs). Its identifier, for example
   `com.example.web`, is the **client id**. Enable *Sign in with Apple*, choose the App ID as
   the primary, and under *Website URLs* add:
   - *Domains and subdomains*: the host of `PUBLIC_URL` (for example `auth.example.com`).
   - *Return URLs*: the `callbackUrl`, character for character.
4. **Create a key** (Keys → +) with *Sign in with Apple* enabled for that App ID. Download the
   `.p8` file (Apple offers it once) and note the **Key ID**. Your **Team ID** is at the top
   right of the developer account page.
5. **Give Tula the credentials**. `privateKey` is the `.p8` file's whole text, line breaks
   included:
   ```bash
   jq -n --rawfile key AuthKey_XXXXXXXXXX.p8 \
     '{ clientId: "com.example.web", teamId: "<team id>", keyId: "<key id>", privateKey: $key }' |
   curl -X PUT "$TULA_URL/v1/admin/oauth-providers/apple" \
     -H "Authorization: Bearer $TULA_SECRET_KEY" -H 'content-type: application/json' -d @-
   ```
   A key that is not a P-256 PKCS#8 key is refused at once. The key is stored encrypted and
   never returned; Tula signs a five-minute client secret with it for each sign-in.
6. **Allow your app's landing page** in `urls.allowedRedirectUrls`, exactly.

Things specific to Apple: it sends the browser back with a cross-site **form post**, which the
callback accepts; the user's **name arrives only on the first authorization** (and is not
signed, so Tula reads a display name from it and nothing else); a user may choose a **private
relay address** (`…@privaterelay.appleid.com`), which is a real address, and to deliver mail to
it your sending domain must be registered with Apple (Services → Sign in with Apple for Email
Communication). If your iOS app offers another social sign-in, App Store Review requires it to
offer Sign in with Apple as well.

## Native sign-in with an identity token

> **Not verified against Apple.** No test makes a request to Apple, no token Apple signed
> was ever checked here, and no iOS app has been run against this. What follows is what
> the server checks and what Apple's documentation says the sheet sends;
> [ADR 0047](../adr/0047-native-apple-sign-in.md) lists what is documented, what is a
> convention and what is unconfirmed.

An iOS app can sign in with the system's Sign in with Apple sheet instead of a browser
tab. The sheet hands the app an **identity token**; the app hands it to Tula, which
verifies it and signs the user in. There is no redirect URL and no secret on the device.

1. **Enable Apple for the environment**, as above. The Services ID, the key and the team
   are not read when an app's token is verified, but the provider record is the switch:
   with Apple off, or not configured, the app's sign-in is `auth.method_disabled`.
2. **Enable Sign in with Apple for the app's App ID**, and group the Services ID of step 3
   above with it as its primary App ID. Apple's account id (`sub`) is per developer team:
   with both under one team, a user is the same account on the web and in the app.
3. **Register the iOS app** with Tula ([how](../native-apps.md#register-an-app)): its team
   and its bundle ID. **The bundle ID is what makes a token acceptable**: a token is
   accepted when its audience (`aud`) is the bundle ID of an iOS app registered for the
   environment. There is no other list. With no iOS app registered the sign-in is
   `auth.method_disabled`; removing the app refuses its tokens at once.

   **Registering an iOS app therefore widens who can sign in** wherever Apple is enabled:
   every token Apple makes for that bundle ID becomes a sign-in. It is recorded as a
   change that weakens security, the dashboard asks first, and `tula apply --yes` needs
   `--allow-weaker`, as for every registration. Register only your own apps.
4. **In the app**, start the sign-in, hash the nonce, show the sheet and hand the token
   back ([the calls](../methods/oauth.md#from-an-ios-app-with-apples-identity-token)):
   ```swift
   // nonce: the string the start answered.
   let hashed = SHA256.hash(data: Data(nonce.utf8))
     .map { String(format: "%02x", $0) }.joined()   // lowercase hexadecimal
   let request = ASAuthorizationAppleIDProvider().createRequest()
   request.requestedScopes = [.fullName, .email]
   request.nonce = hashed
   ```
   From the credential the sheet returns, send `identityToken` (as a string) as `idToken`,
   and `fullName?.givenName` / `fullName?.familyName` as `givenName` / `familyName` when
   they are there.

What to know, beyond what the browser flow's notes above say:

- **The nonce is hashed by your app**: the SHA-256 of the nonce's UTF-8 bytes, in
  lowercase hexadecimal, 64 characters. Apple puts the string it is given into the token,
  and the server accepts that one form. A token that carries the nonce itself is refused.
  **If the library you use hashes the nonce for you, pass it the nonce and do not hash
  again**; if it does not, hash. Which one a library does is the first thing to check when
  every sign-in fails.
- **The name is not in the token.** Apple gives it to the app on the first authorization
  only; send it with the exchange then. It names a new account and nothing else.
- **The address may be missing later.** A user who has signed in before is recognised by
  Apple's account id alone. A first sign-in with no address makes no account
  (`oauth.email_missing`): a user who removed the app's access and signs in again is asked
  by Apple afresh.
- A token from a system that reports `nonce_supported: false` is refused.

What goes wrong is `auth.invalid_credentials`, whatever was wrong with the token. The
server's log says which it was (`a native ID token was refused`, with `failure`), as for
[Google](google.md#native-sign-in-with-an-id-token):

| `failure` | What to look at |
| --- | --- |
| `invalid_token` | In order of how often: the nonce was not hashed, or hashed twice, or in upper case; the token is for a bundle ID that is not a registered iOS app of **this** environment (a development build with another bundle ID, an app extension); it is expired; it was not signed by Apple; `nonce_supported` is `false`. |
| `nonce_used` | A token was already presented for this sign-in. Start again. |
| `invalid_profile` | The token has no subject. |
| `unavailable` | Apple's keys could not be had (check that the server can reach `https://appleid.apple.com/auth/keys`). The app gets `service.unavailable` (503) and starts a new sign-in. |

## Returning to a native app

A sign-in with Apple that a native app started **cannot return to a custom-scheme redirect
URL** (`com.example.app:/…`): Apple documents no PKCE and is sent none, and a custom scheme can be claimed by
any app on a device. The start answers `request.redirect_not_allowed` with
`params.reason: provider_without_pkce`. Return to an
[app link](../native-apps.md#returning-to-your-app-after-a-provider-sign-in) instead, which
works for every provider.
