# Single sign-on with JumpCloud: setup checklist

> **Not verified against the live console.** Nothing in this repository has a JumpCloud
> organization. The values Tula gives JumpCloud and the names Tula reads are what the code does,
> tested against the built-in mock provider. JumpCloud's console steps are **not verified** until
> TULA-152, and no JumpCloud documentation page was checked, so no vendor link is given.

<!-- Vendor docs: JumpCloud's support site, https://support.jumpcloud.com/, answered 503 on
     2026-11-03 when a page was requested; look up "custom SAML application" and "custom OIDC
     application" there. No deep link was verified. -->

The guide is [Enterprise single sign-on: the guide](../enterprise-sso.md); this page is the JumpCloud
column.

## SAML

:::steps

### Create the connection in Tula

Create a draft connection with `attributeMapping: { idp: 'jumpcloud' }`; give it JumpCloud's metadata
(`saml.metadataXml`, or the entity id, SSO URL and certificate as values). The answer holds the values
below.

### Paste these into JumpCloud

| JumpCloud setting | Value |
| --- | --- |
| SP entity ID | `saml.spEntityId`: `PUBLIC_URL/v1/environments/<environment id>/sso/saml/<connection id>/metadata` |
| ACS URL | `saml.acsUrl`: the same address ending `/acs` |
| SAMLSubject NameID format | Email address |
| Signing | Sign the **assertion**, RSA with SHA-256 |
| Encryption | Off |
| Login / IdP-initiated URL | Leave empty (an IdP-initiated response is refused) |

### Send these attributes

With the `jumpcloud` preset Tula reads these SAML attributes (note the lower case):

| Field | Attribute name |
| --- | --- |
| Email | `email` |
| First name | `firstname` |
| Last name | `lastname` |
| Groups | `memberOf` |

### Test, then activate

Assign the application to a user group, run the test sign-in with one of its users and activate once it
passes.

:::

## OIDC

Tula's side is the same for every provider: redirect URI `PUBLIC_URL/v1/sso/callback/<connection id>`,
scopes `openid email profile`, and the `issuer`, `clientId` and `clientSecret` that JumpCloud shows
for the application (where it shows them: not verified). With the `jumpcloud` preset the `email`,
`given_name`, `family_name` and `groups` claims are read; whether JumpCloud includes `groups` in the
ID token is not verified, and the test sign-in shows what arrived.
