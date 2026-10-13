# Sign in with LinkedIn: setup checklist

> **Not verified against the live console.** Nothing in this repository has real credentials
> for this provider: the flow is tested against the API's built-in mock provider, against ID
> tokens the tests sign themselves and against userinfo answers the tests write. The redirect
> URI, the scopes and the checks below are what the code does; the portal steps are written
> from LinkedIn's documentation and have not been clicked through. **Try a sign-up with a real
> LinkedIn account before you offer the button** ([Limits](#limits) says what was never seen).

What an operator does once per environment ([ADR 0026](../adr/0026-oauth.md)).

1. **Find the redirect URI.** `GET /v1/admin/oauth-providers` lists it as `callbackUrl`:
   exactly `PUBLIC_URL/v1/oauth/callback/linkedin`.
2. **Create an app** (LinkedIn Developer Portal → My apps → Create app). An app belongs to
   a LinkedIn Page.
3. **Add the product "Sign In with LinkedIn using OpenID Connect"** (the app → Products). It
   is what grants the scopes `openid`, `profile` and `email`.
4. **Add the redirect URL** (the app → Auth → OAuth 2.0 settings → Authorized redirect URLs
   for your app): the `callbackUrl`, character for character.
5. **Copy the client id and the client secret** from the same tab.
6. **Give Tula the credentials**:
   ```bash
   curl -X PUT "$TULA_URL/v1/admin/oauth-providers/linkedin" \
     -H "Authorization: Bearer $TULA_SECRET_KEY" -H 'content-type: application/json' \
     -d '{ "clientId": "<client id>", "clientSecret": "<client secret>" }'
   ```
7. **Allow your app's landing page** in `urls.allowedRedirectUrls`, exactly.

Tula asks for the scopes `openid`, `profile` and `email` and nothing else. The one LinkedIn
API it calls with the access token is the userinfo endpoint, once per sign-in.

## What Tula checks in the token

The **account** comes from the **ID token** LinkedIn returns with the code exchange, verified
against LinkedIn's published keys (`https://www.linkedin.com/oauth/openid/jwks`):

- the signature, `RS256` only;
- `iss`: `https://www.linkedin.com/oauth` or `https://www.linkedin.com`. LinkedIn's discovery
  document names the first and its guide the second; Tula accepts exactly those two;
- `aud`: your client id;
- `exp`.

There is **no nonce** to check: LinkedIn's authorization request takes none and its token is
not documented to carry one.

**The account is the token's `sub`**, which LinkedIn issues per application: the same member
has another `sub` in another app. Never an address. Nothing else of the token is used: not
its `email`, not its names.

## Where the address comes from

Once the token has verified, and not before, Tula reads LinkedIn's userinfo endpoint, where
LinkedIn documents the address: `GET https://api.linkedin.com/v2/userinfo` with the access
token.

- **The answer's `sub` must be the token's `sub`.** An answer about anyone else is refused
  exactly as a token that does not verify is, and nobody is signed in.
- **The address is the answer's `email`**, and whether it is verified its `email_verified`.
- **The name** is the answer's `given_name` and `family_name`, display-only.
- There is one source. The token's own `email`, if it has one, is never used instead.

The read follows no redirect (one would carry the access token along), has a deadline and
stops at 64 KiB. When LinkedIn does not answer it, answers anything but a 2xx, or answers
something that is not a JSON object, the sign-in fails and can be tried again; nothing of
the answer is kept or shown.

The answer is protected by TLS, not by a signature, as GitHub's and Discord's profiles are:
what ties it to the member is the access token LinkedIn issued for this code and the `sub`
check above.

Neither LinkedIn's access token nor its ID token is stored, logged or returned.

## What the address proves

Tula counts a LinkedIn address as verified only when the userinfo answer says
`email_verified: true`, the JSON boolean. Absent, `false`, `"true"` or `1` is unverified.
Then:

- an account Tula already knows by its `sub` signs in, whatever its address says;
- a new account is refused with `oauth.email_unverified` (or `oauth.email_missing` when the
  answer has no address), no user is created, and no existing user is linked.

A signed-in user can connect a LinkedIn account from their profile whatever its address: the
session is the proof there.

## No PKCE and no nonce

LinkedIn's authorization request for this flow takes five parameters (`response_type`,
`client_id`, `redirect_uri`, `state`, `scope`) and its token request five (`grant_type`,
`code`, `client_id`, `client_secret`, `redirect_uri`). None is a PKCE challenge, a verifier
or a nonce, and LinkedIn's discovery document lists no `code_challenge_methods_supported`.
Tula sends none: a parameter a provider does not document proves nothing.

So a LinkedIn authorization code is bound to the sign-in that asked for it only by the
single-use `state` and by your client secret. That is less than every other provider has
(Google and Microsoft have PKCE and a nonce, GitHub and Discord PKCE, Apple a nonce). What it
means in practice: someone who obtains a LinkedIn code issued to your app for **another**
sign-in, together with a `state` of their own that has not been used, could complete their
own sign-in as that LinkedIn account. The redirect URI is registered and exact, the code is
single use and short-lived at LinkedIn, and `state` is 256 random bits, so they would have to
read the victim's redirect on its way to Tula.

## Returning to a native app

A sign-in with LinkedIn that a native app started **cannot return to a custom-scheme redirect
URL** (`com.example.app:/…`): LinkedIn sends no PKCE, and a custom scheme can be claimed by
any app on a device. The start answers `request.redirect_not_allowed` with
`params.reason: provider_without_pkce`. Return to an
[app link](../native-apps.md#returning-to-your-app-after-a-provider-sign-in) instead, which
works for every provider.

## Limits

- Nothing here was run against linkedin.com.
- Which `iss` a real token carries was not observed; Tula accepts the two LinkedIn publishes.
- No real userinfo answer was seen. Three things rest on LinkedIn's documentation alone:
  that the answer's `sub` is the same value as the ID token's (if it is not, **every**
  LinkedIn sign-in is refused), that `email_verified` arrives as a JSON boolean (if it is the
  string `"true"`, nobody can sign **up** with LinkedIn: `oauth.email_unverified`), and that
  the token request returns an access token the endpoint accepts with the three scopes
  above. Each fails closed: nobody is signed in who should not be.
- LinkedIn publishes this sign-in for apps under its own terms; whether your app qualifies
  for the product is LinkedIn's decision.
- The button's mark was drawn without LinkedIn's brand page open: check its shape, its colour
  (`#0A66C2`) and the clear space around it against LinkedIn's brand guidelines before you
  ship.
