---
"@tula-tech/contract": minor
"@tula-tech/core": minor
"@tula-tech/admin": minor
---

Paging and search over organizations. `client.organizations.list({ page, size })` in `@tula-tech/core` reads any page of the signed-in user's organizations (the generated client types now carry the documented `page` and `size` query of `GET /v1/client/me/organizations`, and `meta` says how many pages there are); a call with no argument reads the first page as before. `GET /v1/admin/organizations` takes `q`, a name or slug prefix of up to 100 characters matched ignoring case (`%` and `_` match themselves), counted and paged as a match; `@tula-tech/admin`'s `listOrganizations` types it. The contract gains `OrganizationSearchQuerySchema`.
