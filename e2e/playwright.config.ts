import { defineConfig, devices } from '@playwright/test'

// Browser tests for @tula/react (plan rule 3): the example app, built from the components
// only, against the real API served in process with memory adapters (e2e/server.ts).
//
//   bun run e2e:install    once: download Chromium
//   bun run e2e            build the example, start the server, run the suite
//
// Not part of `bun run verify`; CI runs it as its own job.

const API_URL = 'http://localhost:4318'
const APP_URL = 'http://localhost:4317'
const PUBLISHABLE_KEY = 'tula_pk_dev_e2e000000000000000000000000000000'

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
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
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
})
