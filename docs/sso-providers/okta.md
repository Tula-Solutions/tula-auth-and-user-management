# Single sign-on with Okta: setup checklist

> **Not verified against the live console.** Nothing in this repository has an Okta tenant. The
> values Tula gives Okta, and the attribute names Tula reads, are what the code does and are
> tested against the built-in mock provider. The steps in Okta's admin console are **not
> verified** until TULA-152; where a step names a screen
> it is a pointer to the vendor documentation, not a transcription.

<!-- Vendor docs, checked to resolve on 2026-11-03 (page content not compared):
     SAML app integration: https://help.okta.com/en-us/content/topics/apps/apps_app_integration_wizard_saml.htm
     OIDC app integration: https://help.okta.com/en-us/content/topics/apps/apps_app_integration_wizard_oidc.htm -->

The guide is [Enterprise single sign-on: the guide](../enterprise-sso.md); this page is the Okta
column. Vendor documentation: Okta's [SAML](https://help.okta.com/en-us/content/topics/apps/apps_app_integration_wizard_saml.htm)
and [OIDC](https://help.okta.com/en-us/content/topics/apps/apps_app_integration_wizard_oidc.htm)
app integration pages.

## SAML

:::steps

### Create the connection in Tula first

Create a draft connection with `attributeMapping: { idp: 'okta' }` (the snippet in the
[guide](../enterprise-sso.md#create-the-connection)); its answer holds the values below. Okta's
metadata is needed to create it, so the usual order is: create the Okta app with placeholder values,
copy Okta's metadata URL into Tula, then correct Okta's values with the ones Tula shows.

### Paste these into Okta

| Okta field | Value |
| --- | --- |
| Single sign-on URL (ACS) | `saml.acsUrl`: `PUBLIC_URL/v1/environments/<environment id>/sso/saml/<connection id>/acs` |
| Audience URI (SP entity ID) | `saml.spEntityId`: the same address with `/metadata` instead of `/acs` |
| Name ID format | `EmailAddress` (SP metadata at `saml.spMetadataUrl` also says so) |
| Response / assertion signature | **Assertion must be signed**; RSA with SHA-256 |
| Assertion encryption | Off (an encrypted assertion is refused) |
| Binding | HTTP-POST for the response |

Tula compares the response's `Destination` and `Recipient` with the ACS address, so it must be the
value above, character for character.

### Send these attributes

With the `okta` preset Tula reads these SAML attributes; name them exactly:

| Field | Attribute name |
| --- | --- |
| Email | `email` |
| First name | `firstName` |
| Last name | `lastName` |
| Groups | `groups` |

Send only the groups that are mapped to roles (how Okta filters them: not verified). To use other names, set `attributeMapping.email` (and the like) on the connection.

### Give Tula Okta's metadata

Use the app's metadata URL (`saml.metadataUrl`) or its XML (`saml.metadataXml`). Only the signing
certificates are taken. When Okta rotates its certificate, keep both on the connection until Okta signs
with the new one ([rotation](../methods/sso.md#saml)).

### Test, then activate

Run the test sign-in with an Okta user whose address is on a verified domain of the connection; it
shows the attributes and groups Okta sent. Activate once it passes.

:::

## OIDC

:::steps

### Create the OIDC web app in Okta

Application type *Web*, sign-in redirect URI `PUBLIC_URL/v1/sso/callback/<connection id>` (the
connection id is in the answer of the create call). Tula asks for the scopes `openid email profile`.

### Give Tula the issuer and the client

| Tula field | Value |
| --- | --- |
| `issuer` | Okta's issuer, `https://<your-org>.okta.com` (or the custom authorization server's address) (not verified) |
| `clientId`, `clientSecret` | From the Okta app. The secret is sealed and never returned. |

### Groups

With the `okta` preset the `groups` claim is read. Okta puts it in the ID token only when a groups
claim is configured on the authorization server (not verified); the test sign-in lists what arrived.

:::

## Provisioning

Okta can also push users and groups to Tula: [SCIM provisioning](../scim.md#okta).
