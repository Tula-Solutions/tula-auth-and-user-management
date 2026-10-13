import { expect, type Page, test } from '@playwright/test'
import {
  expectAccessible,
  latestSmsCode,
  resetLimits,
  SMS_ON,
  signUp,
  uniqueEmail,
  uniquePhoneNumber,
  useSettings,
} from './support'

// A phone number on an account (ADR 0037), through the example app's account page against
// the real API: the number, the code texted to it (read from the fixture's SMS outbox), the
// number on the account, and its removal. axe runs on every state, in both colour schemes.

test.beforeEach(async ({ request }) => {
  await resetLimits(request)
})

test.afterEach(async ({ request }) => {
  await useSettings(request)
})

const section = (page: Page) =>
  page.locator('section').filter({ has: page.getByRole('heading', { name: 'Phone number' }) })

/** Everything a script on the page can read: both web storages and `document.cookie`. */
async function readableByScript(page: Page): Promise<string> {
  return page.evaluate(() =>
    JSON.stringify({
      local: { ...window.localStorage },
      session: { ...window.sessionStorage },
      cookie: document.cookie,
    })
  )
}

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme })

    test('add a phone number with a texted code, then remove it', async ({ page, request }) => {
      await useSettings(request, SMS_ON)
      const number = uniquePhoneNumber()
      await signUp(page, request, { email: uniqueEmail('phone'), firstName: 'Maya' })
      await page.goto('/account')
      const phone = section(page).last()
      await expect(phone.getByText('No phone number.')).toBeVisible()
      await expectAccessible(page, 'account, no phone number')

      await phone.getByRole('button', { name: 'Add a phone number' }).click()
      const field = phone.getByLabel('Phone number')
      await expect(field).toBeFocused()
      await expect(field).toHaveAttribute('autocomplete', 'tel')
      await phone.getByRole('button', { name: 'Send code' }).click()
      await expect(phone.getByRole('alert')).toHaveText('This field is required.')
      await expectAccessible(page, 'phone number form, nothing typed')

      // A number of a country the environment does not text: said at the field.
      await field.fill('+49 151 12345678')
      await phone.getByRole('button', { name: 'Send code' }).click()
      await expect(phone.getByRole('alert')).toHaveText(
        'Text messages cannot be sent to that country.'
      )
      await expect(field).toBeFocused()
      await expectAccessible(page, 'phone number form, country not allowed')

      // As a person types it: the server stores it in one form.
      await field.fill(
        `${number.slice(0, 2)} (${number.slice(2, 5)}) ${number.slice(5, 8)}-${number.slice(8)}`
      )
      await phone.getByRole('button', { name: 'Send code' }).click()
      const code = phone.getByLabel('Verification code')
      await expect(code).toBeFocused()
      await expect(code).toHaveAttribute('autocomplete', 'one-time-code')
      await expect(
        phone.getByText(`to the number ending in ${number.slice(-2)}.`, { exact: false })
      ).toBeVisible()
      await expectAccessible(page, 'phone code form, empty')

      const texted = await latestSmsCode(request, number)
      await code.fill(texted === '000000' ? '000001' : '000000')
      await phone.getByRole('button', { name: 'Verify' }).click()
      await expect(phone.getByRole('alert')).toHaveText('That code is incorrect.')
      await expect(code).toBeFocused()
      await expectAccessible(page, 'phone code form, wrong code')

      await code.fill(texted)
      await phone.getByRole('button', { name: 'Verify' }).click()
      await expect(phone.getByText('Your phone number was added.')).toBeVisible()
      await expect(phone.getByText(number)).toBeVisible()
      await expect(phone.getByText('Verified')).toBeVisible()
      await expect(phone.getByRole('heading', { name: 'Phone number' })).toBeFocused()
      await expectAccessible(page, 'account, phone number added')

      // Neither the number nor the code is left where a script can read it, and the code
      // is nowhere on the page.
      const readable = await readableByScript(page)
      expect(readable).not.toContain(number.slice(1))
      expect(readable).not.toContain(texted)
      expect(await page.content()).not.toContain(texted)

      // A reload shows it from the server.
      await page.reload()
      await expect(section(page).last().getByText(number)).toBeVisible()

      await section(page).last().getByRole('button', { name: 'Remove phone number' }).click()
      await expect(section(page).last().getByText('Your phone number was removed.')).toBeVisible()
      await expect(section(page).last().getByText('No phone number.')).toBeVisible()
      await expectAccessible(page, 'account, phone number removed')
    })
  })
}

test('an app that sends no text messages offers no phone number', async ({ page, request }) => {
  await signUp(page, request, { email: uniqueEmail('nophone'), firstName: 'Maya' })
  await page.goto('/account')
  await expect(page.getByRole('heading', { name: 'Where you’re signed in' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Phone number' })).toHaveCount(0)
})
