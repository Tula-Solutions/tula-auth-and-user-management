# Sign in with Facebook: setup checklist

> **Not verified against the live console.** Nothing in this repository has real credentials
> for this provider: the flow is tested against the API's built-in mock provider and against
> answers the tests write. The redirect URI, the permission and the checks below are what the
> code does; the portal steps are written from Meta's documentation, read on 2026-10-09, and
> have not been clicked through. **Try a sign-up with a real Facebook account before you
> offer the button** ([Limits](#limits) says what was never seen).

**An account made through Facebook has no email address.** Tula asks Facebook for none. Read
[No email address](#no-email-address) before you switch this provider on: it says what such
an account cannot do.

What an operator does once per environment ([ADR 0026](../adr/0026-oauth.md)).

1. **Find the redirect URI.** `GET /v1/admin/oauth-providers` lists it as `callbackUrl`:
   exactly `PUBLIC_URL/v1/oauth/callback/facebook`.
2. **Create an app** at Meta for Developers and add the **Facebook Login** product to it.
3. **Add the redirect URI** (Facebook Login → Settings → Valid OAuth Redirect URIs): the
   `callbackUrl`, character for character.
4. **Copy the app id and the app secret** (App settings → Basic). In Tula the app id is the
   `clientId` and the app secret the `clientSecret`.
5. **Give Tula the credentials**:
   ```bash
   curl -X PUT "$TULA_URL/v1/admin/oauth-providers/facebook" \
     -H "Authorization: Bearer $TULA_SECRET_KEY" -H 'content-type: application/json' \
     -d '{ "clientId": "<app id>", "clientSecret": "<app secret>" }'
   ```
6. **Allow your app's landing page** in `urls.allowedRedirectUrls`, exactly.
7. **Consider switching on "Require App Secret"** (App settings → Advanced). Tula sends the
   proof it asks for with its one Graph API call (below), so the setting does not break
   sign-in, and with it a leaked access token cannot be used against your app.

Tula asks for the permission `public_profile` and nothing else. It does not ask for `email`.
The one Graph API call it makes with the access token is `GET /me?fields=id,name`, once per
sign-in.

## What Tula reads

This is Facebook Login's plain OAuth 2.0 flow ("manually build a login flow"), not its
OpenID Connect one: there is no ID token. After the code exchange Tula reads the current
user from the Graph API and takes two things from the answer:

- **The account is `id`**, the app-scoped user id: a decimal number in a string, one to
  thirty-two digits, no sign and no leading zero. Anything else is refused and nobody is
  signed in. It is **your app's** id for the person: another Facebook app gets another value
  for the same person, so moving to a new Facebook app means every user is a new account.
- **The name** is `name`, display-only, and only for a new account.

Only those two fields are requested, and nothing else of the answer is used. The access token
goes in the `Authorization` header, and the query carries its **`appsecret_proof`** (the
token's HMAC-SHA256 under the app secret, in hex), which Meta documents for calls made from a
server. The read follows no redirect, has a deadline and stops at 64 KiB. When Facebook does
not answer, answers anything but a 2xx, or answers something that is not the object
described, the sign-in fails and can be tried again; nothing of the answer is kept or shown.

Neither the access token nor the proof is stored, logged or returned.

## The Graph API version has to be raised

The profile is read on a pinned Graph API version: `v25.0` (`FACEBOOK_GRAPH_VERSION` in
`apps/api/src/adapters/oauth/facebook.ts`). Meta keeps a version for at least two years and
then stops serving it. **Raising that constant before then is a maintenance task of every
Tula release**: check Meta's changelog for `/me`, `id` and `name` (all three have been stable
for many versions), change the constant, and run the adapter's tests.

The login dialog and the token endpoint are written by the OAuth library Tula uses
(`arctic`), on the version that library was built with (`v16.0` in the release pinned here),
which Tula does not choose. Meta's versioning page says a call to a version that is no longer
usable is answered by the next oldest usable one. It does not say that of the dialog.

## No PKCE and no nonce

Meta's page for this flow documents `client_id`, `redirect_uri`, `state`, `response_type` and
`scope` for the dialog, and `client_id`, `redirect_uri`, `client_secret` and `code` for the
exchange. None is a PKCE challenge, a verifier or a nonce. Meta documents PKCE only for its
OpenID Connect flow (the `openid` scope), which Tula does not use here. Tula sends none: a
parameter a provider does not document proves nothing.

So a Facebook authorization code is bound to the sign-in that asked for it only by the
single-use `state`, and to your app by the app secret and the exact redirect URI. That is
what LinkedIn's has, and less than the providers with PKCE or a nonce. Someone who obtains a
Facebook code issued to your app for **another** sign-in, together with an unused `state` of
their own, could complete their own sign-in as that Facebook account. The redirect URI is
registered and exact, the code is single use, and `state` is 256 random bits, so they would
have to read the victim's redirect on its way to Tula. The ticket Tula's callback then hands
the page is honoured only in the browser that started (as for every provider).

## No email address

Tula takes **no address from Facebook**, and does not ask for the permission that would give
one. Meta's reference describes the `email` field as the primary address listed on the
profile and says nothing of it having been verified, and an address a provider reports is
used to decide which account a sign-in belongs to only when the provider says it is verified.
So:

- **The first sign-in with a Facebook account makes a Tula account with no email address.**
  Later sign-ins with the same app-scoped id are that account.
- **It is never joined to an account that has an address**, whatever address the person has
  at Facebook. Someone who already has an account with you and then chooses "Continue with
  Facebook" gets a second, separate account. A signed-in user can connect their Facebook
  account from their profile instead (the session is the proof there), and then it signs
  them in to that account.

What an account with no address cannot do, today:

- **It receives no security notice.** A new device, a passkey or an authenticator app added
  or removed, a connected account changed: nothing is emailed, because there is nowhere to
  send it. The API logs that the notice was skipped, by user id.
- **It cannot sign in by emailed code or link, and cannot have or reset a password.** An
  administrator's "set password" is refused for it (409).
- **Its Facebook account is its only way to sign in** until it adds a passkey, and cannot be
  disconnected while that is so. If the person loses their Facebook account, they lose this
  one.
- **It cannot step up with a password or an emailed code**, there being neither. Changing how
  the account is protected (adding a passkey or an authenticator app) works for ten minutes
  after signing in (the session profile's `stepUpAfter`), and after that needs a fresh
  sign-in, or the passkey or authenticator once one exists.
- **There is no way to add an address to it.** No route, of the client API or the admin API,
  changes a user's email address today. That is a gap in the product, listed for its owner
  in [what was not verified](../plans/phase-2-unverified.md), not a property of Facebook.

A hook on `before_sign_up` is asked about such a sign-up with `email: null`
([hooks](../hooks.md)); a hook that reads the address has to allow for that. A JWT template
claim taken from the address is left out of its tokens.

## Limits

- Nothing here was run against facebook.com. No real dialog, token or `/me` answer was seen:
  that the Graph API accepts the access token in the `Authorization` header beside an
  `appsecret_proof` in the query, and that `id` arrives as a decimal string, rest on Meta's
  documentation alone. Each fails closed: nobody is signed in who should not be.
- A failed code exchange that Facebook answers in the Graph API's own error format (an
  `error` object, not OAuth's `error` string) is reported as the provider being unavailable,
  not as an invalid code. The person sees the same thing either way: the sign-in did not
  finish and can be started again.
- Whether the login dialog still answers on the library's `v16.0` path was not observed
  (above).
- Meta reviews apps: until yours has been through whatever review Facebook Login requires of
  it, only people with a role on the app may be able to sign in. That is Meta's decision and
  was not tried.
- The button's mark was drawn without Meta's brand page open: check its shape, its colour
  (`#0866FF`) and the clear space around it against Meta's brand guidelines, which also have
  rules for the wording of a Facebook login button, before you ship.
