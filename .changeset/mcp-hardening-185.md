---
"@tula-tech/mcp": patch
---

The redactor now replaces `tula_sk_`/`tula_ak_` keys whose environment segment has digits and configured secrets of four characters or more. `draft_settings_change` takes a provider secret only from a variable named `*_SECRET` or `*_PRIVATE_KEY`. `list_audit_entries` checks `action` against the contract's list. `detect_framework` reads the manifest through one no-follow handle.
