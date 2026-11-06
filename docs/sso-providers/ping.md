# Single sign-on with Ping Identity: setup checklist

> **Not verified against the live console.** Nothing in this repository has a Ping environment.
> The values Tula gives Ping and the names Tula reads are what the code does, tested against the
> built-in mock provider. Ping's console steps are **not verified**, and no Ping
> documentation page was checked, so no vendor deep link is given.

<!-- Vendor docs: https://docs.pingidentity.com/ (a guessed deep link, .../p1_add_saml_app.html,
     answered 404 on 2026-11-03, so none is used). Look up "add a SAML application" and "add an
     OIDC web application" for PingOne. -->

The guide is [Enterprise single sign-on: the guide](../enterprise-sso.md); this page is the Ping
column.

## SAML

:::steps

### Create the connection in Tula

Create a draft connection with `attributeMapping: { idp: 'ping' }`; give it Ping's metadata
(`saml.metadataUrl`, `saml.metadataXml`, or the entity id, SSO URL and certificate as values). The
answer holds the values below.

### Paste these into Ping

| Ping setting | Value |
| --- | --- |
| SP entity ID | `saml.spEntityId`: `PUBLIC_URL/v1/environments/<environment id>/sso/saml/<connection id>/metadata` |
| ACS URL | `saml.acsUrl`: the same address ending `/acs` |
| Binding | HTTP POST |
| NameID format | Email address |
| Signing | Sign the **assertion**, RSA with SHA-256 |
| Encryption | Off |

### Send these attributes

With the `ping` preset Tula reads these SAML attributes:

| Field | Attribute name |
| --- | --- |
| Email | `mail` |
| First name | `givenName` |
| Last name | `sn` |
| Groups | `memberOf` |

### Test, then activate

Run the test sign-in with a user who may use the application; activate once it passes.

:::

## OIDC

Redirect URI `PUBLIC_URL/v1/sso/callback/<connection id>`, scopes `openid email profile`; give Tula the
`issuer`, `clientId` and `clientSecret` Ping shows for the application (where: not verified). With the
`ping` preset the `email`, `given_name`, `family_name` claims and a **`memberOf`** groups claim are
read (the OIDC groups claim of this preset is `memberOf`, not `groups`). The test sign-in shows which
of them Ping sent.
