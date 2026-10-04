---
'@tula/mcp': minor
'@tula/cli': minor
'@tula/admin': minor
'create-tula': minor
---

The MCP server (ADR 0033): `tula mcp`.

- `@tula/mcp` (new): `createTulaMcpServer(options)`, a Model Context Protocol server with
  eleven tools, all read-only. Read tools over the admin API: `list_users`, `get_user` (with
  how the user signs in), `list_user_sessions`, `list_audit_entries`, `get_settings`,
  `list_oauth_providers` and `run_doctor`. Scaffold tools that need no credentials and write
  nothing: `detect_framework`, `scaffold_provider`, `scaffold_protected_route` and
  `scaffold_sign_in_page` (Next.js App Router and React with Vite), which return the example
  apps' own files for the client to write. No tool changes live data: the tools reach the API
  only through a facade over an allow-list of `GET` operations. Every result passes an
  allow-list projection (a field that is not named is dropped), has control characters removed
  and secret-shaped values replaced, and is bounded (512 characters a string, 64,000 a result).
  Characters a reader cannot see are removed before secret shapes are looked for: format
  characters (zero-width, bidirectional controls, the soft hyphen, Unicode tag characters),
  variation selectors, private-use and unassigned code points and lone surrogates; a run of
  combining marks is cut at eight. Names in any script are unchanged; a joined emoji is
  returned as its parts. Only the first 4096 characters of a value (or four times its limit)
  are looked at, and every pattern is linear. Each call's requests are aborted when it is
  cancelled or out of time; four read tools run at once, sixteen wait, the next is `busy`,
  and a call already cancelled is answered `cancelled` without taking a turn. A secret split
  by a control character or a newline is replaced whole. A record's key is cleaned before it
  is compared: an entry whose key is a duplicate or a prototype name once cleaned is left
  out and the record has `truncated: true`.
- `@tula/cli`: `tula mcp` serves it on standard input and output. Credentials come from the
  environment or a file, as for every other command (`TULA_API_URL[_<NAME>]`,
  `TULA_SECRET_KEY[_<NAME>]` or `--secret-key-file`, `TULA_ADMIN_TOKEN` or
  `--admin-token-file` for `run_doctor`); none is required. Standard output carries only the
  protocol. The server is loaded only by `tula mcp`: every other command starts without the
  MCP SDK. `examine` takes an optional `signal` that abandons a doctor run.
- `@tula/admin`: exports `OPERATIONS` and `INSTANCE_OPERATIONS` (each operation's method and
  path) and the `OperationRoute` type.
- `create-tula`: the React example is split into `auth-provider.tsx`, `protected.tsx` and
  `sign-in-page.tsx`, which a scaffolded project now has; `--tula-packages` also needs the
  `@tula/mcp` tarball.
