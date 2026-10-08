import { API_URL } from '../support'
import {
  adminToken,
  ENVIRONMENT_PATH,
  expect,
  expectNoSecretKept,
  expectScreenAccessible,
  open,
  resetLimits,
  signIn,
  test,
} from './support'

// The dashboard's session, in a real browser, with the app served by the API at /dashboard
// under its Content-Security-Policy (ADR 0032).

test.beforeEach(async ({ page }) => {
  await resetLimits(page)
})

test('the app is served by the API with its Content-Security-Policy', async ({ page }) => {
  const response = await page.goto('')
  expect(response?.status()).toBe(200)
  const policy = response?.headers()['content-security-policy'] ?? ''
  expect(policy).toContain("script-src 'self'")
  expect(policy).toContain("style-src 'self'")
  expect(policy).not.toContain('unsafe-inline')
  await expect(page.getByRole('heading', { name: 'Sign in to the dashboard' })).toBeVisible()
  // The stylesheet was applied (a blocked one would leave the browser's defaults).
  const display = await page.locator('main').evaluate((main) => getComputedStyle(main).display)
  expect(display).toBe('flex')
})

test('a wrong token is refused and the right one signs in', async ({ page }) => {
  await page.goto('')
  await expect(page).toHaveURL(/\/dashboard\/sign-in/)
  await expectScreenAccessible(page, 'dashboard sign-in')

  const token = page.getByLabel('Admin token')
  await expect(token).toHaveAttribute('type', 'password')
  await expect(token).toHaveAttribute('autocomplete', 'off')
  await token.fill('not-the-admin-token-of-this-deployment')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('alert')).toContainText('not this deployment’s admin token')
  // Cleared on submit, and focus is back in the field.
  await expect(token).toHaveValue('')
  await expect(token).toBeFocused()
  await expectScreenAccessible(page, 'dashboard sign-in, refused')

  const secret = await adminToken(page)
  await token.fill(secret)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Acme Studio' })).toBeVisible()
  await expectNoSecretKept(page, [secret])
  await expectScreenAccessible(page, 'workspace')

  // The session cookie is HttpOnly and scoped to the two API route groups.
  const cookies = (await page.context().cookies(`${API_URL}/v1/instance/session`)).filter(
    (cookie) => cookie.name === 'tula_dashboard'
  )
  expect(cookies.length).toBeGreaterThan(0)
  expect(cookies.every((cookie) => cookie.httpOnly && cookie.sameSite === 'Strict')).toBe(true)
})

test('an empty token is refused in the form', async ({ page }) => {
  await page.goto('sign-in')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('alert')).toHaveText('Enter the admin token.')
})

test('a session that ended returns to sign-in and comes back to the same screen', async ({
  page,
}) => {
  await signIn(page)
  await open(page, `${ENVIRONMENT_PATH}/users`, 'Users')
  // The cookie is gone (expired, or the token was rotated): the next call is a 401.
  await page.context().clearCookies()
  await page.getByRole('link', { name: 'Diagnostics' }).click()
  await expect(page.getByRole('heading', { name: 'Sign in to the dashboard' })).toBeVisible()
  await expect(page).toHaveURL(/sign-in\?redirect=/)

  await page.getByLabel('Admin token').fill(await adminToken(page))
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Diagnostics' })).toBeVisible()
  await expect(page).toHaveURL(/\/dashboard\/instance\/diagnostics$/)
})

test('a deep link asks for sign-in first and then opens', async ({ page }) => {
  await page.goto(`${ENVIRONMENT_PATH}/users`)
  await expect(page.getByRole('heading', { name: 'Sign in to the dashboard' })).toBeVisible()
  await page.getByLabel('Admin token').fill(await adminToken(page))
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Users' })).toBeVisible()
})

test('sign-out ends the session', async ({ page }) => {
  await signIn(page)
  await open(page, '', 'Acme Studio')
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByRole('heading', { name: 'Sign in to the dashboard' })).toBeVisible()
  await expect(page).toHaveURL(/\/dashboard\/sign-in$/)
  await page.goto(`${ENVIRONMENT_PATH}/users`)
  await expect(page.getByRole('heading', { name: 'Sign in to the dashboard' })).toBeVisible()
})
