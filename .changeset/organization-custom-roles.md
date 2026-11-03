---
"@tula-tech/contract": minor
"@tula-tech/admin": minor
"@tula-tech/core": patch
"@tula-tech/config": minor
"@tula-tech/cli": minor
---

Custom organization roles (ADR 0065). An environment defines roles of its own beside `admin` and `member`: `/v1/admin/organization-roles` (list, define, read, change, remove; `listOrganizationRoles`, `createOrganizationRole`, `getOrganizationRole`, `updateOrganizationRole`, `deleteOrganizationRole` in `@tula-tech/admin`). A role is its key, a name and up to 32 permissions of the form `org:<feature>:<action>` (a custom role may hold the system permissions Tula defines, such as `org:sys:memberships:manage`, and no other `org:sys:*` key); an environment has up to 50. A change is made over the role's version (`ETag` / `If-Match`), and giving a role a permission is recorded as a weakening. The contract gains the role schemas, `@tula-tech/contract/organization-permissions` (the grammar, the limits and `organizationRoleWeakenings`, Zod-free), the error codes `organization.role_exists`, `organization.role_in_use`, `organization.role_built_in` and `organization.role_limit`, and the activity types `organization_role.created`, `.updated` and `.deleted` (their data holds the role's key, a count and the names of the fields, never a name or a permission). `@tula-tech/config` accepts an `organizationRoles` list per environment (left out, roles are not managed; the fingerprint of an existing file is unchanged), and `tula diff` / `tula apply` plan and write them: a role is its key, the permissions are a set, `--prune` removes an unlisted role, a role that gains a permission needs `--allow-weaker` under `--yes`, and every write carries the version the plan read. `@tula-tech/core` gets the new error codes in its generated types.
