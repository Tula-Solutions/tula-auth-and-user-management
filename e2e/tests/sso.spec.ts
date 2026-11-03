import { expect, test } from '@playwright/test'
import {
  bindSsoDomain,
  expectAccessible,
  hintAtIdp,
  resetLimits,
  restoreSettings,
  uniqueEmail,
} from './support'

// "Continue with SSO": the email step finds the organization's connection by the address's
// domain, the page goes to the identity provider (the API's mock) and returns signed in.

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme })

    test.beforeEach(async ({ request }) => {
      await resetLimits(request)
    })

    test.afterEach(async ({ request }) => {
      await restoreSettings(request)
    })

    test('SSO is the only way for a domain with a connection, and it signs the user in', async ({
      page,
      request,
    }) => {
      const domain = `sso-${colorScheme}.example.test`
      await bindSsoDomain(request, domain)
      const email = uniqueEmail('sso').replace(/@.*/, `@${domain}`)
      await hintAtIdp(page, email)

      await page.goto('/sign-in')
      await page.getByLabel('Email address').fill(email)
      await page.getByRole('button', { name: 'Continue', exact: true }).click()
      // The domain's connection is offered beside the password (enforcement is a setting of its own).
      await page
        .getByRole('list', { name: 'Other ways to sign in' })
        .getByRole('button', { name: 'Continue with SSO' })
        .click()
      await expect(page.getByRole('heading', { name: 'Continue with SSO' })).toBeVisible()
      await expect(page.getByLabel('Password')).toHaveCount(0)
      await expectAccessible(page, `sign-in: continue with SSO (${colorScheme})`)

      await page.getByRole('button', { name: 'Continue with SSO' }).click()
      await expect(page.getByRole('button', { name: /^Account menu for/ })).toBeVisible()
      expect(page.url()).not.toContain('tula_ticket')
      expect(await page.evaluate(() => Object.keys(sessionStorage))).toEqual([])
    })
  })
}
