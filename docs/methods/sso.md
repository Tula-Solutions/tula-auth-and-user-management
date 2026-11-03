# Enterprise single sign-on (OIDC)

A company signs its people in through its own identity provider (Okta, Entra ID, Google Workspace,
any OpenID Connect provider). An operator registers one **connection** per organization; people whose
email is on one of its domains are sent to the provider. The reasoning (the SAML and OIDC split, the
matching table, why discovery is by domain) is in [ADR 0067](../adr/0067-enterprise-sso.md). This page
covers OIDC; SAML builds on the same connection.

## Switch it on

1. Turn the section on: `sso.enabled: true` in the environment's settings (off by default). Organizations
   must be on too.
2. Verify the organization's domain, then create a connection with the admin API (a secret key):

```bash
curl -X POST "$TULA_API_URL/v1/admin/sso-connections" \
  -H "Authorization: Bearer $TULA_SECRET_KEY" -H 'content-type: application/json' \
  -d '{"organizationId":"<org id>","name":"Acme Okta","issuer":"https://acme.okta.com",
       "clientId":"<client id>","clientSecret":"<client secret>","domains":["acme.com"]}'
```

3. Give the provider the redirect URI `PUBLIC_URL/v1/sso/callback/<connection id>`.
4. `PATCH` the connection to `status: "active"`. A connection moves draft, active, disabled and never back
   to a draft. One active connection per domain.

The client secret is sealed and never returned. The issuer is checked when you save it and again on every
call: the server refuses a private or loopback address (Outbound rules).

## What the user sees

They type their work address. For an address on a bound domain the step offers the `sso` first factor and
the sign-in goes to the provider; on return the attempt completes like any other. A new user is created
just in time, marked as managed by the connection, with the connection's default role. The session's `amr`
holds `sso` and its token carries the `sso_conn` claim.

## Security properties and limits

- Home-realm discovery is by domain, never by account: a known and an unknown address on the domain get the
  same answer.
- PKCE, `state` and `nonce` are held in the attempt; the ID token's issuer, audience, `azp`, nonce and expiry
  are checked. Discovery and the key set are cached and fetched again once for an unknown `kid`.
- Matching: a known (connection, subject) first; then an account with the address on the connection's
  domains; otherwise a new user; an address outside the domains is refused.
- Rate-limited per IP and per connection. A new sign-in device is announced as usual.
- Activating a connection widens who can sign in and is audited as a weakening.

## SDK calls

`@tula-tech/admin` manages connections (the `/v1/admin/sso-connections` operations). Starting the `sso` step is
`POST /v1/client/sign-ins/:attemptId/sso`, which returns `authorizationUrl` and a binding. In
`@tula-tech/core` it is `flow.startSso({ redirectUrl })`: it keeps the binding in the tab's session
storage (the OAuth round trip's own key and rules) and navigates to the provider, and the page at
`redirectUrl` finishes with `signIn.handleOAuthCallback()`. The Swift, Kotlin and Expo clients arrive with
TULA-142. `<SignIn>` offers "Continue with SSO" when the step offers `sso`, and shows only that (no password
field) when it is the only strategy; `oauthCallbackUrl` on the provider names the return page, as for
a provider sign-in, and `@tula-tech/nextjs` needs nothing more than its callback page. The words are
`signIn.sso` (the button and the title) and `signIn.ssoPrompt` (the line under the title) in the
localization table; no new element name is added (the other ways to sign in are the `alternatives` element). The
mock provider (`OAUTH_MOCK_PROVIDER=true`) serves a
mock identity provider at `/v1/dev/sso` for tests.

## Troubleshooting

| Code | Meaning |
| --- | --- |
| `sso.disabled` | `sso.enabled` is off. |
| `sso.domain_not_verified` / `sso.domain_taken` | The domain is not the organization's verified domain, or another active connection serves it. |
| `sso.issuer_not_allowed` | The issuer is not an address the server may call. |
| `sso.invalid_transition` / `sso.connection_in_use` | Wrong status change, or delete of a connection that signed users in: disable it. |
| `sso.provider_error` | The provider's token was refused (issuer, audience, nonce, expiry, PKCE). See the logs. |
| `sso.email_domain_mismatch` | The address is outside the connection's domains. |
| `sso.user_not_provisioned` | An unverified account with that address exists and is not linked into. |
