---
"@tula-tech/mcp": minor
"@tula-tech/react": minor
---

Organizations, the guide and the assistant tools (ADR 0065). `@tula-tech/mcp` gains three read-only tools, `list_organizations`, `list_organization_members` (a membership has a user id and a role, no email address) and `list_organization_roles`, over the admin API, bounded and projected from an allow-list like the others. `@tula-tech/react` gains the `organizations` group of localization strings, the words of the Tula UI items `organization-switcher` and `organization-profile`; the prebuilt components do not draw them.
