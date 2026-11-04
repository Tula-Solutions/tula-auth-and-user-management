import { expect, test } from '@playwright/test'
import {
  bindSsoDomain,
  expectAccessible,
  hintAtIdp,
  resetLimits,
  restoreSettings,
  uniqueEmail,
} from '../support'

// Single sign-on through the same-origin proxy: the start and the ticket exchange go to the
// app's own origin, and the server-rendered page knows the user afterwards.

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme })

    test.beforeEach(async ({ request }) => {
      await resetLimits(request)
    })

    test.afterEach(async ({ request }) => {
      await restoreSettings(request)
    })

    test('Continue with SSO returns to the app signed in', async ({ page, request }) => {
      const domain = `next-sso-${colorScheme}.example.test`
      await bindSsoDomain(request, domain)
      const email = uniqueEmail('next-sso').replace(/@.*/, `@${domain}`)
      await hintAtIdp(page, email)

      await page.goto('/dashboard')
      await page.getByLabel('Email address').fill(email)
      await page.getByRole('button', { name: 'Continue', exact: true }).click()
      // The domain's connection is offered beside the password (enforcement is a setting of its own).
      await page
        .getByRole('list', { name: 'Other ways to sign in' })
        .getByRole('button', { name: 'Continue with SSO' })
        .click()
      await expect(page.getByRole('heading', { name: 'Continue with SSO' })).toBeVisible()
      await expectAccessible(page, `next sign-in: continue with SSO (${colorScheme})`)

      await page.getByRole('button', { name: 'Continue with SSO' }).click()
      await expect(page).toHaveURL('http://localhost:4319/dashboard')
      await expect(page.getByTestId('server-email')).toHaveText(email)
      expect(page.url()).not.toContain('#')
    })
  })
}
