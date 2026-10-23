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
- **The browser tests run as shards, in Playwright's own image.** `e2e` is the aggregate the
  repository's ruleset requires: it waits for `e2e-shard` (four jobs, each `bun run e2e
  --project=nextjs --project=dashboard --project=chromium --shard=i/4`) and `e2e-docs` waits
  for `e2e-docs-shard` (four jobs, `--project=docs --workers=4 --shard=i/4`); both aggregates
  are in `passed`'s `needs`, and each fails unless every shard succeeded (a skipped or
  cancelled shard is a failure: `.claude/hooks/ci-split.test.ts`). A shard is a job of its own
  with its own fixture and servers, so the in-memory world is never shared; the tests of one
  shard still run one after the other on one worker (`docs` is the exception, `fullyParallel`,
  on four). Each shard keeps the project order of `playwright.config.ts` (`nextjs`, `dashboard`, then
  `chromium`).
  Axe on every page of the site, in both schemes, is what takes the time, and no rule is
  disabled to shorten it. The jobs run in `mcr.microsoft.com/playwright:v<version>-noble`, the
  version `bun.lock` installs for `@playwright/test` (the test fails when they differ: bump
  the tag in both shard jobs with the dependency), so no browser is downloaded in CI and
  `playwright install` appears in no job; `--ipc=host` is needed for Chromium. A new
  shard count changes the matrix and the `/n` of the command together. A failed shard uploads
  its report as `playwright-report-<i>` (`playwright-report-docs-<i>`).
  The config starts only the servers of the projects named on the command line
  (`playwright.config.ts`: a run of `docs` alone starts no API, a run without it no docs server).
  The fixture API uses ports 4317 to 4320 and the docs server 4321. Only one checkout (or git
  worktree) can hold 4317 to 4320 at a time, so check them before a local run
  (`lsof -nP -iTCP:4317-4321 -sTCP:LISTEN`). **A run never attaches to a fixture that is
  already listening** (`reuseFixture` in `playwright.config.ts`, on only with
  `E2E_REUSE_SERVER=1`; the docs server, static files, keeps `reuseExistingServer`): the
  fixture is one in-memory world, and another run's tests change its settings, clock and
  organizations under yours, stop its servers and serve its own build (TULA-129: a sign-in
  method switched off mid-test, "Organizations are switched off", a connection refused). A
  busy port stops the run with Playwright's "already used"; wait for the other run, never
  stop a server you did not start.
  **A spec does not assume the environment is empty or at the defaults**: the `nextjs` project
  runs before `dashboard` in the same fixture and leaves organizations behind, so a test that
  says "none yet" first makes it true (`clearOrganizations` in the dashboard's organizations
  spec). **A page is not checked while the router is still re-rendering it**: the
  `router.refresh()` that follows an organization switch has no signal a test can wait for
  (a wait for its request hung in some tests), so `switchTo` in
  `e2e/tests/nextjs/organizations.spec.ts` loads the page again before axe looks at it, or
  axe finds a document without its `<title>` (`document-title`).
  `.claude/hooks/e2e-projects.test.ts` (in `test:harness`) holds that every project of
  `playwright.config.ts` is named by exactly one of the two sets of shards, so a new project is added to
  one of them in the same change; `e2e/projects.ts` (tested in `e2e/projects.test.ts`) decides
  which servers a command line starts.
