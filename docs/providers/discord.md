# Sign in with Discord: setup checklist

> **Not verified against the live console.** Nothing in this repository has real credentials
> for this provider: the flow is tested against the API's built-in mock provider and against
> stubbed HTTP. The redirect URI, the scopes and the requests below are what the code sends;
> the portal steps are written from Discord's documentation and have not been clicked through.

What an operator does once per environment ([ADR 0026](../adr/0026-oauth.md)).

1. **Find the redirect URI.** `GET /v1/admin/oauth-providers` lists it as `callbackUrl`:
   exactly `PUBLIC_URL/v1/oauth/callback/discord`.
2. **Create an application** (Discord Developer Portal → Applications → New Application).
3. **Add the redirect** (the application → OAuth2 → Redirects): the `callbackUrl`, character
   for character.
4. **Copy the client id and reset the client secret** on the same page. Copy the secret at
   once: the portal shows it once.
5. **Give Tula the credentials**:
   ```bash
   curl -X PUT "$TULA_URL/v1/admin/oauth-providers/discord" \
     -H "Authorization: Bearer $TULA_SECRET_KEY" -H 'content-type: application/json' \
     -d '{ "clientId": "<client id>", "clientSecret": "<client secret>" }'
   ```
6. **Allow your app's landing page** in `urls.allowedRedirectUrls`, exactly.

Tula asks for the scopes `identify` and `email` and nothing else: not `guilds`, not
`connections`, nothing about messages. It needs no bot and no gateway intent.

## What Tula reads

Discord is plain OAuth 2.0, not OpenID Connect: there is no ID token. After the code exchange
Tula reads the current user once (`GET /users/@me`) with Discord's access token and then
drops the token. It is not stored, logged or returned, and Tula does not revoke it either
(as with GitHub): it grants nothing beyond reading the same profile again.

- **The account is the user id**, a snowflake (a decimal number in a string, such as
  `80351110224678912`). Never the username: it can be changed and then taken by someone
  else. An answer whose id is not such a string is refused.
- **The address is the user object's `email`.** It needs the `email` scope, and a Discord
  account may have none.
- **The name** shown in the profile is `global_name`, split at its first space. It is
  display-only and never used to find an account.

## What the address proves

Tula counts a Discord address as verified only when the user object says `verified: true`,
the JSON boolean. Absent, `false`, `"true"` or `1` is unverified. Then:

- an account Tula already knows by its user id signs in, whatever its address says;
- a new account is refused with `oauth.email_unverified` (or `oauth.email_missing` when
  Discord shares no address), no user is created, and no existing user is linked.

A signed-in user can connect a Discord account from their profile whatever its address: the
session is the proof there.

## PKCE

Tula sends PKCE with every Discord sign-in: `code_challenge` and
`code_challenge_method=S256` on the authorization request, `code_verifier` on the token
request, beside the client id and secret (HTTP Basic). **Discord's OAuth2 page does not
mention PKCE.** Tula sends it because the client library it uses (`arctic`'s `Discord`) does
for a confidential client; whether Discord refuses a code presented with another verifier was
never observed here. The requests are checked in unit tests and the flow against the mock
provider, which does refuse one. What binds a Discord code to its sign-in for certain is the
single-use `state` and the client secret.

## Limits

- Nothing here was run against discord.com.
- The profile is read from `https://discord.com/api/v10/users/@me`. The version in that path
  was written from memory of Discord's API reference, not read from it in this change.
- An answer over 64 KiB is not read to its end and is refused; a redirect from the profile
  endpoint is refused (it would carry the token along).
- The button's mark was drawn without Discord's brand page open: check its shape, its colour
  (`#5865F2`) and the clear space around it against Discord's brand guidelines before you ship.
