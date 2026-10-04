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
