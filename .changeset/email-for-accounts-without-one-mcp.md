---
'@tula/mcp': patch
---

`draft_settings_change` says, in one more fixed entry of `notes`, that it does not judge
whether accounts can sign in only with a provider a draft switches off (ADR 0059): the tool
never reads that count, so `weakens: false` for such a draft is not "nobody is locked out".
`tula diff` counts them. No request was added.
