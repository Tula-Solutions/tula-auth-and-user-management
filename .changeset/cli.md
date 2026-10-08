---
'@tula/cli': minor
'@tula/admin': minor
'create-tula': minor
---

The CLI (ADR 0031): `create-tula`, `tula dev`, `tula doctor` and `tula policy test`.

- `create-tula` (new): scaffolds a project. A Compose file with service images pinned by
  digest, a `.env` (mode 0600) with a generated master key, instance admin token and database
  passwords, a `.gitignore` that covers it, `tula.config.ts`, and the example app of the
  chosen framework (`--framework react-vite | nextjs`). It refuses a directory that is not
  empty (`--force`), an unsafe project name, and never replaces an existing `.env`.
  `--tula-packages <dir>` installs the `@tula/*` packages from local tarballs while nothing is
  published; `--api-image` names the API image.
- `@tula/cli`: `tula dev` starts the project's Compose stack, runs the migrations and the seed
  with the commands the API image ships, mints a publishable and a secret development key into
  its own block of `.env.local` (a second run reuses them; the user's own lines are never
  changed; the secret key is printed only with `--show-keys`) and prints the URLs.
  `tula dev down [--volumes]` stops it. `tula doctor` checks a deployment from this machine
  and through `GET /v1/instance/diagnostics`, with a fix under every check that is not ok
  (`--json`, `--strict`; exit 1 when a check fails). `tula policy test` shows which rules of
  an environment's password policy a password passes: the password is asked for without echo
  or read from standard input, evaluated on this machine and never sent or printed (exit 2
  when it would be refused).
- Hardening after review: `tula dev` closes `.env.local` to mode 0600 on every run (the
  `Host` interface gains `restrictFile`) and finds its block even when a line of yours
  mentions the end marker; `tula doctor` never requests an address the server names unless
  it is the API URL's own origin; `create-tula` writes `.gitignore` first and `.env` last,
  merges into an existing `.gitignore` under `--force`, and refuses a symbolic link at any
  path it would write.
- `@tula/admin`: `createInstanceClient({ baseUrl, adminToken })` for the instance routes
  (`/v1/instance/*`), generated from the contract like the admin client; a response now
  carries the server's `Date` header.
