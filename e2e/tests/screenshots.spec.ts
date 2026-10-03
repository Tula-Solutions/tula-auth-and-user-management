import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { latestCode, PASSWORD, resetLimits, signUp, uniqueEmail } from './support'

// Regenerates the screenshots the READMEs show (examples/react-vite/docs). Not part of the
// suite: it only runs when asked for.
//
//   bun run e2e:screenshots

test.skip(!process.env.SCREENSHOTS, 'run with `bun run e2e:screenshots`')

const docs = join(import.meta.dirname, '..', '..', 'examples', 'react-vite', 'docs')
const DESKTOP = { width: 1000, height: 740 }
const PHONE = { width: 375, height: 760 }

async function shot(page: Page, name: string): Promise<void> {
  // Let transitions (the strength bar, focus rings) settle.
  await page.waitForTimeout(300)
  await page.screenshot({ path: join(docs, `${name}.png`), animations: 'disabled' })
}

test.beforeEach(async ({ request }) => {
  await resetLimits(request)
})

test('sign-up with the checklist, the emailed code, and the profile', async ({ page, request }) => {
  await page.setViewportSize(DESKTOP)
  await page.goto('/sign-up')
  await page.getByLabel('First name').fill('Maya')
  await page.getByLabel('Last name').fill('Torres')
  await page.getByLabel('Email address').fill('maya@northline.app')
  await page.getByLabel('Password', { exact: true }).fill('maya-2026')
  await expect(page.getByText('Not met: 10 or more characters')).toBeAttached()
  await shot(page, 'sign-up-checklist')

  const email = uniqueEmail('maya')
  await page.getByLabel('Email address').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
  const code = await latestCode(request, email)
  await page.getByLabel('Verification code').fill(code === '000000' ? '000001' : '000000')
  await page.getByRole('button', { name: 'Verify' }).click()
  await expect(page.getByRole('alert')).toContainText('attempts left')
  await shot(page, 'verification')

  await page.getByLabel('Verification code').fill(code)
  await page.getByRole('button', { name: 'Verify' }).click()
  await page.getByRole('link', { name: 'Manage your account' }).click()
  await expect(page.locator('[data-tula-element="sessionItem"]')).toHaveCount(1)
  await page.setViewportSize({ width: 1000, height: 900 })
  await shot(page, 'user-profile')
})

test('sign-in, light and dark, and sign-up on a phone', async ({ page, request, browser }) => {
  const email = uniqueEmail('maya')
  await signUp(page, request, { email })
  await page.getByRole('button', { name: /^Account menu for/ }).click()
  await page.getByRole('menuitem', { name: 'Sign out' }).click()
  await page.setViewportSize(DESKTOP)
  await page.getByLabel('Email address').fill('maya@northline.app')
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('heading', { name: 'Enter your password' })).toBeVisible()
  await page.getByLabel('Password', { exact: true }).focus()
  await shot(page, 'sign-in')

  const dark = await browser.newContext({ colorScheme: 'dark', viewport: DESKTOP })
  const night = await dark.newPage()
  await night.goto('/sign-in')
  await expect(night.getByText(/^to continue to/)).toBeVisible()
  await shot(night, 'dark-sign-in')
  await dark.close()

  const phone = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2 })
  const mobile = await phone.newPage()
  await mobile.goto('/sign-up')
  await mobile.getByLabel('Email address').fill('maya@northline.app')
  await mobile.getByLabel('Password', { exact: true }).fill('northline-rocks')
  await expect(mobile.getByText('Met: 10 or more characters')).toBeAttached()
  await shot(mobile, 'mobile-sign-up')
  await phone.close()
})
