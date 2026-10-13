import { expect, type Page, test } from '@playwright/test'
import {
  expectAccessible,
  HISTORY_OF_THREE,
  NEW_PASSWORD,
  PASSWORD,
  resetLimits,
  signUp,
  uniqueEmail,
  useSettings,
} from './support'

// The password history (ADR 0038) on the example app's account page, against the real API:
// the checklist's line that only the server can judge, waiting and then refused, and never
// drawn as met. axe runs on both states, in both colour schemes.

test.beforeEach(async ({ request }) => {
  await resetLimits(request)
})

test.afterEach(async ({ request }) => {
  await useSettings(request)
})

const REUSED = 'You have used this password recently. Choose a different one.'

/** The history line of the new password's checklist. */
const line = (page: Page) =>
  page.getByRole('listitem').filter({ hasText: 'Not one of your last 3 passwords' })

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme })

    test('a reused password fails the history line; another one is accepted', async ({
      page,
      request,
    }) => {
      await useSettings(request, HISTORY_OF_THREE)
      await signUp(page, request, { email: uniqueEmail('history') })
      await page.goto('/account')
      const current = page.getByLabel('Current password', { exact: true })
      const next = page.getByLabel('New password', { exact: true })

      // Listed with the policy's number, waiting for the server: in words, not only an icon.
      await expect(line(page)).toHaveAttribute('data-state', 'pending')
      await expect(line(page)).toContainText('(Checked when you save)')
      await expectAccessible(page, 'account, password history waiting')

      // Every rule a browser can judge is met by the current password; this one is not
      // drawn as met with them.
      await current.fill(PASSWORD)
      await next.fill(PASSWORD)
      await expect(line(page)).toHaveAttribute('data-met', 'false')
      await expect(line(page)).not.toHaveClass(/tula-is-met/)
      await expectAccessible(page, 'account, password typed, history still waiting')

      await page.getByRole('button', { name: 'Update password' }).click()
      await expect(page.getByRole('alert')).toHaveText(REUSED)
      await expect(next).toBeFocused()
      await expect(next).toHaveAttribute('aria-invalid', 'true')
      await expect(line(page)).toHaveAttribute('data-state', 'failed')
      await expect(line(page)).toContainText('Not met')
      await expect(line(page)).not.toContainText('Checked when you save')
      await expectAccessible(page, 'account, password refused as reused')

      // The refusal was about the password that was sent: another one is undecided again.
      await next.fill(NEW_PASSWORD)
      await expect(line(page)).toHaveAttribute('data-state', 'pending')
      await current.fill(PASSWORD)
      await page.getByRole('button', { name: 'Update password' }).click()
      await expect(page.getByText('Your password was changed.')).toBeVisible()

      // The password before the current one is one of the three.
      await current.fill(NEW_PASSWORD)
      await next.fill(PASSWORD)
      await page.getByRole('button', { name: 'Update password' }).click()
      await expect(page.getByRole('alert')).toHaveText(REUSED)
      await expect(line(page)).toHaveAttribute('data-state', 'failed')
    })
  })
}

test('a policy that remembers no passwords lists no history line', async ({ page, request }) => {
  await signUp(page, request, { email: uniqueEmail('nohistory') })
  await page.goto('/account')
  await expect(page.getByRole('list', { name: 'Password requirements' })).toBeVisible()
  await expect(page.getByText('Checked when you save')).toHaveCount(0)
})
