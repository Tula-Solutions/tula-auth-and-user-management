# Single sign-on with Google Workspace: setup checklist

> **Not verified against the live console.** Nothing in this repository has a Google Workspace
> tenant. The values Tula gives Google and the attribute names Tula reads are what the code does,
> tested against the built-in mock provider. The steps in the Google Admin console are **not
> verified** until TULA-152.

<!-- Vendor docs, checked to resolve on 2026-11-03 (page content not compared):
     Set up your own custom SAML application: https://support.google.com/a/answer/6087519 -->

The guide is [Enterprise single sign-on: the guide](../enterprise-sso.md). Vendor documentation:
[set up your own custom SAML application](https://support.google.com/a/answer/6087519).

Google Workspace is used here as a **SAML** identity provider only. (This is not the same as
[Sign in with Google](../providers/google.md), the consumer OAuth button.) This page does not cover
provisioning from Workspace to Tula (whether Workspace can push to a custom SCIM endpoint: not
verified), so users are created at their first sign-in; [SCIM](../scim.md) is the way to
provision them from another directory.

:::steps

### Create the connection in Tula

Create a draft SAML connection with `attributeMapping: { idp: 'google_workspace' }`. Google gives
metadata only after the app exists, so create the Google app with placeholders, then give Tula the
metadata (`saml.metadataXml`, or the entity id, SSO URL and certificate as values) and correct
Google's values with the ones Tula shows.

### Paste these into Google

| Google field | Value |
| --- | --- |
| ACS URL | `saml.acsUrl`: `PUBLIC_URL/v1/environments/<environment id>/sso/saml/<connection id>/acs` |
| Entity ID | `saml.spEntityId`: the same address ending `/metadata` |
| Name ID format | `EMAIL` |
| Name ID | The user's primary email |
| Start URL | Leave empty: an IdP-initiated sign-in is refused |
| Signed response | Not needed: Tula requires the **assertion** to be signed |

### Send these attributes

With the `google_workspace` preset Tula reads these SAML attributes:

| Field | Attribute name |
| --- | --- |
| Email | `email` |
| First name | `firstName` |
| Last name | `lastName` |
| Groups | `groups` |

Google maps directory fields to attribute names in the app's attribute mapping, and groups by
membership of named groups (how the console words this: not verified). Name each attribute exactly
as above, or set `attributeMapping.email` and the like to the names you chose.

### Test, then activate

Turn the app *on* for the people who should use it in Google, run the test sign-in with one of them and
activate once it passes.

:::
