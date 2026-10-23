# Roles and permissions

A member of an [organization](organizations.md) holds one **role** in it, and a role is a set of
**permissions**. Your code asks whether the active organization's role holds a permission; it
never asks about a person. This page is the grammar of the permission keys, the built-in roles,
how to define your own, and what a check does and does not mean.

## Roles are shared by the environment

A role is defined once, for the whole environment, and every organization uses the same ones.
There is no role that exists in one organization only. That keeps a role's meaning the same
wherever a user meets it, and keeps the token small. If two kinds of customers need different
roles, give them different role keys.

A role has a **key** (what code and tokens use), a **name** (what a person reads) and its
**permissions**.

:::params

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `key` | `string` | yes | Lower-case letters, digits and underscores, starting with a letter, at most 32 characters (`^[a-z][a-z0-9_]{0,31}$`). It cannot be changed: another key is another role. `admin` and `member` are taken. |
| `name` | `string` | yes | The label shown to people. It can change. |
| `permissions` | `string[]` | yes | At most 32 permission keys. A set: order and repeats do not matter, and they are stored sorted. |

:::

## The permission grammar

A permission key is `org:<feature>:<action>`. Each of the three parts starts with a lower-case
letter and then holds lower-case letters, digits and underscores, up to 32 characters in all:

```text
org:billing:read
org:billing:write
org:invoices:export
```

You choose the *feature* and the *action*; Tula does not interpret them. They are the names your
own code checks for. A key is matched **exactly**:

- There are no wildcards. `org:billing:*` is not a key and is refused when a role is saved.
- `manage` does not imply `read`, and `write` does not imply `read`. A role that should do both
  lists both.
- A key with a dot, a space or a capital letter is refused.

### System permissions

The feature `sys` is reserved for Tula's own permissions, which guard what Tula itself does for
an organization. There are six, and no others can be invented:

| Permission | Lets the member |
| --- | --- |
| `org:sys:organization:manage` | Rename the organization. |
| `org:sys:organization:delete` | Delete the organization. |
| `org:sys:memberships:read` | See who the members are. |
| `org:sys:memberships:manage` | Add and remove members and change their roles. |
| `org:sys:invitations:manage` | Invite people. Used when [invitations](organizations.md#invitations-and-verified-domains) arrive. |
| `org:sys:domains:manage` | Manage the organization's verified domains. Used when verified domains arrive. |

A custom role may hold any of these beside its own keys.

## Built-in roles

Every environment has two, and they cannot be edited or deleted:

| Role | Permissions |
| --- | --- |
| `admin` | All six system permissions. |
| `member` | `org:sys:memberships:read`. |

An organization always keeps **at least one member whose role holds
`org:sys:memberships:manage`**. A removal, a demotion, a role change or a user deletion that
would leave none is refused with `organization.last_manager` (409), or, for a user's own
deletion, `user.last_organization_manager`. Without that rule an organization could be left
with nobody able to repair it.

## Custom roles

An environment may define up to 50 custom roles. Define them as code, with the other settings,
or call the admin API.

:::tabs{sync="settings"}

#### Settings as code

Roles are part of `tula.config.ts` ([Settings as code](config.md#organization-roles) has the
rules for managed and unmanaged roles and for `--prune`).

<!-- snippet: examples/tula-config/tula.config.ts#organization-roles -->
```ts
// The custom roles of the environment's organizations (ADR 0065), beside the built-in
// `admin` and `member`. A role is its key; the permissions are a set. Giving a role a
// permission it did not have widens what its members may do, so `tula apply --yes`
// asks for `--allow-weaker`. `dev` has no `organizationRoles` key: its roles are not
// managed by this file.
organizationRoles: [
  {
    key: 'billing_manager',
    name: 'Billing manager',
    permissions: ['org:billing:read', 'org:billing:write', 'org:sys:memberships:read'],
  },
  { key: 'viewer', name: 'Viewer', permissions: ['org:billing:read'] },
],
```
<!-- /snippet -->

#### Admin API

Create a role, then change it. A change needs the `version` you read, sent as `If-Match`: a stale
version is refused (412) and a missing one is too (428), so two administrators do not overwrite
each other.

<!-- snippet: examples/docs-snippets/organizations.ts#admin-define-role -->
```ts
const { data: role } = await admin.call('createOrganizationRole', {
  body: {
    key: 'billing_manager',
    name: 'Billing manager',
    permissions: ['org:billing:read', 'org:billing:write'],
  },
})
// A change needs the version that was read; a stale one is refused (412).
await admin.call('updateOrganizationRole', {
  params: { key: role.key },
  headers: { 'If-Match': ifMatch(role.version) },
  body: { permissions: [...role.permissions, 'org:invoices:read'] },
})
const { data: roles } = await admin.call('listOrganizationRoles')
// roles.data holds the built-in `admin` and `member` and every custom role.
```
<!-- /snippet -->

:::

A role is in use while any member holds it, and a role in use cannot be deleted
(`organization.role_in_use`, 409): move its members first. The errors of role management:

| Code | Status | When |
| --- | --- | --- |
| `organization.role_exists` | 409 | The key is taken, built-in keys included. |
| `organization.role_built_in` | 409 | A write to `admin` or `member`. |
| `organization.role_in_use` | 409 | Deleting a role a member holds. |
| `organization.role_limit` | 409 | More than 50 custom roles. |
| `organization.role_unknown` | 422 | Giving a member a role that does not exist. |
| `organization.disabled` | 403 | Organizations are off: [turn them on](organizations.md#turn-organizations-on) first. |

> [!WARNING]
> **Giving a role a permission is a weakening.** Its members may do more from their next token
> refresh. `tula apply --yes` refuses such a plan until you add `--allow-weaker`, and the audit
> entry of the change says `weakened: true`. Taking a permission away is not one.

## Asking: `has()`

`has()` takes a permission or a role:

```ts
has({ permission: 'org:billing:read' })
has({ role: 'admin' })
```

It answers `true` only when an organization is active and the token's claims say so. With no
active organization, with organizations off, or with a malformed set of claims, it answers
`false` for everything: an absent claim grants nothing. Where it lives:

| Where | How | Decides |
| --- | --- | --- |
| Next.js server | `const { has } = await auth()`, and `access` rules in the proxy | What to allow. |
| Any backend | `hasOrganizationAccess(readOrganizationClaims(payload), { permission })` from `@tula-tech/contract/custom-claims`, on a token you verified | What to allow. |
| React | `useOrganization().has(...)` | What to show. Never what to allow. |

[Organizations](organizations.md#reading-the-organization-in-your-app) shows each, and
[how fresh](organizations.md#how-fresh-the-claims-are) the answer is: a change to a role reaches
a signed-in user at their next refresh.

Check a **permission**, not a role, wherever you can. A role is a bundle that you may reshape
tomorrow (`billing_manager` gains a duty); a permission is the thing the code actually needs.

## Reading roles from an AI assistant

The [MCP server](mcp.md) has a tool that reads roles: `list_organization_roles` lists the
built-in and custom roles with their permissions, so an assistant can answer "which role can
export invoices?" with an agent key, which cannot change anything here.

## See also

- [Organizations](organizations.md): turning them on, the active organization, the token claims.
- [Settings as code](config.md#organization-roles): `organizationRoles`.
- [ADR 0065](adr/0065-organizations.md): why roles are environment-wide and why `has()` is exact.
