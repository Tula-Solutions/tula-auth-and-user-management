---
'@tula-tech/mcp': patch
'@tula-tech/cli': patch
'create-tula': patch
---

The MCP scaffold tools (`scaffold_provider`, `scaffold_protected_route`,
`scaffold_sign_in_page`) answer `scaffold.not_released`, with no file, for `expo`: its
scaffold needs `@tula-tech/expo`, which is not on npm yet, and the tools no longer tell an
assistant to install it. The other four frameworks are unchanged.

The READMEs and the docs name the `alpha` dist-tag in every install and scaffold command
(`bunx create-tula@alpha`), and say that `bunx tula` is for a project that has
`@tula-tech/cli` installed: elsewhere the name `tula` is an unrelated npm package, so a
command run outside a project names the package
(`bunx --package @tula-tech/cli@alpha tula mcp`).
