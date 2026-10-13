---
paths:
  - "e2e/**"
  - "examples/react-vite/**"
  - "examples/nextjs-app-router/**"
  - "apps/api/Dockerfile"
  - ".dockerignore"
---

# Browser tests

Moved here from `AGENTS.md`, word for word, and canonical for this area: `AGENTS.md` lists
this file under "Area rules" and does not repeat it. A section named in a sentence as
"above" or "below" is found through that list.

## Testing

- **Browser behaviour is tested in a browser.** `bun run e2e` (Playwright, Chromium) drives
  `examples/react-vite` against the real API in process (`e2e/server.ts`: `createApp` on memory
  adapters, with the sent emails readable at `/__test/outbox`) and runs axe on every screen in
  light and dark. It is its own CI job and **not** part of `bun run verify`. A component that
  gains a screen or a state gets a scenario and an axe check there. No axe rule is disabled
  (the `AxeBuilder` is in `e2e/tests/support.ts`). The fixture refuses to
  start without `E2E=1`, lives outside `apps/api` and is excluded from the Docker build
  context: keep it that way. Its `/__test/*` routes go through `e2e/guard.ts` (no `Origin`,
  the exact loopback `Host`, no cross-site `Sec-Fetch-Site`), which `bun run test:harness`
  tests. The API image's install stage copies no manifest of a browser package
  (`packages/react`, `packages/nextjs`, `examples/*`): `bun install --production` would
  install React (and Next.js) into it. A second Playwright project, `nextjs`
  (`e2e/tests/nextjs/`), drives `examples/nextjs-app-router`, built once per run and served by
  `next start`, against the same fixture; the build is part of `bun run e2e`, never of
  `verify`. Its server is started with `exec` so that Playwright stops it: a Next.js server
  left running keeps the keys of a fixture that is gone.
- **The dashboard is tested as the image serves it.** The `dashboard` Playwright project
  (`e2e/tests/dashboard/`) drives the built app served by the API's own static handler at
  `/dashboard`, under its real Content-Security-Policy, against the real API in process; the
  fixture generates an admin token per run (`/__test/admin-token`, behind `e2e/guard.ts`).
  Every test fails on a policy violation, a console error or an uncaught exception
  (`support.ts`). Its component tests (`bun test`, happy-dom) render the whole app against
  `src/testing/fake-api.ts`. The API image builds the app in its own `dashboard` stage and
  copies only `dist`: the `install` stage still gets no manifest of a browser package.
