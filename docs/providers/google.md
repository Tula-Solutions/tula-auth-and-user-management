# Sign in with Google: setup checklist

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

What goes wrong: `redirect_uri_mismatch` at Google means step 2's URI differs from
`callbackUrl` (often `http` vs `https`, or a trailing slash). `oauth.provider_error` in the app
with a correct URI usually means a wrong client secret. A Google account whose address Google
does not assert verified is refused (`oauth.email_unverified`).
