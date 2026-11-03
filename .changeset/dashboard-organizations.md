---
"@tula-tech/contract": minor
"@tula-tech/admin": minor
"@tula-tech/core": patch
---

`GET /v1/admin/users/{userId}/organizations` lists the organizations a user belongs to with their role in each (`listUserOrganizations` in `@tula-tech/admin`, `UserMembershipListSchema` in `@tula-tech/contract`). The dashboard's user page, Organizations, Roles and Organization settings screens use it.
