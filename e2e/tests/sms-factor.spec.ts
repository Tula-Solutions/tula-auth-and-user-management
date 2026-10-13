import { type APIRequestContext, expect, type Page, test } from '@playwright/test'
import {
  addVirtualAuthenticator,
  advanceClock,
  expectAccessible,
  latestSmsCode,
  PASSWORD,
  resetLimits,
  signIn,
  signOut,
  signUp,
  type TestSettings,
  uniqueEmail,
  uniquePhoneNumber,
  useSettings,
} from './support'

// A texted code as the second step (ADR 0025), through the example app against the real
// API: a proven phone number, the enrolment on the account page, a sign-in that stops at the
// second step, the step-up dialog and the removal. Codes are read from the fixture's SMS
// outbox. axe runs on every state, in both colour schemes.

/** Text messages to the United States, and a texted code offered as the second step. */
const SMS_FACTOR_ON: TestSettings = {
  sms: { enabled: true, allowedCountries: ['US'] },
  mfa: { policy: 'optional', smsCode: { enabled: true } },
}
const SENT = 'We sent a 6-digit code by text message to the number ending in'

test.beforeEach(async ({ request }) => {
  await resetLimits(request)
})

test.afterEach(async ({ request }) => {
  await useSettings(request)
})

const twoStep = (page: Page) =>
  page.locator('section').filter({
    has: page.getByRole('heading', { name: 'Two-step verification' }),
  })
const phone = (page: Page) =>
  page.locator('section').filter({ has: page.getByRole('heading', { name: 'Phone number' }) })

/** A code that is not the one that was texted. */
const wrong = (code: string) => (code === '000000' ? '000001' : '000000')

