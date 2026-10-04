import { test as base, expect, type Page } from '@playwright/test'
import { API_URL, expectAccessible, latestCode, PASSWORD } from '../support'

/** The fixture's environment (the example app signs users up into it) and where it lives. */
export const WORKSPACE_ID = '00000000-0000-7000-8000-00000000f001'
export const PROJECT_ID = '00000000-0000-7000-8000-00000000a001'
export const ENVIRONMENT_ID = '00000000-0000-7000-8000-00000000e001'
/** The path of the fixture environment's screens, relative to the dashboard's base. */
export const ENVIRONMENT_PATH = `w/${WORKSPACE_ID}/p/${PROJECT_ID}/e/${ENVIRONMENT_ID}`

/** What a page did that the Content-Security-Policy or the console objected to. */
export interface PageProblems {
  csp: string[]
  console: string[]
}

/**
 * Every dashboard test runs the app as the image serves it (the API's own static handler and
 * its real Content-Security-Policy) and fails if the browser reported one violation of that
 * policy, a console error or an uncaught exception.
 */
export const test = base.extend<{ problems: PageProblems }>({
  problems: [
    async ({ page }, use) => {
      const problems: PageProblems = { csp: [], console: [] }
      // The app honours `prefers-reduced-motion`; with it, a colour never sits mid-transition
      // when axe measures contrast right after the scheme changes.
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.exposeFunction('__reportCsp', (line: string) => {
        problems.csp.push(line)
      })
      await page.addInitScript(() => {
        document.addEventListener('securitypolicyviolation', (event) => {
          const report = (window as unknown as { __reportCsp: (line: string) => void }).__reportCsp
          report(
            `${event.violatedDirective} blocked ${event.blockedURI} (${event.sourceFile ?? 'inline'})`
          )
        })
      })
      page.on('console', (message) => {
        // A refused request (a 401 while signed out, a 412 on purpose) is logged by the browser
        // as a failed resource; that is the API answering, not the page misbehaving.
        if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) {
          problems.console.push(message.text())
        }
      })
      page.on('pageerror', (error) => {
        problems.console.push(`uncaught: ${error.message}`)
      })
      await use(problems)
      expect(problems.csp, 'Content-Security-Policy violations').toEqual([])
      expect(problems.console, 'console errors').toEqual([])
    },
    { auto: true },
  ],
})

export { expect }

/**
 * The admin token of this run of the fixture: generated when it starts, read through its
 * guarded test route.
 */
export async function adminToken(page: Page): Promise<string> {
  const response = await page.request.get(`${API_URL}/__test/admin-token`)
  expect(response.ok()).toBe(true)
  return ((await response.json()) as { token: string }).token
}

/** Empty the rate limiter: every test comes from one address. */
export async function resetLimits(page: Page): Promise<void> {
  const response = await page.request.post(`${API_URL}/__test/reset-limits`)
  expect(response.ok()).toBe(true)
}

/**
 * Sign the browser context in without the form: the same request the form makes, from the
 * page's own cookie jar. The form itself is tested in `session.spec.ts`.
 */
export async function signIn(page: Page): Promise<void> {
  await resetLimits(page)
  const response = await page.request.post(`${API_URL}/v1/instance/session`, {
    headers: { 'x-tula-dashboard': '1', origin: API_URL },
    data: { token: await adminToken(page) },
  })
  expect(response.status()).toBe(200)
}

/** Open a dashboard path (relative to `/dashboard/`) and wait for its heading. */
export async function open(page: Page, path: string, heading: string | RegExp): Promise<void> {
  await page.goto(path)
  await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
}

/**
 * Run axe on the current screen in the light and the dark scheme, with no rule disabled.
 */
export async function expectScreenAccessible(page: Page, state: string): Promise<void> {
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))))
    await expectAccessible(page, `${state} (${colorScheme})`)
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
}

/**
 * Nothing a secret could be left in holds anything: both web storages are empty and the
 * address carries no query or fragment beyond what the test allows.
 *
 * @param secrets - Values that must not appear in storage, the address or the document.
 */
export async function expectNoSecretKept(page: Page, secrets: string[]): Promise<void> {
  const kept = await page.evaluate(() => ({
    local: JSON.stringify(Object.entries(localStorage)),
    session: JSON.stringify(Object.entries(sessionStorage)),
    cookie: document.cookie,
    text: document.documentElement.outerHTML,
    href: location.href,
  }))
  expect(kept.local, 'localStorage').toBe('[]')
  expect(kept.session, 'sessionStorage').toBe('[]')
  expect(kept.cookie, 'cookies readable by the page').toBe('')
  for (const secret of secrets) {
    expect(kept.text.includes(secret), 'secret left in the document').toBe(false)
    expect(kept.href.includes(secret), 'secret in the address').toBe(false)
  }
}

/** The example app (examples/react-vite), which the fixture serves next to the API. */
export const APP_URL = 'http://localhost:4317'

/**
 * Sign a new user up through the example app's components, in the given page. The dashboard's
 * project has the dashboard as its base URL, so the app's addresses are absolute here.
 */
export async function signUpInExampleApp(page: Page, email: string): Promise<void> {
  await page.goto(`${APP_URL}/sign-up`)
  await page.getByLabel('Email address').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
  await page.getByLabel('Verification code').fill(await latestCode(page.request, email))
  await page.getByRole('button', { name: 'Verify' }).click()
  await expect(page.getByRole('heading', { name: /^Hello/ })).toBeVisible()
}

/** Open the fixture environment's user with this email, from the users list's search. */
export async function openUser(page: Page, email: string): Promise<void> {
  await open(page, `${ENVIRONMENT_PATH}/users`, 'Users')
  await page.getByLabel('Search users').fill(email)
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  await page.getByRole('link', { name: email }).click()
  await expect(page.getByRole('heading', { level: 1, name: email })).toBeVisible()
}

/** The open dialog. Only one is ever open at a time. */
export function dialog(page: Page) {
  return page.getByRole('dialog')
}
