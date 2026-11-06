# Sign in with GitHub: setup checklist

> **Before you go live:** sign up once with a real GitHub account in a staging environment.

What an operator does once per environment.

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

The samples use the setup in [Calling the admin API](../admin-api.md).

<!-- tabs -->
```sh
curl -X PUT "$TULA_API_URL/v1/admin/oauth-providers/github" \
  -H "Authorization: Bearer $TULA_SECRET_KEY" -H 'content-type: application/json' \
  -d '{ "clientId": "<client id>", "clientSecret": "<client secret>" }'
```

<!-- snippet: examples/docs-snippets/oauth-providers.ts#github -->
```ts
await admin.call('updateOAuthProvider', {
  params: { provider: 'github' },
  body: {
    clientId: '<client id>',
    clientSecret: '<client secret>',
  },
})
```
<!-- /snippet -->

<!-- snippet: examples/docs-snippets/python/oauth_providers.py#github -->
```python
body = {
    "clientId": "<client id>",
    "clientSecret": "<client secret>",
}
request = urllib.request.Request(
    f"{API_URL}/v1/admin/oauth-providers/github",
    data=json.dumps(body).encode(),
    headers={
        "Authorization": f"Bearer {SECRET_KEY}",
        "content-type": "application/json",
    },
    method="PUT",
)
urllib.request.urlopen(request).close()
```
<!-- /snippet -->
<!-- /tabs -->

5. **Allow your app's landing page** in `urls.allowedRedirectUrls`, exactly.

Tula asks for the scopes `read:user` and `user:email`. It identifies the account by GitHub's
**numeric user id** (never the login name) and uses the account's **primary** email address. A
user whose primary address is not verified at GitHub is refused (`oauth.email_unverified`); one
who hides every address gets `oauth.email_missing`. GitHub's access token is used for those two
reads and then dropped: Tula stores no provider token.

Tula sends PKCE with every GitHub sign-in: `code_challenge` and `code_challenge_method=S256`
on the authorization request, `code_verifier` on the token request. Nothing has to be switched
on in the OAuth app for it.
