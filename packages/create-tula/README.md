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
| `--framework react-vite \| nextjs \| expo \| swiftui \| compose` | The example app the project starts from: two web ones, three native ones. Asked for on a terminal. |
| `--tula-repo <dir>` | A checkout of the Tula repository. Required for `swiftui` and `compose`, refused for the others. |
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

A native app is a directory of its own beside the stack's files: `app` (Expo), `ios` (an
Xcode project) or `android` (a Gradle build). The Swift package and the Kotlin libraries are
published nowhere, and create-tula names no registry that does not exist: a SwiftUI or a
Compose project names its SDK by a path into the checkout `--tula-repo` gives, and the
Compose one is built with the checkout's Gradle wrapper. A native project holds no key.
**Nobody has run a scaffolded native project in a simulator, on an emulator or on a phone**:
the SwiftUI and the Compose one were compiled, the Expo one was not installed
([docs/quickstart.md](../../docs/quickstart.md#the-native-path),
[what was not verified](../../docs/plans/phase-2-unverified.md)).

The app templates are copies of `examples/react-vite`, `examples/nextjs-app-router`,
`examples/expo/app`, `examples/swiftui` and `examples/compose`, made by
`bun run --filter create-tula templates:sync`; `bun run verify` fails when they drift.