/** Put a proven phone number on the signed-in account, through the account page. */
async function addPhoneNumber(page: Page, request: APIRequestContext, number: string) {
  await page.goto('/account')
  const section = phone(page).last()
  await section.getByRole('button', { name: 'Add a phone number' }).click()
  await section.getByLabel('Phone number').fill(number)
  await section.getByRole('button', { name: 'Send code' }).click()
  await section.getByLabel('Verification code').fill(await latestSmsCode(request, number))
  await section.getByRole('button', { name: 'Verify' }).click()
  await expect(section.getByText('Your phone number was added.')).toBeVisible()
  // One text a minute to a number: the next one in this scenario is not held to this one.
  await resetLimits(request)
}

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme })

    test('enrol a texted code, sign in with it, step up with it, then stop using it', async ({
      page,
      request,
    }) => {
      await useSettings(request, SMS_FACTOR_ON)
      const email = uniqueEmail('smsfactor')
      const number = uniquePhoneNumber()
      const ending = number.slice(-2)
      await signUp(page, request, { email, firstName: 'Maya' })
      await addPhoneNumber(page, request, number)

      // Enrolment: offered once the account has a proven number; the message is sent when
      // the user asks for it.
      const section = twoStep(page)
      await expect(
        section.getByText('You can also get a code by text message as your second step.')
      ).toBeVisible()
      await expectAccessible(page, 'account, texted code offered')
      await section.getByRole('button', { name: 'Use text messages' }).click()
      await expect(section.getByText(`${SENT} ${ending}.`)).toBeVisible()
      const enrolCode = section.getByLabel('Verification code')
      await expect(enrolCode).toHaveAttribute('autocomplete', 'one-time-code')
      await expectAccessible(page, 'texted code enrolment, empty')

      const first = await latestSmsCode(request, number)
      await enrolCode.fill(wrong(first))
      await section.getByRole('button', { name: 'Turn on' }).click()
      await expect(section.getByRole('alert')).toHaveText('That code is incorrect.')
      await expect(enrolCode).toBeFocused()
      await expectAccessible(page, 'texted code enrolment, wrong code')

      await enrolCode.fill(first)
      await section.getByRole('button', { name: 'Turn on' }).click()
      await expect(
        section.getByText('A code by text message is now your second step.')
      ).toBeVisible()
      await expect(
        section.getByText('A code by text message is your second step since', { exact: false })
      ).toBeVisible()
      await expect(section.getByRole('button', { name: 'Use text messages' })).toHaveCount(0)
      await expectAccessible(page, 'account, texted code on')
      expect(await page.content()).not.toContain(first)

      // Sign-in: the password is not enough, and nothing is texted until the button asks.
      await signOut(page)
      await resetLimits(request)
      await signIn(page, email, PASSWORD)
      await expect(page.getByRole('heading', { name: 'Two-step verification' })).toBeVisible()
      await expect(
        page.getByText('We will text a 6-digit code to the phone number on your account.')
      ).toBeVisible()
      await expect(page.getByLabel('Verification code')).toHaveCount(0)
      await expectAccessible(page, 'second step: texted code, nothing sent')
      // Still the enrolment's code: arriving at the screen sent no message.
      expect(await latestSmsCode(request, number)).toBe(first)

      await page.getByRole('button', { name: 'Text me a code' }).click()
      const signInCode = page.getByLabel('Verification code')
      await expect(signInCode).toBeFocused()
      await expect(page.getByText(`${SENT} ${ending}.`)).toBeVisible()
      await expectAccessible(page, 'second step: texted code, sent')
      await expect.poll(() => latestSmsCode(request, number)).not.toBe(first)
      const second = await latestSmsCode(request, number)

      // The enrolment's code is not a sign-in's, and a wrong code signs nobody in.
      await signInCode.fill(second === first ? wrong(first) : first)
      await page.getByRole('button', { name: 'Verify' }).click()
      await expect(page.getByRole('alert')).toHaveText('That code is incorrect.')
      await expect(signInCode).toBeFocused()
      await expectAccessible(page, 'second step: texted code, wrong code')
      await expect(page.getByRole('heading', { name: /^Hello/ })).toHaveCount(0)

      await signInCode.fill(second)
      await page.getByRole('button', { name: 'Verify' }).click()
      await expect(page.getByRole('heading', { name: /^Hello/ })).toBeVisible()

      // Step-up: once the sign-in is no longer recent, the second step is asked for again,
      // by text, never by password or email.
      await advanceClock(request, 11 * 60_000)
      await resetLimits(request)
      await page.goto('/account')
      await twoStep(page).getByRole('button', { name: 'Stop using text messages' }).click()
      const dialog = page.getByRole('dialog', { name: 'Confirm it is you' })
      await expect(
        dialog.getByText(
          'To continue, we will text a 6-digit code to the phone number on your account.'
        )
      ).toBeVisible()
      await expect(dialog.getByLabel('Password')).toHaveCount(0)
      await expect(dialog.getByRole('button', { name: 'Email me a code instead' })).toHaveCount(0)
      await expectAccessible(page, 'step-up dialog: texted code, nothing sent')
      expect(await latestSmsCode(request, number)).toBe(second)

      await dialog.getByRole('button', { name: 'Text me a code' }).click()
      const stepUpCode = dialog.getByLabel('Verification code')
      await expect(stepUpCode).toBeFocused()
      await expectAccessible(page, 'step-up dialog: texted code, sent')
      await expect.poll(() => latestSmsCode(request, number)).not.toBe(second)
      await stepUpCode.fill(await latestSmsCode(request, number))
      await dialog.getByRole('button', { name: 'Continue' }).click()
      await expect(dialog).toHaveCount(0)
      await expect(
        twoStep(page).getByText('Text messages are no longer your second step.')
      ).toBeVisible()
      // The number stays on the account, and the factor can be enrolled again.
      await expect(phone(page).last().getByText(number)).toBeVisible()
      await expect(twoStep(page).getByRole('button', { name: 'Use text messages' })).toBeVisible()
      await expectAccessible(page, 'account, texted code stopped')
    })
  })
}

test('an app that does not offer it shows no texted code, with a proven number too', async ({
  page,
  request,
}) => {
  await useSettings(request, { sms: { enabled: true, allowedCountries: ['US'] } })
  await signUp(page, request, { email: uniqueEmail('nosmsfactor'), firstName: 'Maya' })
  await addPhoneNumber(page, request, uniquePhoneNumber())
  await expect(twoStep(page).getByRole('button', { name: 'Turn on' })).toBeVisible()
  await expect(twoStep(page).getByRole('button', { name: 'Use text messages' })).toHaveCount(0)
})

