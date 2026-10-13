import { expect, type Page, test } from '@playwright/test'
import {
  advanceClock,
  EXPIRY_OF_ONE_DAY,
  expectAccessible,
  NEW_PASSWORD,
  PASSWORD,
  resetClock,
  resetLimits,
  signIn,
  signOut,
  signUp,
  uniqueEmail,
  useSettings,
} from './support'

// Password expiry (ADR 0041) through the example app's sign-in, against the real API: a
// right password that is a day old where passwords expire after one stops on "Your password
// has expired", signs nobody in until a new one is set, and refuses the old one as the new.
// axe runs on the screen as it opens and after a refusal, in both colour schemes.

const DAY = 86_400_000
const REUSED = 'You have used this password recently. Choose a different one.'

test.beforeEach(async ({ request }) => {
  await resetLimits(request)
})

test.afterEach(async ({ request }) => {
  await useSettings(request)
})

test.afterAll(async ({ request }) => {
  // Each scenario moves the fixture's clock a day forward. The specs that run after this
  // file get the real time back, and limits counted in the skewed time are emptied with it.
  await resetClock(request)
  await resetLimits(request)
})

/** The line of the new password's checklist that only the server can judge. */
const line = (page: Page) =>
  page.getByRole('listitem').filter({ hasText: 'Not your current password' })

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme })

    test('an expired password is replaced before the sign-in completes', async ({
      page,
      request,
    }) => {
      await useSettings(request, EXPIRY_OF_ONE_DAY)
      const email = uniqueEmail('expiry')
      await signUp(page, request, { email })
      await signOut(page)

      // On the day it was set the password signs in.
      await signIn(page, email)
      await expect(page.getByRole('heading', { name: /^Hello/ })).toBeVisible()
      await signOut(page)

      await advanceClock(request, DAY)
      await signIn(page, email)
      const title = page.getByRole('heading', { name: 'Your password has expired' })
      await expect(title).toBeVisible()
      // The reason is what a screen reader hears first.
      await expect(title).toBeFocused()
      await expect(page.getByText('Choose a new password to finish signing in.')).toBeVisible()
      // Nobody is signed in, and no emailed code belongs to this step.
      await expect(page.getByRole('button', { name: /^Account menu for/ })).toHaveCount(0)
      await expect(page.getByLabel('Verification code')).toHaveCount(0)
      await expect(line(page)).toHaveAttribute('data-state', 'pending')
      await expectAccessible(page, 'sign-in, password expired')

      // The expired password is not its own replacement, though the policy keeps no history.
      const next = page.getByLabel('New password', { exact: true })
      await next.fill(PASSWORD)
      await page.getByRole('button', { name: 'Save password and sign in' }).click()
      await expect(page.getByRole('alert')).toHaveText(REUSED)
      await expect(next).toBeFocused()
      await expect(next).toHaveAttribute('aria-invalid', 'true')
      await expect(line(page)).toHaveAttribute('data-state', 'failed')
      await expect(title).toBeVisible()
      await expectAccessible(page, 'sign-in, expired password refused as its own replacement')

      await next.fill(NEW_PASSWORD)
      await expect(line(page)).toHaveAttribute('data-state', 'pending')
      await page.getByRole('button', { name: 'Save password and sign in' }).click()
      await expect(page.getByRole('heading', { name: /^Hello/ })).toBeVisible()
      await signOut(page)

      // The new password signs in without being asked for again; the old one is wrong.
      await signIn(page, email, NEW_PASSWORD)
      await expect(page.getByRole('heading', { name: /^Hello/ })).toBeVisible()
      await signOut(page)
      await signIn(page, email)
      await expect(page.getByRole('alert')).toBeVisible()
      await expect(title).toHaveCount(0)
    })
  })
}
