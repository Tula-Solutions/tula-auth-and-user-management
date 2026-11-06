# Single sign-on with OneLogin: setup checklist

> **Before you go live:** run the connection's test sign-in with a real OneLogin account in a staging environment. The console steps below point to OneLogin's own documentation.

The guide is [Enterprise single sign-on: the guide](../enterprise-sso.md). Vendor documentation:
OneLogin's [SAML](https://developers.onelogin.com/saml) and
[OpenID Connect](https://developers.onelogin.com/openid-connect) developer pages.

## SAML

:::steps

### Create the connection in Tula

Create a draft connection with `attributeMapping: { idp: 'onelogin' }`; give it OneLogin's metadata
(`saml.metadataUrl` or `saml.metadataXml`). The answer holds the values below.

### Paste these into OneLogin

| OneLogin setting | Value |
| --- | --- |
| Audience (EntityID) | `saml.spEntityId`: `PUBLIC_URL/v1/environments/<environment id>/sso/saml/<connection id>/metadata` |
| ACS (Consumer) URL, and its validator | `saml.acsUrl`: the same address ending `/acs` |
| SAML nameID format | Email |
| Signature | Sign the **assertion**, SHA-256 |
| Encryption | Off |

### Send these attributes

With the `onelogin` preset Tula reads these SAML attributes (OneLogin's own macro-style names):

| Field | Attribute name |
| --- | --- |
| Email | `User.email` |
| First name | `User.FirstName` |
| Last name | `User.LastName` |
| Groups | `memberOf` |

### Test, then activate

Give a user access to the app, run the test sign-in as them and activate once it passes.

:::

## OIDC

Redirect URI `PUBLIC_URL/v1/sso/callback/<connection id>`, scopes `openid email profile`; give Tula the
`issuer`, `clientId` and `clientSecret` OneLogin shows for the application. With the
`onelogin` preset the `email`, `given_name`, `family_name` and `groups` claims are read; the test
sign-in shows which of them OneLogin sent.
