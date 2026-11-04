# create-tula

Scaffolds a [Tula Auth](../../README.md) project: a Compose file for the local stack, a `.env`
with freshly generated secrets, a `tula.config.ts` and an example app.

```sh
bunx create-tula@latest my-app            # asks for the framework
bunx create-tula@latest my-app --framework nextjs
cd my-app && bun install && bunx tula dev && bun run dev
```

| Option | What |
| --- | --- |
| `--framework react-vite \| nextjs \| expo \| swiftui \| compose` | The example app the project starts from: two web ones, three native ones. Asked for on a terminal. |
| `--tula-repo <dir>` | A checkout of the Tula repository. Required for `swiftui` and `compose`, refused for the others. `--tula-repo` must be a checkout you trust: building the project runs its build scripts. |
| `--api-image <ref>` | The Tula API image written to `.env` (`TULA_API_IMAGE`). Default: the published image of this package's own version, `ghcr.io/tula-solutions/tula-api:<version>`. |
| `--api-port`, `--mailpit-port` | The host ports of the API (3003) and Mailpit's inbox (8025). |
| `--tula-packages <dir>` | Install every `@tula-tech/*` package from tarballs in this directory. |
| `--force` | Write into a directory that is not empty. `.env` and `.env.local` are never replaced. |

What it writes: `compose.yaml` (Postgres, Redis and Mailpit pinned by digest; the Tula API by
`TULA_API_IMAGE`), `.env` (mode 0600: `TULA_MASTER_KEY`, `TULA_ADMIN_TOKEN` and two database
passwords from `crypto.getRandomValues`, never a default), `.gitignore` (covers `.env` and
`.env.local`), `.env.example`, `tula.config.ts`, `README.md`, `docker/postgres/init.sh` and
the app.

> **Early release (0.x).** Run it as `bunx create-tula@latest`: what
> it writes may change from one release to the next. `bunx tula …` is for after `bun install`
> in the project, which lists `@tula-tech/cli`: before it, or anywhere else, the name `tula`
> is an unrelated npm package. It runs on
> [Bun](https://bun.sh) 1.2 or later, not on Node. Everything else is in the
> [repository](https://github.com/Tula-Solutions/tula-auth-and-user-management#readme).

**What is on npm, and what is not.** The web templates (`react-vite`, `nextjs`) install their
`@tula-tech/*` packages from npm, at this package's own version. **The Tula API image is pulled
from GitHub's container registry**, also at this package's own version
(`ghcr.io/tula-solutions/tula-api:<version>`, for amd64 and arm64), the first time
`bunx tula dev` starts the stack: nothing is built on your machine. `--api-image` names
another, such as one built from the Tula repository
(`docker build -f apps/api/Dockerfile -t tula-api:local .`). **Tula's Expo SDK (`@tula-tech/expo`) is not released to npm yet**, because it has not
been run on a device: `--framework expo` is refused, before anything is written, unless
`--tula-packages <repo>/.release` points the project at tarballs from a checkout
(`bun run packages:check` writes them there). The full walk-through is
[docs/quickstart.md](../../docs/quickstart.md).

A native app is a directory of its own beside the stack's files: `app` (Expo), `ios` (an
Xcode project) or `android` (a Gradle build). The Swift package and the Kotlin libraries are
published nowhere, and create-tula names no registry that does not exist: a SwiftUI or a
Compose project names its SDK by a path into the checkout `--tula-repo` gives, and the
Compose one is built with the checkout's Gradle wrapper. The path to it holds letters,
digits, dots, dashes and underscores only (no space). A native project holds no key.
**Nobody has run a scaffolded native project in a simulator, on an emulator or on a phone**:
the SwiftUI and the Compose one were compiled, the Expo one was not installed
([docs/quickstart.md](../../docs/quickstart.md#the-native-path),
[what was not verified](../../docs/plans/phase-2-unverified.md)).

## After it runs

```sh
cd my-app
bun install                    # the web templates list the CLI, so `tula` now resolves
bunx tula dev                  # migrations, seed, API, development keys in .env.local
bun run dev                    # the example app
bunx tula dev down             # stop the stack; the data is kept
```

`tula dev` prints the URLs of the API, its reference and Mailpit (the inbox that catches the
emailed codes). `bunx tula dev --tunnel` serves the same stack at a public https address, for
a phone ([docs/cli.md](../../docs/cli.md#tula-dev---tunnel)).

## The name, exit codes and safety

- The name is the directory, the package name and the Compose project name: lowercase
  letters, digits, dashes and underscores.
- Exit code 0 means the project was created; 1 means an error, and nothing was written.
- **Back up `TULA_MASTER_KEY`** from `.env`: it opens the stored signing keys and provider
  credentials.
- `.gitignore` is written first and `.env` last, so the secrets are never on disk without the
  file that keeps them out of git.
- A symbolic link where a file or directory would be written, or as the project directory, is
  refused before anything is written.
- `--force` keeps an existing `.env` and `.env.local`, and an existing `.gitignore` keeps its
  lines and gains the ones it lacks.

## Which framework

| `--framework` | Starts from | Needs |
| --- | --- | --- |
| `react-vite` | A Vite + React app built only from `@tula-tech/react` components. | npm packages only. |
| `nextjs` | A Next.js App Router app on `@tula-tech/nextjs`: protected routes, a server-rendered page, a route handler. | npm packages only. |
| `expo` | An Expo app on `@tula-tech/expo`. | `--tula-packages <repo>/.release` (not on npm yet). |
| `swiftui` | An Xcode project using `TulaAuthUI`. | `--tula-repo <checkout>`. |
| `compose` | A Gradle build using the Compose screens. | `--tula-repo <checkout>`. |

Without `--framework` on a terminal it asks; without a terminal the option is required.

## What the stack holds

| Service | Where | Notes |
| --- | --- | --- |
| Tula API | `http://localhost:3003` (`--api-port`) | The reference is served at `/v1/docs` in the local tier. |
| Mailpit | `http://localhost:8025` (`--mailpit-port`) | Catches every email the stack sends, such as sign-in codes. |
| Postgres, Redis | Inside the Compose network | Pinned by digest in `compose.yaml`. |

The settings live in `tula.config.ts`. Change them there and run `bunx tula diff`, then
`bunx tula apply` ([docs/config.md](../../docs/config.md)); secrets appear in that file only
as `env('NAME')`, never as values.

## Re-running and changing your mind

- Running it into a non-empty directory is refused unless you pass `--force`.
- `--api-image` can be changed later by editing `TULA_API_IMAGE` in `.env`.
- To start over, `bunx tula dev down --volumes` deletes the database; the files stay.

## Reporting a problem

The errors it prints say which step failed and what to change, and never repeat a secret.
Issues go to the [repository](https://github.com/Tula-Solutions/tula-auth-and-user-management/issues).

## Requirements

[Bun](https://bun.sh) 1.2 or later and Docker with Compose, for the stack `tula dev` starts.

## Learn more

- [docs/quickstart.md](../../docs/quickstart.md): the walk-through, web and native.
- [docs/cli.md](../../docs/cli.md): `create-tula` and the `tula` commands.
- [packages/cli](../cli/README.md): the `tula` executable.

The app templates are copies of `examples/react-vite`, `examples/nextjs-app-router`,
`examples/expo/app`, `examples/swiftui` and `examples/compose`, made by
`bun run --filter create-tula templates:sync`; `bun run verify` fails when they drift.
