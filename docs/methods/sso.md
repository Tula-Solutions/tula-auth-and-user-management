# Enterprise single sign-on (OIDC and SAML)

A company signs its people in through its own identity provider (Okta, Entra ID, Google Workspace,
any OpenID Connect provider). An operator registers one **connection** per organization; people whose
email is on one of its domains are sent to the provider. This page
covers OIDC first and SAML [below](#saml). The path through the whole feature (enforcement, break-glass,
the setup portal, the test sign-in) is [Enterprise single sign-on: the guide](../enterprise-sso.md), and each provider has a
page with the values to paste, from [Okta](../sso-providers/okta.md) to [Ping](../sso-providers/ping.md).

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

## SAML

A SAML connection (`protocol: "saml"`) takes the identity provider's values in a `saml` object instead of
`issuer`, `clientId` and `clientSecret`. Give **exactly one** of: `metadataXml` (the provider's metadata
document), `metadataUrl` (fetched by the server under the Outbound rules and fetched again by
`POST /v1/admin/sso-connections/<id>/refresh-metadata`), or the values themselves (`idpEntityId`, `ssoUrl`
and one or two `certificates`). Only **signing** certificates are taken, at most two; a DTD or an entity in
the metadata is refused (`sso.saml_invalid`).

```bash
curl -X POST "$TULA_API_URL/v1/admin/sso-connections" \
  -H "Authorization: Bearer $TULA_SECRET_KEY" -H 'content-type: application/json' \
  -d '{"organizationId":"<org id>","protocol":"saml","name":"Acme Entra",
       "saml":{"metadataUrl":"https://login.example.com/acme/metadata"},"domains":["acme.com"]}'
```

The answer's `saml` object holds what to give the provider: `spEntityId`, `acsUrl` (HTTP-POST binding) and
`spMetadataUrl`, which serves SP metadata (entity id, the ACS, the `emailAddress` NameID format, signed
assertions wanted) that Okta and Entra can import. It also lists each certificate's fingerprint and expiry.

- **Rotation without downtime:** keep both the old and the new certificate (`certificates` takes two); a
  response signed by either is accepted. Remove the old one once the provider signs with the new.
- The server sends an unsigned redirect-binding request and accepts only a response to a request it made
  (IdP-initiated responses are refused), signed, to this connection's ACS, for this connection's audience,
  once: a replay is refused, also across instances.
- Every refusal reaches the browser as the one `sso.provider_error`; the reason is only in the server log.
  The ACS is rate-limited per IP and per connection.
- The mock provider serves SAML at `/v1/dev/sso/saml/sso` and its metadata at `/v1/dev/sso/saml/metadata`,
  and can be told to produce each failure (`failure=`).

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
`redirectUrl` finishes with `signIn.handleOAuthCallback()`. The Swift, Kotlin and Expo clients do not support it. `<SignIn>` offers "Continue with SSO" when the step offers `sso`, and shows only that (no password
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
| `sso.invalid_transition` / `sso.connection_in_use` | Wrong status change, or delete of an active connection: disable it first. |
| `sso.provider_error` | The provider's token or SAML response was refused (issuer, audience, nonce or request id, signature, expiry, replay). See the logs. |
| `sso.saml_invalid` | A SAML connection's metadata or values were refused: not exactly one source, a DTD, no signing certificate, a certificate that does not parse, or the metadata URL could not be fetched. |
| `sso.email_domain_mismatch` | The address is outside the connection's domains. |
| `sso.user_not_provisioned` | An unverified account with that address exists and is not linked into. |
