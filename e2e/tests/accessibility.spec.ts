import { expect, test } from '@playwright/test'
import {
  emailCount,
  expectAccessible,
  latestCode,
  PASSWORD,
  resetLimits,
  signUp,
  uniqueEmail,
} from './support'

// axe on every screen and state the components can show against the real API, in both colour
// schemes. No rule is disabled (see `expectAccessible`).

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme })

    test.beforeEach(async ({ request }) => {
      await resetLimits(request)
    })

    test('sign-up: empty, checklist in progress, field errors, the emailed code and a wrong code', async ({
      page,
      request,
    }) => {
      const email = uniqueEmail('axe.up')
      await page.goto('/sign-up')
      await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible()
      await expect(page.getByText('10 or more characters')).toBeVisible()
      await expectAccessible(page, 'sign-up, empty')

      await page.getByRole('button', { name: 'Continue' }).click()
      await expect(page.getByRole('alert')).toHaveCount(2)
      await expectAccessible(page, 'sign-up, required fields missing')

      await page.getByLabel('Email address').fill(email)
      await page.getByLabel('Password', { exact: true }).fill('password1')
      await expectAccessible(page, 'sign-up, checklist partly met')
      await page.getByRole('button', { name: 'Show password' }).click()
      await page.getByRole('button', { name: 'Continue' }).click()
      await expect(page.getByRole('alert')).toBeVisible()
      await expectAccessible(page, 'sign-up, password refused by the server')

      await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
      await page.getByRole('button', { name: 'Continue' }).click()
      await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
      await expectAccessible(page, 'verification, empty')

      const code = await latestCode(request, email)
      await page.getByLabel('Verification code').fill(code === '000000' ? '000001' : '000000')
      await page.getByRole('button', { name: 'Verify' }).click()
      await expect(page.getByRole('alert')).toContainText('attempts left')
      await page.getByRole('button', { name: 'Resend code' }).click()
      await expect(page.getByRole('button', { name: /Resend code in/ })).toBeVisible()
      await expectAccessible(page, 'verification, wrong code and resend cooldown')
    })

    test('sign-in: email, password, a wrong password, forgotten password and its new-password screen', async ({
      page,
      request,
    }) => {
      const email = uniqueEmail('axe.in')
      await signUp(page, request, { email, firstName: 'Axel' })
      await page.getByRole('button', { name: /^Account menu for/ }).click()
      await page.getByRole('menuitem', { name: 'Sign out' }).click()
      await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
      await expect(page.getByText(/^to continue to/)).toBeVisible()
      await expectAccessible(page, 'sign-in, email')

      await page.getByLabel('Email address').fill(email)
      await page.getByRole('button', { name: 'Continue' }).click()
      await expect(page.getByRole('heading', { name: 'Enter your password' })).toBeVisible()
      await expectAccessible(page, 'sign-in, password')

      await page.getByLabel('Password', { exact: true }).fill('not-the-password-at-all')
      await page.getByRole('button', { name: 'Sign in' }).click()
      await expect(page.getByRole('alert')).toBeVisible()
      await expectAccessible(page, 'sign-in, wrong password')

      await resetLimits(request)
      const before = await emailCount(request, email)
      await page.getByRole('button', { name: 'Forgot password?' }).click()
      await expect(page.getByRole('heading', { name: 'Reset your password' })).toBeVisible()
      await expectAccessible(page, 'reset, email')
      await page.getByRole('button', { name: 'Send code' }).click()
      await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible()
      await latestCode(request, email, before)
      await page.getByLabel('New password', { exact: true }).fill('short')
      await expectAccessible(page, 'reset, code and new password')
      await page.getByRole('button', { name: 'Reset password' }).click()
      await expect(page.getByRole('alert')).toHaveCount(1)
      await expectAccessible(page, 'reset, code missing')
    })

    test('signed in: home, the user menu, the account dialog and the account page', async ({
      page,
      request,
      browser,
    }) => {
      const email = uniqueEmail('axe.me')
      await signUp(page, request, { email, firstName: 'Axel' })
      await expectAccessible(page, 'home, signed in')

      await page.getByRole('button', { name: /^Account menu for/ }).click()
      await expect(page.getByRole('menu')).toBeVisible()
      await expectAccessible(page, 'user menu open')

      await page.getByRole('menuitem', { name: 'Manage account' }).click()
      await expect(page.getByRole('dialog', { name: 'Account' })).toBeVisible()
      await expect(page.locator('[data-tula-element="sessionItem"]')).toHaveCount(1)
      await expectAccessible(page, 'account dialog')
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(page.getByRole('button', { name: /^Account menu for/ })).toBeFocused()

      // A second device, so the list has a row with a sign-out button.
      const other = await browser.newContext()
      const second = await other.newPage()
      await second.goto('/sign-in')
      await second.getByLabel('Email address').fill(email)
      await second.getByRole('button', { name: 'Continue' }).click()
      await second.getByLabel('Password', { exact: true }).fill(PASSWORD)
      await second.getByRole('button', { name: 'Sign in' }).click()
      await expect(second.getByRole('heading', { name: /^Hello/ })).toBeVisible()

      await page.getByRole('link', { name: 'Manage your account' }).click()
      await expect(page.locator('[data-tula-element="sessionItem"]')).toHaveCount(2)
      await expectAccessible(page, 'account page, two devices')

      await page.getByLabel('Current password', { exact: true }).fill('not-the-password-at-all')
      await page.getByLabel('New password', { exact: true }).fill('short')
      await page.getByRole('button', { name: 'Update password' }).click()
      await expect(page.getByRole('alert')).toBeVisible()
      await expectAccessible(page, 'account page, password change refused')
      await other.close()
    })

    test('signed out: the landing page', async ({ page }) => {
      await page.goto('/')
      await expect(page.getByRole('heading', { name: 'Northline' })).toBeVisible()
      await expectAccessible(page, 'landing')
    })
  })
}
