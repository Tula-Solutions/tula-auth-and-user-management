import AxeBuilder from '@axe-core/playwright'
import { type APIRequestContext, expect, type Page } from '@playwright/test'

/** The fixture's API (e2e/server.ts). */
export const API_URL = 'http://localhost:4318'

export const PASSWORD = 'sturdy-Otter-plays-42-chess'
export const NEW_PASSWORD = 'quiet-Heron-wades-17-rivers'

let counter = 0

/** A fresh address per scenario: the fixture's memory is shared by the whole run. */
export function uniqueEmail(tag: string): string {
  counter += 1
  return `${tag}.${Date.now().toString(36)}${counter}@northline.test`
}

/**
 * The newest 6-digit code emailed to an address, read from the fixture's outbox.
 *
 * @param request - Playwright's API client (the test process, not the page).
 * @param email - The recipient.
 * @param after - Ignore the first `after` messages to this address (to wait for a new one).
 */
export async function latestCode(
  request: APIRequestContext,
  email: string,
  after = 0
): Promise<string> {
  let code: string | undefined
  await expect
    .poll(
      async () => {
        const response = await request.get(
          `${API_URL}/__test/outbox?to=${encodeURIComponent(email)}`
        )
        const { data } = (await response.json()) as { data: { subject: string }[] }
        code = data.length > after ? /^(\d{6})\b/.exec(data.at(-1)?.subject ?? '')?.[1] : undefined
        return code
      },
      { message: `an email with a code for ${email}` }
    )
    .toBeTruthy()
  return code as string
}

/** How many emails an address has received. */
export async function emailCount(request: APIRequestContext, email: string): Promise<number> {
  const response = await request.get(`${API_URL}/__test/outbox?to=${encodeURIComponent(email)}`)
  return ((await response.json()) as { data: unknown[] }).data.length
}

/**
 * Empty the fixture's rate limiter. Every scenario comes from one address, and an inbox may be
 * emailed once a minute; a suite that ran into those limits would test nothing but them.
 */
export async function resetLimits(request: APIRequestContext): Promise<void> {
  const response = await request.post(`${API_URL}/__test/reset-limits`)
  expect(response.ok()).toBe(true)
}

/** Sign up through the components and land on the signed-in home page. */
export async function signUp(
  page: Page,
  request: APIRequestContext,
  account: { email: string; password?: string; firstName?: string }
): Promise<void> {
  await page.goto('/sign-up')
  if (account.firstName) {
    await page.getByLabel('First name').fill(account.firstName)
  }
  await page.getByLabel('Email address').fill(account.email)
  await page.getByLabel('Password', { exact: true }).fill(account.password ?? PASSWORD)
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
  await page.getByLabel('Verification code').fill(await latestCode(request, account.email))
  await page.getByRole('button', { name: 'Verify' }).click()
  await expect(page.getByRole('heading', { name: /^Hello/ })).toBeVisible()
}

/** Sign in through the components and land on the signed-in home page. */
export async function signIn(page: Page, email: string, password = PASSWORD): Promise<void> {
  await page.goto('/sign-in')
  await page.getByLabel('Email address').fill(email)
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
}

/** Sign out through the user button's menu. */
export async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Account menu for/ }).click()
  await page.getByRole('menuitem', { name: 'Sign out' }).click()
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
}

/**
 * Run axe on the page as it is now and fail on any violation: WCAG 2.0, 2.1 and 2.2 at A and
 * AA, plus axe's best practices. No rule is disabled.
 *
 * @param page - The page.
 * @param state - Names the screen and state in the failure message.
 */
export async function expectAccessible(page: Page, state: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze()
  const problems = results.violations.map((violation) => ({
    rule: violation.id,
    impact: violation.impact,
    help: violation.help,
    nodes: violation.nodes.map((node) => `${node.target.join(' ')} — ${node.failureSummary}`),
  }))
  expect(problems, `axe violations on: ${state}`).toEqual([])
}
