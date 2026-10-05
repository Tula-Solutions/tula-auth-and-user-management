# Sign in with GitHub: setup checklist

> **Not verified against the live console.** Nothing in this repository has real credentials
> for this provider: the flow is tested against the API's built-in mock provider. The redirect
> URI and the scopes below are what the code sends; the console steps are written from the
> provider's documentation and have not been clicked through.

What an operator does once per environment ([ADR 0026](../adr/0026-oauth.md)).

1. **Find the redirect URI.** `GET /v1/admin/oauth-providers` lists it as `callbackUrl`:
   exactly `PUBLIC_URL/v1/oauth/callback/github`.
2. **Create an OAuth app** (GitHub → Settings → Developer settings → OAuth Apps → New OAuth
   App; for an organisation, under the organisation's settings).
   - *Authorization callback URL*: the `callbackUrl`, character for character.
   - *Homepage URL*: your app.
   A GitHub App also works, with "Request user authorization (OAuth) during installation" and
   the *Email addresses: read-only* account permission.
3. **Generate a client secret** on the app's page and copy it at once: GitHub shows it once.
4. **Give Tula the credentials**:
   ```bash
   curl -X PUT "$TULA_URL/v1/admin/oauth-providers/github" \
     -H "Authorization: Bearer $TULA_SECRET_KEY" -H 'content-type: application/json' \
     -d '{ "clientId": "<client id>", "clientSecret": "<client secret>" }'
   ```
5. **Allow your app's landing page** in `urls.allowedRedirectUrls`, exactly.

Tula asks for the scopes `read:user` and `user:email`. It identifies the account by GitHub's
**numeric user id** (never the login name) and uses the account's **primary** email address. A
user whose primary address is not verified at GitHub is refused (`oauth.email_unverified`); one
who hides every address gets `oauth.email_missing`. GitHub's access token is used for those two
reads and then dropped: Tula stores no provider token.
