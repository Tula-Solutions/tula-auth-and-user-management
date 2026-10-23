---
"@tula-tech/contract": minor
"@tula-tech/core": minor
"@tula-tech/admin": minor
---

Verified domains for organizations (Orgs 05). An organization claims a domain by entering a 6-digit code emailed to an address on it, and a user whose verified email address is exactly on a verified domain is offered the organization (`suggest`) or joined to it at sign-up (`auto_join`). `@tula-tech/core` gets `client.organizations.suggestions()` and `.join(organizationId)`; `@tula-tech/admin` gets `/v1/admin/organizations/{id}/domains` (list, claim, verify, change the mode, remove). The contract gains the schemas, the Zod-free entry point `@tula-tech/contract/organization-domain-rules` (the domain grammar, `domainRefusal`, `isPublicEmailDomain`, `domainOfAddress` and the documented list of public mail domains), the permission `org:sys:domains:manage`, the email kind `organization_domain_verification`, the activity types `organization_domain.claimed`, `.verified`, `.updated` and `.removed`, an optional `via` on `organization_membership.added`, and the error codes `organization.domain_public`, `organization.domain_taken`, `organization.domain_address_mismatch`, `organization.domain_limit` and `organization.suggestion_unavailable`.
