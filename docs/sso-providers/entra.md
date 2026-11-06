# Single sign-on with Microsoft Entra ID: setup checklist

> **Not verified against the live console.** Nothing in this repository has an Entra tenant. The
> values Tula gives Entra and the claim names Tula reads are what the code does, tested against
> the built-in mock provider. Entra's portal steps are **not verified**.

<!-- Vendor docs, checked to resolve on 2026-11-03 (page content not compared):
     Single sign-on for an enterprise application: https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/add-application-portal-setup-sso
     SCIM provisioning: https://learn.microsoft.com/en-us/entra/identity/app-provisioning/use-scim-to-provision-users-and-groups -->

The guide is [Enterprise single sign-on: the guide](../enterprise-sso.md). Vendor documentation:
[set up single sign-on for an enterprise application](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/add-application-portal-setup-sso).

## SAML

:::steps

### Create the connection in Tula

Create a draft connection with `attributeMapping: { idp: 'entra' }` and Entra's *App Federation
Metadata URL* as `saml.metadataUrl` (or its XML). The answer holds the values below.

### Paste these into Entra

| Entra field | Value |
| --- | --- |
| Identifier (Entity ID) | `saml.spEntityId`: `PUBLIC_URL/v1/environments/<environment id>/sso/saml/<connection id>/metadata` |
| Reply URL (Assertion Consumer Service URL) | `saml.acsUrl`: the same address ending `/acs` |
| Sign-on URL | Leave empty: a sign-in must start at Tula (an IdP-initiated response is refused) |
| Name ID format | Email address |
| Signing | Sign the **assertion**; SHA-256 |
| Assertion encryption | Off |

Entra can import the metadata at `saml.spMetadataUrl` instead of taking the two values by hand.

### Send these claims

With the `entra` preset Tula reads these SAML attributes, which are Entra's default claim names:

| Field | Claim |
| --- | --- |
| Email | `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress` |
| First name | `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname` |
| Last name | `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname` |
| Groups | `http://schemas.microsoft.com/ws/2008/06/identity/claims/groups` |

The email claim must hold a mail address on one of the connection's verified domains (a user principal
name that is not a mailbox address is a common mismatch; the test sign-in reports it as
`email_outside_domains`). Entra may send a group as an object id rather than a name (not verified); in
that case the group-to-role mapping holds the id.

### Test, then activate

Use the test sign-in with a user assigned to the application; activate once it passes.

:::

## OIDC

:::steps

### Register the application in Entra

A web app registration with redirect URI `PUBLIC_URL/v1/sso/callback/<connection id>` and a client
secret. Tula asks for `openid email profile`.

### Give Tula the issuer and the client

| Tula field | Value |
| --- | --- |
| `issuer` | The tenant's v2.0 issuer, `https://login.microsoftonline.com/<tenant id>/v2.0` (not verified) |
| `clientId`, `clientSecret` | The application (client) id and the secret value |

With the `entra` preset the `email`, `given_name`, `family_name` and `groups` claims are read. Entra
puts a `groups` claim in the ID token only when the app registration is configured to (not verified).

:::

## Provisioning

Entra's provisioning service pushes users and groups over SCIM: [SCIM provisioning](../scim.md#microsoft-entra-id).
