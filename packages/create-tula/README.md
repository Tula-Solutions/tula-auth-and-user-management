# create-tula

Scaffolds a [Tula Auth](../../README.md) project: a Compose file for the local stack, a `.env`
with freshly generated secrets, a `tula.config.ts` and an example app.

```sh
bun create tula my-app            # asks for the framework
bunx create-tula my-app --framework nextjs
cd my-app && bun install && bunx tula dev && bun run dev
```

| Option | What |
| --- | --- |
| `--framework react-vite \| nextjs` | The example app the project starts from. Asked for on a terminal. |
| `--api-image <ref>` | The Tula API image written to `.env` (`TULA_API_IMAGE`). Default `tula-api:local`. |
| `--api-port`, `--mailpit-port` | The host ports of the API (3003) and Mailpit's inbox (8025). |
| `--tula-packages <dir>` | Install every `@tula/*` package from tarballs in this directory. |
| `--force` | Write into a directory that is not empty. `.env` and `.env.local` are never replaced. |

What it writes: `compose.yaml` (Postgres, Redis and Mailpit pinned by digest; the Tula API by
`TULA_API_IMAGE`), `.env` (mode 0600: `TULA_MASTER_KEY`, `TULA_ADMIN_TOKEN` and two database
passwords from `crypto.getRandomValues`, never a default), `.gitignore` (covers `.env` and
`.env.local`), `.env.example`, `tula.config.ts`, `README.md`, `docker/postgres/init.sh` and
the app.

**Nothing is published yet.** Until it is, the API image is built from the Tula repository
(`docker build -f apps/api/Dockerfile -t tula-api:local .`) and the packages come from
tarballs: `bun run packages:check` writes them to `.release/`, and
`--tula-packages <repo>/.release` points the project at them. The full walk-through is
[docs/quickstart.md](../../docs/quickstart.md).

The app templates are copies of `examples/react-vite` and `examples/nextjs-app-router`, made
by `bun run --filter create-tula templates:sync`; `bun run verify` fails when they drift.
