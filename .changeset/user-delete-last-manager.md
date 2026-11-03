---
"@tula-tech/contract": patch
"@tula-tech/admin": patch
"@tula-tech/core": patch
---

Deleting a user who is the only member holding `org:sys:memberships:manage` of an organization is refused with the new `user.last_organization_manager` error code (409, `params.organizationIds` and `params.count`), as removing or demoting that member already was. Add another manager or delete the organization first. `@tula-tech/admin` and `@tula-tech/core` carry the new error code in their generated types.
