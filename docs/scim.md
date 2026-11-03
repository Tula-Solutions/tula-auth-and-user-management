# SCIM provisioning

An organization's identity provider (Okta, Microsoft Entra ID, and any other that speaks SCIM
2.0) can create, update, deactivate and delete its people in Tula by itself. The design and its
reasons are in [ADR 0067](adr/0067-enterprise-sso.md). SCIM provisions for one
[organization](organizations.md), so it exists only while the environment has
`organizations.enabled` on; while it is off every SCIM route answers 403.

The SCIM routes are called by an identity provider, never by an app, so they are not in the
OpenAPI document and no SDK is generated from them. The routes that manage SCIM tokens are.

## Create a token

A **SCIM token** belongs to one organization and one environment. Create it with a secret key
(`POST /v1/admin/scim-tokens`, body `{ "organizationId": "…", "name": "Okta" }`) or in the
dashboard, on the organization's page. The token looks like `tula_scim_<environment>_…`, is
**shown once**, and is stored only as a hash. List the tokens of an organization with
`GET /v1/admin/scim-tokens?organizationId=…` (the secret is never in the list) and revoke one
with `DELETE /v1/admin/scim-tokens/:id?organizationId=…`.

A SCIM token opens `/v1/scim/v2` and nothing else, and no other key (secret, agent or
publishable) opens `/v1/scim/v2`. Paste it into the identity provider as a bearer token, with
the base URL `https://<your api>/v1/scim/v2`. Each token is limited to 600 requests a minute and
each organization to 1,200 across its tokens.

## What the server supports

| Route | Meaning |
| --- | --- |
| `POST /Users` | Create a user, or link the existing user with that address. |
| `GET /Users` | List, with `startIndex`, `count` (at most 200) and `filter=userName eq "…"` or `filter=externalId eq "…"`. Any other filter is 400 `invalidFilter`. |
| `GET /Users/:id` | Read one. |
| `PUT /Users/:id` | Replace: `active` and `externalId` are applied. |
| `PATCH /Users/:id` | `add`, `replace` and `remove` (any case) on `active` and `externalId`, with a path or an object value. `active` may be a boolean or the string `"True"` or `"False"`, as Entra sends it. Other attributes are accepted and ignored. |
| `DELETE /Users/:id` | Remove the user from the organization. |
| `GET /ServiceProviderConfig`, `/ResourceTypes`, `/Schemas` | Discovery. |

Groups, bulk, sorting and ETags are not supported, and discovery says so. Errors on these
routes are SCIM error documents (RFC 7644) with `application/scim+json`, for example a
duplicate `userName` is 409 with `scimType: "uniqueness"`.

## Whose account it is

A user the directory creates is **managed by the directory** and gets a membership. A user who
already exists is linked only when the address is on a [verified domain](verified-domains.md) of
the organization; otherwise the create is a 409. The user's email is not changed by SCIM, and a
managed user cannot change it from a client.

- **Deactivate** (`active: false`) removes the membership. If the directory manages the user and
  they have no other membership, the account is also banned and its sessions are revoked, so
  the access token is refused at once. Setting `active: true` again restores access.
- **Delete** removes the membership, and deletes the account only if the directory manages it
  and the user has no other membership.
- A user the directory does not manage, or who belongs to another organization, is never banned
  or deleted by SCIM.
- The organization's **last manager** cannot be removed: deactivate and delete answer 409, as
  in [organizations](organizations.md).

Every change is an audit entry whose actor is the `directory` (the token's id), and its event
carries ids and flags only.
