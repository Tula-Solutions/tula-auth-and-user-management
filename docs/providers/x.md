# Sign in with X: setup checklist

> **Not verified against the live console.** Nothing in this repository has real credentials
> for this provider: the flow is tested against the API's built-in mock provider and against
> answers the tests write. The redirect URI, the scopes and the checks below are what the code
> does; the portal steps are written from X's documentation, read on 2026-10-09, and have not
> been clicked through. **Try a sign-up with a real X account before you offer the button**
> ([Limits](#limits) says what was never seen, and what X may charge).

**An account made through X has no email address.** Tula asks X for none. Read
[No email address](#no-email-address) before you switch this provider on: it says what such
an account cannot do.

What an operator does once per environment ([ADR 0026](../adr/0026-oauth.md)).

1. **Find the redirect URI.** `GET /v1/admin/oauth-providers` lists it as `callbackUrl`:
   exactly `PUBLIC_URL/v1/oauth/callback/x`.
2. **Create an app** in the X developer console, in a project of your account.
3. **Set up user authentication** for the app with **OAuth 2.0**, as a confidential client
   (a web app or an automated app: the kind that has a client secret).
4. **Add the callback URL**: the `callbackUrl`, character for character.
5. **Copy the OAuth 2.0 client id and client secret.** They are not the API key and the API
   key secret of the same app, which belong to OAuth 1.0a and are not used here.
6. **Give Tula the credentials**:
   ```bash
   curl -X PUT "$TULA_URL/v1/admin/oauth-providers/x" \
     -H "Authorization: Bearer $TULA_SECRET_KEY" -H 'content-type: application/json' \
     -d '{ "clientId": "<client id>", "clientSecret": "<client secret>" }'
   ```
7. **Allow your app's landing page** in `urls.allowedRedirectUrls`, exactly.

Tula asks for the scopes `users.read` and `tweet.read`, the two X's reference lists for the
one endpoint it calls, and nothing else. It does not ask for `users.email` or for
`offline.access`. The one X API it calls with the access token is
`GET https://api.x.com/2/users/me`, once per sign-in.

## What Tula reads

X's OAuth 2.0 has no ID token. After the code exchange Tula reads the authenticated user
with the access token and takes two things from the answer:

- **The account is `data.id`**, X's numeric user id: a decimal number in a string, one to
  twenty digits, no sign and no leading zero. Anything else is refused and nobody is signed
  in. **Never the username**: a handle can be changed and then taken by someone else.
- **The name** is `data.name`, display-only, and only for a new account.

The request names no `user.fields`, so X is not asked for anything beyond its default fields,
and nothing else of the answer is used. The read follows no redirect (one would carry the
access token along), has a deadline and stops at 64 KiB. When X does not answer, answers
anything but a 2xx, or answers something that is not the object described, the sign-in fails
and can be tried again; nothing of the answer is kept or shown.

The access token is not stored, logged or returned.

## PKCE

X's authorization request takes a `code_challenge` and a `code_challenge_method`, and its
token request the matching `code_verifier`. Tula sends an S256 challenge of a verifier made
for this sign-in and the verifier on the exchange, so a code issued for one sign-in cannot be
redeemed by another. The client id and secret go in the token request's `Authorization`
header, as X documents for a confidential client. X's code is valid for 30 seconds; Tula
exchanges it at once.

## No email address

Tula takes **no address from X**, and does not ask for the scope that would give one
(`users.email`). An address a provider reports is used to decide which account a sign-in
belongs to, and Tula does that only for an address the provider says is verified in a way
that can be checked. So:

- **The first sign-in with an X account makes a Tula account with no email address.** Later
  sign-ins with the same X id are that account.
- **It is never joined to an account that has an address**, whatever address the person has
  at X. Someone who already has an account with you and then chooses "Continue with X" gets a
  second, separate account. A signed-in user can connect their X account from their profile
  instead (the session is the proof there), and then it signs them in to that account.

What an account with no address cannot do, today:

- **It receives no security notice.** A new device, a passkey or an authenticator app added
  or removed, a connected account changed: nothing is emailed, because there is nowhere to
  send it. The API logs that the notice was skipped, by user id.
- **It cannot sign in by emailed code or link, and cannot have or reset a password.** An
  administrator's "set password" is refused for it (409).
- **Its X account is its only way to sign in** until it adds a passkey, and cannot be
  disconnected while that is so. If the person loses their X account, they lose this one.
- **It cannot step up with a password or an emailed code**, there being neither. Changing how
  the account is protected (adding a passkey or an authenticator app) works for ten minutes
  after signing in (the session profile's `stepUpAfter`), and after that needs a fresh
  sign-in, or the passkey or authenticator once one exists.
- **There is no way to add an address to it.** No route, of the client API or the admin API,
  changes a user's email address today. That is a gap in the product, listed for its owner
  in [what was not verified](../plans/phase-2-unverified.md), not a property of X.

A hook on `before_sign_up` is asked about such a sign-up with `email: null`
([hooks](../hooks.md)); a hook that reads the address has to allow for that. A JWT template
claim taken from the address is left out of its tokens.

## Limits

- Nothing here was run against x.com. No real authorization, token or `/2/users/me` answer
  was seen: that the token endpoint accepts the client id and secret as Basic credentials
  beside a PKCE verifier, and that the answer is `{ "data": { "id", "name", "username" } }`
  with the id as a decimal string, rest on X's documentation alone. Each fails closed.
- **What X charges, and whether this sign-in is available to your app at all, was not
  confirmed.** Read on 2026-10-09:
  - [X's pricing page](https://docs.x.com/x-api/getting-started/pricing) describes
    "pay-per-usage pricing" with "no subscriptions": credits are bought upfront and spent per
    request. It names no free tier. It lists reading a user at $0.010 per resource. **Whether
    that price applies to `GET /2/users/me`, which Tula calls once per sign-in, the page does
    not say.** If it does, every sign-in with X costs you a cent, and a sign-in fails when
    your credits run out. The page carries no date; X has changed its terms often.
  - [X's rate limits](https://docs.x.com/x-api/fundamentals/rate-limits) give
    `GET /2/users/me` 75 requests per 15 minutes **per user** and no per-app limit. A person
    signing in is far below that.
  - [The endpoint's reference](https://docs.x.com/x-api/users/get-my-user) names the two
    scopes and no access level or plan it requires.
  Check your own developer console for what your account is charged and allowed before you
  rely on this provider.
- X's documentation lists `code_challenge` among the authorization parameters; the page read
  did not say in so many words that a confidential client must send it. Tula sends it always.
- The button's mark was drawn without X's brand page open: check its shape, its colour (the
  button's text colour) and the clear space around it against X's brand guidelines before you
  ship.
