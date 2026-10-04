# @tula/react example (Vite)

A small React 19 app whose authentication is only `@tula/react`: `<SignUp>` with the live
password checklist, `<SignIn>` with forgotten password and, where the environment enables them,
an emailed code or link, `<EmailLinkCallback>` on `/auth/link`, `<UserButton>` and
`<UserProfile>`, behind `<SignedIn>` / `<SignedOut>`. The app itself adds a header, its routes
and a theme switch (`src/app.tsx`).

It is also what the browser tests drive (`e2e/`).

## Run it against a local API

From the repository root, with Docker running:

```bash
cp .env.example .env                 # once; set TULA_MASTER_KEY (openssl rand -hex 32)
docker compose up -d                 # Postgres, Redis, Mailpit (http://localhost:8025)
bun run db:migrate
bun run seed                         # prints the development environment's id
bun run api-key:create --environment <development environment id> --kind publishable
bun run dev                          # the API on http://localhost:3003
```

Then, in another terminal:

```bash
VITE_TULA_PUBLISHABLE_KEY=tula_pk_dev_… bun run --filter @tula/example-react-vite dev
```

Open <http://localhost:5174>. Emailed codes arrive in Mailpit. `VITE_TULA_API_URL` points the
app at another API (default `http://localhost:3003`); `.env.example` lists both. The key is
only ever passed in from outside: none is committed.

With `ENVIRONMENT=local` the API accepts any `http://localhost:<port>` origin. In another tier,
add `http://localhost:5174` to the environment's `urls.allowedOrigins` first.

## Signing in by email

Switch the methods on for the environment (the secret key is the one `api-key:create --kind
secret` printed; a `PUT` replaces the whole settings document, so send the rest of it too):

```bash
curl -si http://localhost:3003/v1/admin/settings -H "Authorization: Bearer $TULA_SECRET_KEY"   # note the ETag
curl -s -X PUT http://localhost:3003/v1/admin/settings \
  -H "Authorization: Bearer $TULA_SECRET_KEY" -H 'If-Match: "0"' -H 'content-type: application/json' \
  -d '{"signIn":{"methods":{"password":{"enabled":true},"emailCode":{"enabled":true},"emailLink":{"enabled":true}}},"signUp":{"password":"optional"}}'
```

The sign-in page then offers "Email me a code" and "Email me a link" under the password, and
sign-up accepts an empty password. The link leads to `/auth/link` in this app. With
`ENVIRONMENT=local` that URL needs no set-up; anywhere else add the whole URL to
`urls.allowedRedirectUrls`. Open the link from Mailpit **in the same browser**: the tab you
started in signs itself in. Opened in another browser (or a private window) it says "Open this
link where you started" and signs nobody in, which is the point
([ADR 0024](../../docs/adr/0024-email-sign-in.md)). The app's config is cached by the browser
for a minute, so a settings change can take that long to show.

## Signing in with a provider

`/oauth/callback` renders `<OAuthCallback>`, and the provider is given
`oauthCallbackUrl='/oauth/callback'`, so `<SignIn>` and `<SignUp>` show a "Continue with …"
button for every provider the environment has enabled, and the account page shows "Connected
accounts". Without real OAuth credentials, start the API with `OAUTH_MOCK_PROVIDER=true`
(local tier only) and enable a provider with any client id and secret:

```bash
curl -X PUT http://localhost:3003/v1/admin/oauth-providers/google \
  -H "Authorization: Bearer $TULA_SECRET_KEY" -H 'content-type: application/json' \
  -d '{ "clientId": "local", "clientSecret": "local" }'
```

"Continue with Google" then leads to a consent page on the API where you type the address the
"provider" reports. For real providers see [docs/providers](../../docs/providers).

## Two-step verification

Open **Manage your account** and turn it on under "Two-step verification": scan the QR code
with an authenticator app (or type the setup key), enter the code, save the backup codes. The
next sign-in asks for the code. To make it mandatory, send `"mfa": { "policy": "required" }`
in the settings document: a user without it then sets it up while signing in. If you lose the
authenticator and the codes, reset the user with the secret key
(`DELETE /v1/admin/users/<id>/factors`); see [ADR 0025](../../docs/adr/0025-mfa.md).

## Passkeys