test('switched off after it was enrolled, the sign-in is refused and says so; nothing is texted', async ({
  page,
  request,
}) => {
  await useSettings(request, SMS_FACTOR_ON)
  const email = uniqueEmail('smsfactoroff')
  const number = uniquePhoneNumber()
  await signUp(page, request, { email, firstName: 'Maya' })
  await addPhoneNumber(page, request, number)
  await twoStep(page).getByRole('button', { name: 'Use text messages' }).click()
  // The newest text is still the one that proved the number until the page says this one went.
  await expect(twoStep(page).getByText(`${SENT} ${number.slice(-2)}.`)).toBeVisible()
  const enrolled = await latestSmsCode(request, number)
  await twoStep(page).getByLabel('Verification code').fill(enrolled)
  await twoStep(page).getByRole('button', { name: 'Turn on' }).click()
  await expect(
    twoStep(page).getByText('A code by text message is now your second step.')
  ).toBeVisible()
  await signOut(page)
  await resetLimits(request)

  // The operator switches the factor off: it fails closed, never open.
  await useSettings(request, { sms: { enabled: true, allowedCountries: ['US'] } })
  await signIn(page, email, PASSWORD)
  await expect(page.getByRole('heading', { name: 'Two-step verification' })).toBeVisible()
  await page.getByRole('button', { name: 'Text me a code' }).click()
  await expect(page.getByRole('alert')).toHaveText('This sign-in method is not available.')
  await expect(page.getByLabel('Verification code')).toHaveCount(0)
  // Asking again could only be refused again: the button is gone, the way back is not.
  await expect(page.getByRole('button', { name: 'Text me a code' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Back to sign in' })).toBeVisible()
  await expectAccessible(page, 'second step: texted code, switched off')
  await expect(page.getByRole('heading', { name: /^Hello/ })).toHaveCount(0)
  expect(await latestSmsCode(request, number)).toBe(enrolled)
  await expectAccessible(page, 'second step: texted code, no longer offered')
})

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme, a passkey beside a texted code`, () => {
    test.use({ colorScheme })

    test('a passkey added beside a texted code: the page warns first, then the passkey is the second step', async ({
      page,
      request,
    }) => {
      await useSettings(request, {
        ...SMS_FACTOR_ON,
        signIn: {
          methods: {
            password: { enabled: true },
            emailCode: { enabled: true },
            emailLink: { enabled: false },
            passkey: { enabled: true },
          },
        },
      })
      const authenticator = await addVirtualAuthenticator(page)
      const email = uniqueEmail(`smsthenpasskey.${colorScheme}`)
      const number = uniquePhoneNumber()
      await signUp(page, request, { email, firstName: 'Maya' })
      await addPhoneNumber(page, request, number)
      await twoStep(page).getByRole('button', { name: 'Use text messages' }).click()
      // The newest text is still the one that proved the number until the page says this one went.
      await expect(twoStep(page).getByText(`${SENT} ${number.slice(-2)}.`)).toBeVisible()
      const enrolled = await latestSmsCode(request, number)
      await twoStep(page).getByLabel('Verification code').fill(enrolled)
      await twoStep(page).getByRole('button', { name: 'Turn on' }).click()
      await expect(
        twoStep(page).getByText('A code by text message is now your second step.')
      ).toBeVisible()

      // Before any ceremony: what adding a passkey does to the second step, and what it costs.
      const passkeys = page
        .locator('section')
        .filter({ has: page.getByRole('heading', { name: 'Passkeys' }) })
      const warning = passkeys.getByText(
        'Once you add a passkey, it replaces the code by text message as your second step.',
        { exact: false }
      )
      await expect(warning).toBeVisible()
      await expect(warning).toContainText('only an administrator of this app can let you back in')
      const add = passkeys.getByRole('button', { name: 'Add a passkey' })
      await expect(add).toHaveAccessibleDescription(/replaces the code by text message/)
      await expectAccessible(page, 'account, passkey would replace the texted code')

      await add.click()
      await expect(passkeys.getByText('Your passkey was added.')).toBeVisible()
      // The texted code is set aside, not gone, and the page says both halves.
      await expect(
        twoStep(page).getByText(
          'It is not asked for while you have an authenticator app or a passkey. If you remove that, the code by text message is your second step again.',
          { exact: false }
        )
      ).toBeVisible()
      await expect(warning).toHaveCount(0)
      await expectAccessible(page, 'account, texted code set aside by a passkey')

      // After a password the passkey is asked for, and no text can be asked for. The
      // authenticator is told to wait: left answering, it would sign in from the address
      // field's autofill, and a sign-in by passkey has no second step to look at.
      await authenticator.setAnswering(false)
      await signOut(page)
      await resetLimits(request)
      await signIn(page, email, PASSWORD)
      await expect(page.getByText('Use your passkey to finish signing in.')).toBeVisible()
      await expect(page.getByRole('button', { name: 'Text me a code' })).toHaveCount(0)
      expect(await latestSmsCode(request, number)).toBe(enrolled)
      await authenticator.setAnswering(true)
      await page.getByRole('button', { name: 'Use your passkey' }).click()
      await expect(page.getByRole('heading', { name: /^Hello/ })).toBeVisible()
    })
  })
}
