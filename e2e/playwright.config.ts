import { defineConfig, devices } from '@playwright/test'

// Browser tests for @tula/react (plan rule 3): the example app, built from the components
// only, against the real API served in process with memory adapters (e2e/server.ts). A second
// project, `nextjs`, drives the Next.js example (@tula/nextjs) against the same API.
//
//   bun run e2e:install    once: download Chromium
//   bun run e2e            build the example, start the server, run the suite
//
// Not part of `bun run verify`; CI runs it as its own job.

const API_URL = 'http://localhost:4318'
const APP_URL = 'http://localhost:4317'
const PUBLISHABLE_KEY = 'tula_pk_dev_e2e000000000000000000000000000000'
// The Next.js example (@tula/nextjs): built once, then served by `next start`. Its server
// reaches the same fixture API; its pages only ever talk to their own origin.
const NEXT_URL = 'http://localhost:4319'
const SECRET_KEY = 'tula_sk_dev_e2e000000000000000000000000000000'
const ENVIRONMENT_ID = '00000000-0000-7000-8000-00000000e001'

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
  projects: [
    // First: the Next.js server verifies tokens against the real time, and scenarios of the
    // other project move the fixture's clock forward (it never moves back). With one worker,
    // projects run in this order.
    {
      name: 'nextjs',
      testMatch: /nextjs\/.*\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: NEXT_URL },
    },
    { name: 'chromium', testIgnore: /nextjs\//, use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: [
    {
      // The example is built with the fixture's fixed API URL and key, then both are served.
      command: `VITE_TULA_API_URL=${API_URL} VITE_TULA_PUBLISHABLE_KEY=${PUBLISHABLE_KEY} bun run --filter @tula/example-react-vite build && E2E=1 bun run server.ts`,
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
  ],
})
