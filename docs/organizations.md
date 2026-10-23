# Organizations

An organization is a group of users who share something: a company, a team, a workspace. A user
can belong to several, holds a **role** in each, and works in one at a time, the **active**
organization of their session. Your backend learns which one, and what the role allows, from
claims in the access token it already verifies. The design and its reasons are in
[ADR 0065](adr/0065-organizations.md); the roles and the permission keys have a page of their own,
[Roles and permissions](roles-and-permissions.md).

Organizations are **off by default**. While they are off every organization route answers
`organization.disabled` (403), reads included, and tokens carry no organization claims, so
turning them on is something you do on purpose.

> [!NOTE]
> What is built today: organizations, memberships, built-in and custom roles, the active
> organization and its token claims, `has()` in Next.js, React and any backend, the admin API,
> and the [MCP server](mcp.md#read-tools-need-an-agent-key-or-a-secret-key)'s tools that read them.
> The dashboard has no organization screens yet. A guide to invitations and verified domains is
> [coming](#coming-invitations-and-verified-domains).

## Turn organizations on

Organizations are an environment setting, under `organizations`, so a dev environment can try
them while production stays as it is.

:::params

| Name | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `enabled` | `boolean` | no | `false` | Switches every organization route on, and puts the active organization's claims in tokens. Switching it off again is a weakening: `tula apply --yes` needs `--allow-weaker`. |
| `allowUserCreated` | `boolean` | no | `false` | Whether a signed-in user may create an organization through `client.organizations.create`. Off, only your server creates organizations (admin API). Turning it on is a weakening. |
| `maxCreatedPerUser` | `number` or `null` | no | `5` | How many organizations one user may create, from 1 to 1000; `null` for no limit. Raising it or removing it is a weakening. |
| `creatorRole` | `string` | no | `admin` | The role a creator gets in the organization they create. |
| `defaultRole` | `string` | no | `member` | The role of someone who joins without being given one. Used by [invitations and verified domains](#coming-invitations-and-verified-domains). |
| `personalAccount` | `boolean` | no | `true` | Whether a user may work outside any organization. With `false`, clearing the active organization is refused with `organization.personal_account_disabled` (409). |

:::

:::tabs{sync="settings"}

#### Settings as code

Write them in `tula.config.ts` and apply with `tula apply` ([Settings as code](config.md)).

<!-- snippet: examples/tula-config/tula.config.ts#organizations -->
```ts
// Organizations (ADR 0065) are off until an environment switches them on; the roles
// below only exist while they are on. The other fields are shown at their defaults,
// except `allowUserCreated`: here a signed-in user may create up to five.
organizations: {
  enabled: true,
  allowUserCreated: true,
  maxCreatedPerUser: 5,
  creatorRole: 'admin',
  defaultRole: 'member',
  personalAccount: true,
},
```
<!-- /snippet -->

#### Admin API

The same settings through `@tula-tech/admin`, with the secret key. The call is made under the
revision that was read, so two writers do not overwrite each other.

<!-- snippet: examples/docs-snippets/organizations.ts#settings-organizations -->
```ts
const { data } = await admin.call('getEnvironmentSettings')
await admin.call('replaceEnvironmentSettings', {
  headers: { 'If-Match': ifMatch(data.revision) },
  body: {
    ...data.settings,
    organizations: {
      ...data.settings.organizations,
      enabled: true,
      // Let a signed-in user create organizations, up to five each.
      allowUserCreated: true,
      maxCreatedPerUser: 5,
    },
  },
})
```
<!-- /snippet -->

:::

> [!WARNING]
> Several of these settings are *weakenings*: they let more people do more. Applying one with
> `tula apply --yes` is refused until you add `--allow-weaker`, and the audit entry of the change
> says `weakened: true`. It records which settings changed, never their values.

## Organizations and the active organization

An organization has a **name** (up to 100 characters, trimmed, no control characters) and a
**slug**: 2 to 48 characters of lower-case letters, digits and single hyphens, unique in the
environment. A slug that is taken answers `organization.slug_taken` (409).

A user creates an organization where you allow it, and becomes a member with the
`creatorRole`. An organization your server creates has no members until you add one with
`addOrganizationMember`. Either way a member is not *in* the organization yet: they choose it
with `setActive`, which replaces the session's access token
with one that carries the organization's claims. Choosing `null` returns to the personal account.

<!-- snippet: examples/docs-snippets/organizations.ts#core-organizations -->
```ts
try {
  const organization = await tula.organizations.create({ name: 'Acme', slug: 'acme' })
  // The access token is replaced with one that carries the organization's claims.
  await tula.organizations.setActive(organization.id)
  // tula.state.organizationId === organization.id

  const { data, activeOrganizationId } = await tula.organizations.list()
  // data[n] has `role` and `permissions`; activeOrganizationId is the one just chosen.

  // `null` is the personal account.
  await tula.organizations.setActive(null)
  return { data, activeOrganizationId }
} catch (error) {
  if (isTulaError(error) && error.code === 'organization.slug_taken') {
    // Ask for another slug.
  }
  throw error
}
```
<!-- /snippet -->

From your server, with the secret key, create an organization and add a member without the user
being involved:

<!-- snippet: examples/docs-snippets/organizations.ts#admin-create-organization -->
```ts
const { data: organization } = await admin.call('createOrganization', {
  body: { name: 'Acme', slug: 'acme' },
})
// The first member holds a role of your choosing: `admin` is built in.
await admin.call('addOrganizationMember', {
  params: { id: organization.id },
  body: { userId, role: 'admin' },
})
```
<!-- /snippet -->

| Call | Route | Who |
| --- | --- | --- |
| `client.organizations.list()` | `GET /v1/client/me/organizations` | The signed-in user: their organizations (the first page), each with their role and its permissions, and the active one. |
| `client.organizations.create({ name, slug })` | `POST /v1/client/me/organizations` | The signed-in user, where `allowUserCreated` is on. |
| `client.organizations.setActive(id \| null)` | `PUT /v1/client/me/organizations/active` | The signed-in user, for an organization they belong to. |
| `listOrganizations`, `createOrganization` | `/v1/admin/organizations` | Your server (secret key). |
| `listOrganizationMemberships`, `addOrganizationMember` | `/v1/admin/organizations/:id/memberships` | Your server (secret key). |

The errors you will meet:

| Code | Status | When |
| --- | --- | --- |
| `organization.disabled` | 403 | Organizations are off for the environment. |
| `organization.not_a_member` | 403 | The user is not a member of the organization. It is the same answer for an organization that does not exist or belongs to another environment, so the answer cannot be used to probe. |
| `organization.creation_disabled` | 403 | `allowUserCreated` is off. |
| `organization.limit_reached` | 403 | The user has created `maxCreatedPerUser` organizations. |
| `organization.slug_taken` | 409 | Another organization has the slug. |
| `organization.member_exists` | 409 | The user is already a member. |
| `organization.role_unknown` | 422 | The role named does not exist. |
| `organization.personal_account_disabled` | 409 | The user cleared the active organization where `personalAccount` is off. |
| `organization.last_manager` | 409 | The change would leave an organization with nobody who can manage its members. |
| `user.last_organization_manager` | 409 | Deleting the user would do the same. |

Every organization keeps at least one member whose role holds `org:sys:memberships:manage`; the
server refuses a removal, a demotion or a user deletion that would break that.

## Reading the organization in your app

Three claims say where a request acts, and they are the only thing your backend needs:

| Claim | Meaning |
| --- | --- |
| `org_id` | The id of the active organization. |
| `org_role` | The user's role key in it. |
| `org_perms` | The permission keys of that role. |

They sit at the top level of the access token, **only while an organization is active**, and all
three or none. They are reserved: they are not under `ext`, and no [JWT template](jwt-templates.md)
or [hook](hooks.md) can set them. A user with no active organization, or an environment with
organizations off, has a token without them, and `has()` answers `false` for everything.

:::tabs{sync="framework"}

#### Next.js

`auth()` reads the session on the server and returns `orgId`, `orgRole`, `orgPermissions` and
`has()`. Put the coarse rule in the proxy, and check again where the data is read.

<!-- snippet: examples/docs-snippets/web/nextjs-proxy.ts#nextjs-proxy -->
```ts
// proxy.ts (middleware.ts before Next.js 16)
export const proxy = tulaMiddleware({
  publicRoutes: ['/', '/pricing'],
  access: [
    // The active organization's role must hold this exact permission key.
    { routes: '/billing(.*)', permission: 'org:billing:read' },
    // Or be this role.
    { routes: '/admin(.*)', role: 'admin' },
  ],
  // Pages go here; an API route or a write gets a 403 JSON error instead.
  forbiddenUrl: '/no-access',
})
```
<!-- /snippet -->

Each rule names routes and either a `permission` or a `role`. A page is sent to `forbiddenUrl`;
an API route or a write gets a `403` JSON error, so a client sees a status and not a redirect
to an HTML page. A rule that is malformed (neither a permission nor a role, a permission outside
the grammar) throws when the proxy is created, not when a user is refused.

<!-- snippet: examples/docs-snippets/web/nextjs-page.tsx#nextjs-has -->
```tsx
// app/billing/page.tsx
export default async function Billing() {
  const { isSignedIn, orgId, orgRole, has } = await auth()
  // The proxy already refused a visitor without the permission; check again, because a page
  // must not depend on a matcher covering it.
  if (!isSignedIn || !has({ permission: 'org:billing:read' })) {
    notFound()
  }
  return (
    <p>
      {orgRole} of {orgId} may read billing.
    </p>
  )
}
```
<!-- /snippet -->

#### React

The hooks are `useOrganizationList()` (the list, the active id, `setActive`, `create`) and
`useOrganization()` (the active organization, the role, the permissions and `has()`).

<!-- snippet: examples/docs-snippets/web/react.tsx#react-switcher -->
```tsx
/** Lists the user's organizations and switches the one the session acts in. */
export function OrganizationSwitcher() {
  const { organizations, activeOrganizationId, setActive, isLoaded, error } = useOrganizationList()
  if (error) {
    return <p role='alert'>Your organizations could not be loaded.</p>
  }
  if (!isLoaded) {
    return <p role='status'>Loading…</p>
  }
  return (
    <ul>
      {organizations?.map((organization) => (
        <li key={organization.id}>
          <button
            type='button'
            aria-pressed={organization.id === activeOrganizationId}
            onClick={() => void setActive(organization.id)}
          >
            {organization.name}
          </button>
        </li>
      ))}
      <li>
        <button type='button' onClick={() => void setActive(null)}>
          Personal account
        </button>
      </li>
    </ul>
  )
}
```
<!-- /snippet -->

<!-- snippet: examples/docs-snippets/web/react.tsx#react-has -->
```tsx
/** A link only members who may read billing see. `has()` decides what to show, not what to allow. */
export function BillingLink() {
  const { organization, has } = useOrganization()
  if (!organization || !has({ permission: 'org:billing:read' })) {
    return null
  }
  return <a href='/billing'>Billing for {organization.name}</a>
}
```
<!-- /snippet -->

> [!IMPORTANT]
> `has()` in the browser decides what to **show**, never what to allow. Anyone can edit what
> runs in their browser. The check that protects data is the one your server makes from the
> verified token.

#### Another backend

Verify the access token as you would any JWT: EdDSA, the environment's keys at the issuer's
`/.well-known/jwks.json`, `iss` the issuer and `aud` the environment's id. Then read the three
claims together.

<!-- snippet: examples/docs-snippets/web/backend.ts#backend-imports -->
```ts
import { hasOrganizationAccess, readOrganizationClaims } from '@tula-tech/contract/custom-claims'
import { environmentIssuer, jwksUrl } from '@tula-tech/contract/issuer'
import { createRemoteJWKSet, jwtVerify } from 'jose'

```
<!-- /snippet -->

<!-- snippet: examples/docs-snippets/web/backend.ts#backend-verify -->
```ts
// The token's `iss` is the environment's URL under the API, and its keys are published at
// the issuer's /.well-known/jwks.json. `createRemoteJWKSet` caches them and refetches when
// a token names a key it has not seen (a signing key was rotated).
const issuer = environmentIssuer('https://auth.example.com', environmentId)
const keys = createRemoteJWKSet(new URL(jwksUrl(issuer)))

/** Verify an access token and return the organization it acts in, or `null`. */
export async function organizationOf(accessToken: string) {
  const { payload } = await jwtVerify(accessToken, keys, {
    algorithms: ['EdDSA'],
    issuer,
    audience: environmentId,
  })
  // `org_id`, `org_role` and `org_perms` come together or not at all: `null` is "no
  // organization is active", and it grants nothing.
  return readOrganizationClaims(payload)
}
```
<!-- /snippet -->

<!-- snippet: examples/docs-snippets/web/backend.ts#backend-has -->
```ts
/** A request handler that lets a member through only if their role holds a permission. */
export async function handleInvoices(request: Request): Promise<Response> {
  const token = request.headers.get('authorization')?.replace(/^Bearer /, '')
  if (!token) {
    return new Response('Unauthorized', { status: 401 })
  }
  const organization = await organizationOf(token).catch(() => null)
  if (!hasOrganizationAccess(organization, { permission: 'org:invoices:read' })) {
    return new Response('Forbidden', { status: 403 })
  }
  return Response.json({ organizationId: organization?.orgId, invoices: [] })
}
```
<!-- /snippet -->

`readOrganizationClaims` returns the three claims together or `null`, and `hasOrganizationAccess`
answers `false` for `null`. Both come from `@tula-tech/contract/custom-claims`, a module with no
dependencies, so it adds nothing to a bundle. A language other than TypeScript does the same by
hand: verify, then look for `org_id`, `org_role` and `org_perms`.

:::

### How fresh the claims are

A role is copied into the token when the token is issued. So a change reaches a signed-in user
**at their next refresh**, within the access token's life (60 seconds by default), and not
before:

- Removing a member, or changing their role, ends their access in that organization the next
  time the token is refreshed. Their session stays; they are simply no longer a member there.
- Giving a role a permission works the same way, which is why it is a weakening.
- A request made with a token that has not yet expired is still judged on that token. The
  window is the access token's life, so a shorter one in the session profile narrows it
  ([Sessions](methods/sessions.md)). A `stateful` session has no access token to carry the
  claims, and its next request carries them.

### The size of the claims

The organization claims are capped at **2,560 bytes**. The grammar allows at most 2,541 bytes, and the largest custom role the roles API accepts
(32 permissions of 69 characters, under a 32-character role key) takes 2,413, so a role you can
create always fits; the built-in `admin` role adds 252 bytes and `member` 110. A typical token without a template is around 720 characters.

Were the claims ever past the cap (a role written into the database by hand), the token is
**issued without any organization claims** and the server logs the environment and the
organization. Your backend then sees no organization, which grants nothing: it fails closed, and
there is no partial list.

> [!NOTE]
> The Next.js SDK stores the access token in up to two cookies (`tula_at` and `tula_at_1`), because
> a token with a large role can be longer than one browser cookie holds (about 4 kB). The
> largest token possible is around 5.3 kB, which two cookies hold. Nothing for you to do; it is
> why a custom role is not free ([JWT templates](jwt-templates.md) count the same way).

## Prebuilt pieces

`@tula-tech/react` does not draw an organization switcher, because the right one depends on
your app. The Tula UI registry has two to copy into your project and own:

| Item | What it draws |
| --- | --- |
| `organization-switcher` | A select of the user's organizations with "Personal account" first, and, where you pass `allowCreate`, a small form that creates an organization and switches to it. |
| `organization-profile` | The active organization's name, short name, creation date, the user's role, what the role allows, and whether they can see or manage the members. |

Both call the hooks above, take their words from the provider's localization (the `organizations`
group of `useLocalization()`, so an app translates them with the rest) and are presentation
only: edit the markup freely. They need `@tula-tech/react` 0.3.0 or later.

```tsx
import { OrganizationProfile } from '@/components/tula/organization-profile'
import { OrganizationSwitcher } from '@/components/tula/organization-switcher'

// Inside <TulaProvider>, for a signed-in user.
<OrganizationSwitcher allowCreate onSwitch={() => router.refresh()} />
<OrganizationProfile />
```

> [!NOTE]
> The registry is not served from a public address yet. Until it is, copy the two files from
> `packages/ui/items` of the repository and the primitives they name (`button`, `card`,
> `input`, `label` and the `status` item) into the project; `shadcn add` works once
> the registry has an address ([ADR 0064](adr/0064-tula-ui.md)).

## Coming: invitations and verified domains

Two ways to join an organization have a page of their own coming, and are only outlined here
([ADR 0065](adr/0065-organizations.md)):

- **Invitations.** A member who may manage invitations invites an email address with a role.
  The invitee gets a single-use link that works for seven days, and joins only with an account
  whose address is verified and matches. The server routes and `client.organizations.invitations`
  in `@tula-tech/core` exist; this guide does not document them yet, so read their JSDoc in the
  [`@tula-tech/core` reference](reference/core.md).
- **Verified domains.** An organization proves it owns an email domain with a code sent to an
  address at it. Users with a verified address there are then offered the organization
  (`suggest`) or join it at once (`auto_join`) with the `defaultRole`. Not built yet.

Until a page covers them, add members from your server with `addOrganizationMember`, or let
users create organizations of their own.

## Not built

These are outside this version on purpose, so that you do not look for them: SAML and SCIM,
billing and plans, settings or branding that differ per organization, nested organizations, DNS
verification of a domain, and native organization screens in the Swift, Kotlin and Expo SDKs.

## See also

- [Roles and permissions](roles-and-permissions.md): the built-in roles, custom roles and the
  `org:<feature>:<action>` keys.
- [JWT templates](jwt-templates.md): the claims beside the organization's.
- [Settings as code](config.md#organization-roles): roles in `tula.config.ts`.
- [MCP server](mcp.md): tools that read organizations, their members and roles.
- [ADR 0065](adr/0065-organizations.md): the decisions behind all of this.
