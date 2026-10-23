import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test'
import { resolveBase } from '../apps/docs/src/lib/paths'
import { serversFor } from './projects'

// Browser tests for @tula-tech/react (plan rule 3): the example app, built from the components
// only, against the real API served in process with memory adapters (e2e/server.ts). A second
// project, `nextjs`, drives the Next.js example (@tula-tech/nextjs) against the same API.
//
//   bun run e2e:install    once: download Chromium
//   bun run e2e            build the example, start the server, run the suite
//
// Not part of `bun run verify`; CI runs it as its own job.

const API_URL = 'http://localhost:4318'
const APP_URL = 'http://localhost:4317'
const PUBLISHABLE_KEY = 'tula_pk_dev_e2e000000000000000000000000000000'
// The Next.js example (@tula-tech/nextjs): built once, then served by `next start`. Its server
// reaches the same fixture API; its pages only ever talk to their own origin.
const NEXT_URL = 'http://localhost:4319'
const SECRET_KEY = 'tula_sk_dev_e2e000000000000000000000000000000'
const ENVIRONMENT_ID = '00000000-0000-7000-8000-00000000e001'
// The documentation site (apps/docs): built once, then served as static files. It needs no API,
// so a run of this project alone starts nothing else (see `docsOnly`).
const DOCS_URL = 'http://127.0.0.1:4321'

// Playwright launches every `webServer` of the config whatever project is selected, so the
// servers follow the projects named on the command line (`projects.ts`). A run of `docs` alone
// (or E2E_DOCS_ONLY=1) starts only the docs server, which needs no API; a run that leaves `docs`
// out starts none of it: that is CI's `e2e` job, with the `e2e-docs` job beside it.
const projects: NonNullable<PlaywrightTestConfig['projects']> = [
  // First: the Next.js server verifies tokens against the real time, and scenarios of the
  // later projects move the fixture's clock forward and leave it there. This project's own
  // methods.spec.ts moves it too, and puts it back when it is done (`/__test/reset-clock`
  // in its `afterAll`), so the specs after it start from the real time. With one worker,
  // projects run in this order.
  {
    name: 'nextjs',
    testMatch: /nextjs\/.*\.spec\.ts/,
    // Reduced motion: the components' entrances are off, which is what a user with that
    // preference gets, and Playwright does not wait out a 240ms animation on every dialog.
    // `motion.spec.ts` runs the real motion path.
    use: { ...devices['Desktop Chrome'], baseURL: NEXT_URL, reducedMotion: 'reduce' },
  },
  // The dashboard (apps/dashboard), served by the API itself at /dashboard under its real
  // Content-Security-Policy. Before `chromium` for the same reason as `nextjs`: its session
  // lasts eight hours by the fixture's clock.
  {
    name: 'dashboard',
    testMatch: /dashboard\/.*\.spec\.ts/,
    use: { ...devices['Desktop Chrome'], baseURL: `${API_URL}/dashboard/` },
  },
  // The documentation site (apps/docs), built and served as static files: no API behind it.
  {
    name: 'docs',
    testMatch: /docs\/.*\.spec\.ts/,
    // The pages are static files and each test opens its own: the tests of the one spec file
    // run on the workers `--workers` gives (CI: four), where `fullyParallel: false` above
    // would keep them all on one.
    fullyParallel: true,
    use: { ...devices['Desktop Chrome'], baseURL: DOCS_URL },
  },
  {
    name: 'chromium',
    testIgnore: [/nextjs\//, /dashboard\//, /docs\//],
    use: { ...devices['Desktop Chrome'], reducedMotion: 'reduce' },
  },
]

const servers = serversFor(
  process.argv,
  process.env,
  projects.map((project) => project.name as string)
)

export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  // One server, one in-memory world, one outbox: scenarios run one after the other.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI
    ? [['list'], ['html', { outputFolder: './playwright-report', open: 'never' }]]
    : [['list']],
  use: {
    baseURL: APP_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects,
  webServer: [...(servers.api ? apiServers() : []), ...(servers.docs ? [docsServer()] : [])],
})

/** The documentation site, built from docs/** and apps/docs, then served from its output directory. */
function docsServer(): WebServer {
  return {
    // The released docs at the base and the development docs under `next/`, as deployed.
    // `exec`: the server must be the process Playwright stops.
    command:
      'bun run --filter @tula-tech/docs build:versions && DOCS_PORT=4321 exec bun run apps/docs/scripts/serve.ts',
    cwd: `${import.meta.dirname}/..`,
    // Built and served under DOCS_BASE when it is set (as GitHub Pages serves the site): the
    // root answers 404 then, so the server is ready when its base answers.
    url: `${DOCS_URL}${resolveBase()}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: 'ignore',
    stderr: 'pipe',
  }
}

type WebServer = Extract<PlaywrightTestConfig['webServer'], unknown[]>[number]

/** The fixture API (with the two example apps) and the Next.js example's server. */
function apiServers(): WebServer[] {
  return [
    {
      // The example is built with the fixture's fixed API URL and key, and the dashboard as the
      // image builds it; then the fixture serves both.
      command: `VITE_TULA_API_URL=${API_URL} VITE_TULA_PUBLISHABLE_KEY=${PUBLISHABLE_KEY} bun run --filter @tula-tech/example-react-vite build && VITE_TULA_API_URL=${API_URL} VITE_TULA_PUBLISHABLE_KEY=${PUBLISHABLE_KEY} bun run --filter @tula-tech/ui browser:build && bun run --filter @tula-tech/dashboard build && E2E=1 bun run server.ts`,
      cwd: import.meta.dirname,
      url: `${API_URL}/v1/status`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      // The API logs every request to stdout; only its errors are worth the test output.
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      // Configured by environment variables alone: no `.env` file is read or written.
      // `exec`: the server must be the process Playwright stops. Left running, it would keep
      // the keys of a fixture that is gone, and the next run's tokens would not verify.
      command: 'bunx --bun next build && exec bunx --bun next start',
      cwd: `${import.meta.dirname}/../examples/nextjs-app-router`,
      env: {
        PORT: '4319',
        TULA_API_URL: API_URL,
        NEXT_PUBLIC_TULA_PUBLISHABLE_KEY: PUBLISHABLE_KEY,
        TULA_ENVIRONMENT_ID: ENVIRONMENT_ID,
        // For `stateful` session profiles only: their cookie cannot be verified offline.
        TULA_SECRET_KEY: SECRET_KEY,
        NEXT_TELEMETRY_DISABLED: '1',
      },
      url: NEXT_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ]
}
