---
'@tula-tech/mcp': minor
'@tula-tech/cli': patch
---

A draft tool, `draft_settings_change`: an assistant names the settings and OAuth providers
that should change and gets the change back as an edit to the environment's entry in
`tula.config.ts` ([ADR 0056](../docs/adr/0056-mcp-settings-config-diff.md)). It reads
through the unchanged read-only facade, writes no file and calls no route that writes; a
person applies the edit with `tula diff` and `tula apply`. A provider's secret is only
ever `{ $env: 'NAME' }` (the tool takes a variable's name and no secret), what the change
weakens is listed under the names `tula diff` prints, and a change no config file could
hold is refused with the paths of its problems. `tula mcp` now serves 13 tools.
`@tula-tech/mcp` depends on `@tula-tech/config` and `@tula-tech/contract`, and exports `DRAFT_TOOL_NAMES`.
