---
"@tula-tech/contract": minor
"@tula-tech/core": minor
"@tula-tech/admin": minor
"@tula-tech/react": patch
"@tula-tech/nextjs": patch
---

A signed-in user's own organizations and the active organization. `@tula-tech/core` gets `client.organizations.list()`, `.create(input)` and `.setActive(id | null)`, and the signed-in state gains `organizationId`, read from the access token's `org_id`. The access token carries `org_id`, `org_role` and `org_perms` while an organization is active (reserved claim names, a cap of their own, none of them when over it); a refresh re-reads the membership, so a removal or a demotion takes effect at the next refresh and the session stays. The contract gains the schemas for `GET`/`POST /v1/client/me/organizations` and `PUT /v1/client/me/organizations/active`, `readOrganizationClaims` and the error codes `organization.not_a_member`, `organization.creation_disabled`, `organization.limit_reached` and `organization.personal_account_disabled`. `@tula-tech/react` and `@tula-tech/nextjs` only follow the new field of the auth state.
