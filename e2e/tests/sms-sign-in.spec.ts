import { type APIRequestContext, expect, type Page, test } from '@playwright/test'
import {
  API_URL,
  expectAccessible,
  latestSmsCode,
  resetLimits,
  signOut,
  signUp,
  type TestSettings,
  uniqueEmail,
  uniquePhoneNumber,
  useSettings,
} from './support'

// Signing in with a texted code (ADR 0037), through the example app's sign-in page against
// the real API: the number, the one click that asks for the message, the code (read from the
// fixture's SMS outbox) and the signed-in page. A number nobody holds is shown the same
// screens and is texted nothing. axe runs on every state, in both colour schemes.

/** The password and the texted code, with text messages to the United States. */
const SMS_SIGN_IN: TestSettings = {
  signIn: {
    methods: {
      password: { enabled: true },
      emailCode: { enabled: false },
      emailLink: { enabled: false },
      smsCode: { enabled: true },
    },
  },
  sms: { enabled: true, allowedCountries: ['US'] },
}

const FIELD = 'Email address or phone number'

test.beforeEach(async ({ request }) => {
  await resetLimits(request)
})

test.afterEach(async ({ request }) => {
  await useSettings(request)
})

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

/** How many text messages the fixture has sent to a number. */
async function textsTo(request: APIRequestContext, to: string): Promise<number> {
  const response = await request.get(`${API_URL}/__test/sms?to=${encodeURIComponent(to)}`)
  const { data } = (await response.json()) as { data: unknown[] }
  return data.length
}

/** As a person types a United States number. */
function typed(number: string): string {
  return `${number.slice(0, 2)} (${number.slice(2, 5)}) ${number.slice(5, 8)}-${number.slice(8)}`
}

/** Sign up, prove `number` on the account page, and come back signed out. */
async function accountWithNumber(page: Page, request: APIRequestContext, number: string) {
  await signUp(page, request, { email: uniqueEmail('sms'), firstName: 'Maya' })
  await page.goto('/account')
  const phone = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Phone number' }) })
    .last()
  await phone.getByRole('button', { name: 'Add a phone number' }).click()
  await phone.getByLabel('Phone number').fill(number)
  await phone.getByRole('button', { name: 'Send code' }).click()
  await phone.getByLabel('Verification code').fill(await latestSmsCode(request, number))
  await phone.getByRole('button', { name: 'Verify' }).click()
  await expect(phone.getByText('Your phone number was added.')).toBeVisible()
  await page.goto('/')
  await signOut(page)
  // The number was texted a moment ago; its one message a minute would refuse the next.
  await resetLimits(request)
}

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme })

    test('sign in with a code texted to the account’s number', async ({ page, request }) => {
      await useSettings(request, SMS_SIGN_IN)
      const number = uniquePhoneNumber()
      await accountWithNumber(page, request, number)
      const before = await textsTo(request, number)

      await page.goto('/sign-in')
      const field = page.getByLabel(FIELD)
      await expect(field).toBeVisible()
      await expectAccessible(page, 'sign-in, an address or a phone number')
      await field.fill(typed(number))
      await page.getByRole('button', { name: 'Continue', exact: true }).click()

      // Arriving sends nothing: a message is asked for with a click.
      const ask = page.getByRole('heading', { name: 'Text me a code' })
      await expect(ask).toBeFocused()
      expect(await textsTo(request, number)).toBe(before)
      await expectAccessible(page, 'sign-in, text me a code')

      await page.getByRole('button', { name: 'Text me a code' }).click()
      await expect(page.getByRole('heading', { name: 'Check your phone' })).toBeFocused()
      const code = page.getByLabel('Verification code')
      await expect(code).toHaveAttribute('autocomplete', 'one-time-code')
      await expect(
        page.getByText(`the number ending in ${number.slice(-2)}`, { exact: false })
      ).toBeVisible()
      await expectAccessible(page, 'sign-in, texted code, empty')

      // The message is sent after the answer: wait for it, then read its code.
      await expect.poll(() => textsTo(request, number)).toBe(before + 1)
      const texted = await latestSmsCode(request, number)
      await code.fill(texted === '000000' ? '000001' : '000000')
      await page.getByRole('button', { name: 'Sign in', exact: true }).click()
      await expect(page.getByRole('alert')).toHaveText(
        'That code did not sign you in. Check it, ask for a new one, or sign in another way.'
      )
      await expect(code).toBeFocused()
      await expectAccessible(page, 'sign-in, texted code, wrong code')

      await code.fill(texted)
      await page.getByRole('button', { name: 'Sign in', exact: true }).click()
      await expect(page.getByRole('heading', { name: /^Hello/ })).toBeVisible()

      // Neither the number nor the code is left where a script can read it.
      const readable = await readableByScript(page)
      expect(readable).not.toContain(number.slice(1))
      expect(readable).not.toContain(texted)
      expect(page.url()).not.toContain(number.slice(1))
    })

    test('a number nobody holds is shown the same screens and texted nothing', async ({
      page,
      request,
    }) => {
      await useSettings(request, SMS_SIGN_IN)
      const number = uniquePhoneNumber()

      await page.goto('/sign-in')
      await page.getByLabel(FIELD).fill(number)
      await page.getByRole('button', { name: 'Continue', exact: true }).click()
      await page.getByRole('button', { name: 'Text me a code' }).click()
      await expect(page.getByRole('heading', { name: 'Check your phone' })).toBeFocused()
      // The words never claim a message went.
      await expect(page.getByText('If you can sign in with the number ending in')).toBeVisible()
      await expectAccessible(page, 'sign-in, texted code, unknown number')

      await page.getByLabel('Verification code').fill('123456')
      await page.getByRole('button', { name: 'Sign in', exact: true }).click()
      await expect(page.getByRole('alert')).toHaveText(
        'That code did not sign you in. Check it, ask for a new one, or sign in another way.'
      )
      expect(await textsTo(request, number)).toBe(0)

      // "Change" leads back to the first screen.
      await page.getByRole('button', { name: 'Change' }).click()
      await expect(page.getByLabel(FIELD)).toBeVisible()
    })
  })
}
