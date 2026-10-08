import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { resetLimits, signUp, uniqueEmail } from '../support'

// Regenerates the screenshots the Next.js example's README shows
// (examples/nextjs-app-router/docs). Not part of the suite: it only runs when asked for.
//
//   bun run e2e:screenshots

test.skip(!process.env.SCREENSHOTS, 'run with `bun run e2e:screenshots`')

const docs = join(import.meta.dirname, '..', '..', '..', 'examples', 'nextjs-app-router', 'docs')
const DESKTOP = { width: 1000, height: 740 }
const PHONE = { width: 375, height: 760 }

async function shot(page: Page, name: string): Promise<void> {
  // Let transitions (focus rings) settle.
  await page.waitForTimeout(300)
  await page.screenshot({ path: join(docs, `${name}.png`), animations: 'disabled' })
}

test.beforeEach(async ({ request }) => {
  await resetLimits(request)
})

test('the Next.js example: home, the redirect to sign-in, the dashboard and the profile', async ({
  page,
  request,
}) => {
  await page.setViewportSize(DESKTOP)
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Northline' })).toBeVisible()
  await shot(page, 'home')

  // A protected page, signed out: the proxy sends the visitor to sign-in.
  await page.goto('/dashboard')
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  await shot(page, 'sign-in-redirect')

  await signUp(page, request, { email: uniqueEmail('next-shots'), firstName: 'Maya' })
  await page.getByRole('button', { name: 'Ask the server who I am' }).click()
  await expect(page.getByTestId('action-result')).toContainText('The server action ran as')
  await shot(page, 'dashboard')

  await page.goto('/profile')
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()
  await shot(page, 'profile')

  await page.emulateMedia({ colorScheme: 'dark' })
  await page.setViewportSize(PHONE)
  await page.goto('/dashboard')
  await expect(page.getByRole('heading', { name: 'Hello, Maya' })).toBeVisible()
  await shot(page, 'mobile-dashboard-dark')
})