Passkeys are off until the environment switches them on. For this app, opened at
`http://localhost:5174`, send these three with the rest of your settings (the `PUT` replaces the
whole document; see [docs/self-host.md](../../docs/self-host.md#passkeys)):

```bash
curl -s -X PUT http://localhost:3003/v1/admin/settings \
  -H "Authorization: Bearer $TULA_SECRET_KEY" \
  -H 'Content-Type: application/json' -H 'If-Match: "0"' \
  -d '{
    "signIn": { "methods": { "password": { "enabled": true }, "passkey": { "enabled": true } } },
    "passkeys": { "rpId": "localhost" },
    "urls": { "allowedOrigins": ["http://localhost:5174"] }
  }'
```

`rpId` is the domain passkeys belong to, and the page's origin must be listed in
`allowedOrigins` **and** be that domain or a subdomain of it, even in the `local` tier. Open the
app at `http://localhost:5174`, not `http://127.0.0.1:5174`: a browser will not use a
`localhost` passkey on another host. Changing `rpId` later orphans the passkeys made under the
old one.

Then: **Manage your account** → "Passkeys" → **Add a passkey**, sign out, and "Sign in with a
passkey" on the sign-in page (no address needed; a browser that supports it also offers the
passkey in the address field's autofill). `<SignIn>` and `<UserProfile>` draw all of it: the
app adds nothing. In a browser without WebAuthn the button is not shown and the section says
so. If the browser's dialog is dismissed the page says so quietly and the button works again.
The config is cached for a minute, so a settings change can take that long to show.

## Browser tests

```bash
bun run e2e:install                  # once: Chromium for Playwright
bun run e2e                          # builds this app, serves it and the API, runs the suite
```

`e2e/server.ts` serves the **real API in process** on memory adapters (port 4318) and this
app's production build (port 4317), and exposes the emails it "sent" to the tests. It refuses
to start without `E2E=1` and is never part of the API image. The suite signs up, verifies,
signs in and out, resets and changes a password, manages sessions from two browsers, completes
sign-up with the keyboard only, signs in with an emailed code, opens a magic link in the same
browser (the starting tab signs in) and in another one (nobody does), signs up without a
password, and runs axe on every screen in light and dark. `passkeys.spec.ts` gives Chromium a
virtual authenticator through the DevTools protocol and registers a passkey, signs in with it
(from the button and from the address field's autofill), uses it as a second factor and for a
step-up, renames and removes it, and shows what a refused ceremony looks like: the browser's
real WebAuthn calls, with a simulated device.

## Screenshots

`docs/` holds the screenshots the package README shows; `bun run e2e:screenshots` regenerates
them.

| | |
| --- | --- |
| ![Sign-up with the live password checklist](docs/sign-up-checklist.png) | ![The emailed code](docs/verification.png) |
| ![Sign-in](docs/sign-in.png) | ![Dark](docs/dark-sign-in.png) |
| ![Account](docs/user-profile.png) | ![Phone](docs/mobile-sign-up.png) |
| ![Other ways to sign in](docs/sign-in-methods.png) | ![An emailed code](docs/email-code.png) |
| ![Waiting for the emailed link](docs/email-link-waiting.png) | ![The link opened in another browser](docs/email-link-other-browser.png) |
| ![Sign-up with an optional password](docs/sign-up-optional-password.png) | ![Waiting for the link, on a phone, dark](docs/mobile-email-link-dark.png) |
| ![Turning two-step verification on](docs/two-step-enrol.png) | ![Backup codes](docs/backup-codes.png) |
| ![The second factor at sign-in](docs/second-factor.png) | ![The step-up dialog](docs/step-up.png) |
| ![A backup code, on a phone, dark](docs/mobile-second-factor-dark.png) | |
| ![Sign-in with the provider buttons](docs/oauth-sign-in.png) | ![The provider buttons on a phone, dark](docs/oauth-mobile-sign-in-dark.png) |
| ![The mock provider's consent page](docs/oauth-mock-provider.png) | ![A callback that got no answer and can be retried](docs/oauth-callback-try-again.png) |
| ![A replayed callback, refused by the API](docs/oauth-callback-replayed.png) | ![A ticket opened in another browser](docs/oauth-ticket-other-browser.png) |
| ![The profile of a user with no password](docs/oauth-profile-passwordless.png) | ![Step-up by emailed code](docs/oauth-step-up-email-code.png) |
| ![Step-up by emailed code, on a phone, dark](docs/oauth-mobile-step-up-email-code-dark.png) | ![A provider sign-in stopped at the second factor](docs/oauth-second-factor.png) |
| ![Sign-in with the passkey button](docs/passkey-sign-in.png) | ![A passkey request that was cancelled](docs/passkey-cancelled.png) |
| ![Passkeys in the account page](docs/passkey-profile.png) | ![Passkeys in the account page, on a phone, dark](docs/passkey-mobile-profile-dark.png) |
| ![The passkey as the second factor](docs/passkey-second-factor.png) | ![Step-up with a passkey](docs/passkey-step-up.png) |

The setup key and backup codes in these pictures belonged to an account in the test fixture's
memory, which is gone when the fixture stops. They never worked anywhere else.
