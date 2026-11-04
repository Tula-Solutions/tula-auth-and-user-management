---
"@tula-tech/react": patch
"@tula-tech/mcp": patch
---

`useOrganizationList().create()` now ends with the list as the server holds it after the creation, even when a fetch started before it was still on its way. The `list_users` tool says its page size is at most 50.
