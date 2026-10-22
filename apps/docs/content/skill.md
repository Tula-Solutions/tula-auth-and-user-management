---
name: tula-auth
description: Add Tula Auth, a self-hosted authentication and user-management server with prebuilt UI, to a React (Vite) or Next.js app, and run the server locally with Docker.
---

# Tula Auth

Tula Auth is a self-hosted authentication and user-management server (an API over PostgreSQL)
with SDKs. This skill is for adding it to an app and starting the server on this machine. Every
fact here comes from the documentation; the page that says it is linked. Fetch a page's
Markdown instead of guessing: the index of every page is {{file:llms.txt}}.

## When to use

- The user wants sign-up, sign-in, sessions or an account page in a **React (Vite)** or
  **Next.js (App Router)** app, with a server they host themselves.
- The user wants to run, check or configure a Tula server (`tula dev`, `tula doctor`,
  `tula.config.ts`).

## When not to use

- **Expo, SwiftUI and Compose apps are not released to a registry.** The Expo SDK is refused by
  `create-tula` without a local `--tula-packages` directory, and the Swift package and Kotlin
  libraries are used by a path into a checkout of the repository. Do not run the web steps for
  them: read {{page:docs/quickstart.md#the-native-path}} first, and tell the user what it says
  was not run.
- The user wants a hosted service. Tula Auth is self-hosted: the user runs the server.

## What a person must provide

- **Bun 1.2 or newer and Docker** on the machine ({{page:docs/quickstart.md}}).
- A decision about the **framework**: `react-vite` or `nextjs`.
- For Google, GitHub or another provider: the user's own provider credentials
  ({{page:docs/methods/oauth.md}}). Never invent them.

## Steps for a web app

1. Scaffold. In an empty directory the user names:
   `bunx create-tula@latest my-app --framework nextjs` (or `react-vite`). It writes the
   Compose file, a `.env` with generated secrets, `tula.config.ts` and the example app
   ({{page:docs/cli.md#create-tula}}).
2. `cd my-app && bun install`.
3. Start the server: `bunx tula dev`. It starts Postgres, Redis, Mailpit and the API with
   Docker Compose, runs the migrations, seeds a project with a development and a production
   environment, writes development keys to `.env.local` and prints the API address and the
   **publishable key** ({{page:docs/cli.md#tula-dev}}). Running it again changes nothing.
4. Check it: `bunx tula doctor` (each problem it finds comes with its fix).
5. Run the app: `bun run dev`. The example is on `http://localhost:5174` for Vite and
   `http://localhost:3000` for Next.js; a sign-up's verification code arrives in Mailpit at
   `http://localhost:8025` ({{page:docs/quickstart.md}}).
6. Change settings (a sign-in method, a provider, a passkey) in `tula.config.ts`, then
   `bunx tula diff` to see what would change and `bunx tula apply` to make the server match
   ({{page:docs/config.md}}). The app's code does not change: the components draw what the
   environment enables.

The sign-in methods are documented one page each; start from the index at
{{page:docs/README.md}}. The package guides are the READMEs of `@tula-tech/react`,
`@tula-tech/nextjs` and `@tula-tech/core`, and their reference is under the SDK reference
group of {{file:llms.txt}}.

## How the server and the client talk

- The API never tells a client which screen to draw: it answers with the next **step** of a
  flow, and the SDK's components draw it. A client built on `@tula-tech/core` handles each step
  the server returns instead of assuming a fixed sequence.
- Errors have a stable `code`: an SDK switches on `code`, not on the message, and codes are
  only ever added ({{page:/reference/error-codes/}}).

## Verify

- `bunx tula doctor` reports the database, migrations, master key, mail, Redis and URLs, each
  with its fix ({{page:docs/quickstart.md}}).
- Sign up in the running app and read the code from Mailpit.
- Report to the user anything you could not do. The quickstart says its path through npm has
  not been walked end to end yet: say so if a step fails, and do not claim it works.

## Constraints

- **Never read, print or commit `.env` or `.env.local`.** `create-tula` writes secrets there,
  and `TULA_MASTER_KEY` must be backed up by the user: stored signing keys and provider
  credentials cannot be opened without it.
- **The secret key (`tula_sk_…`) stays on a server.** The publishable key (`tula_pk_…`) goes in
  the app ({{page:docs/self-host.md}}). No native app is ever given the secret key
  ({{page:docs/quickstart.md}}).
- No command takes a secret as an argument. Credentials come from the environment or a file
  ({{page:docs/cli.md}}).
- Run `bunx tula` only in a project that has the CLI installed. Anywhere else the name is an
  unrelated npm package; outside a project use
  `bunx --package @tula-tech/cli@latest tula <command>`.
- Install the `@tula-tech/*` packages with `@latest` (they are early `0.x` releases) rather
  than a version remembered from elsewhere.
- Settings that weaken security need a flag to apply from CI; do not add the flag to make a
  command pass. Read {{page:docs/config.md}} first.

## More

- Full text of the hand-written documentation: {{file:llms-full.txt}}.
- An MCP server for an assistant, `tula mcp`, reads and proposes changes a person approves:
  {{page:docs/mcp.md}} and {{page:docs/proposals.md}}.
