import { type APIRequestContext, expect, type Page, test } from '@playwright/test'
import {
  advanceClock,
  authenticatorCode,
  expectAccessible,
  resetLimits,
  signIn,
  signOut,
  signUp,
  uniqueEmail,
  useSettings,
} from './support'

// Two-step verification in a real browser against the real API: enrolling in the profile,
// signing in with the authenticator and with a backup code, the step-up dialog, and enrolment
// inside a sign-in where the app requires it. The test plays the authenticator app: it reads
// the setup key the page shows and computes the code a phone would show.

test.beforeEach(async ({ request }) => {
  await resetLimits(request)
})

test.afterEach(async ({ request }) => {
  await useSettings(request)
})

const section = (page: Page) =>
  page.getByRole('region', { name: 'Account' }).locator('section', {
    has: page.getByRole('heading', { name: 'Two-step verification' }),
  })

/** The setup key as the page shows it. */
async function setupKey(page: Page): Promise<string> {
  const key = page.getByRole('group', { name: 'Setup key' }).locator('code')
  await expect(key).toBeVisible()
  return (await key.innerText()).replace(/\s/g, '')
}

/** The backup codes on the page (in the profile section or the provider's dialog). */
async function shownCodes(page: Page): Promise<string[]> {
  const list = page.getByRole('list', { name: 'Backup codes' })
  await expect(list.getByRole('listitem')).toHaveCount(10)
  return list.getByRole('listitem').allInnerTexts()
}

/** Turn two-step verification on in the profile; returns the setup key and the codes. */
async function enrol(page: Page, request: APIRequestContext) {
  await page.goto('/account')
  await section(page).getByRole('button', { name: 'Turn on' }).click()
  const secret = await setupKey(page)
  await expect(page.getByRole('img', { name: /QR code for your authenticator app/ })).toBeVisible()
  await page.getByLabel('Authentication code').fill(await authenticatorCode(request, secret))
  await section(page).getByRole('button', { name: 'Turn on' }).click()
  const codes = await shownCodes(page)
  await page.getByLabel('I have saved these codes').check()
  await page.getByRole('button', { name: 'Done' }).click()
  await expect(section(page).getByText(/^On since/)).toBeVisible()
  return { secret, codes }
}

/** Nothing of a secret may be left in the page or in web storage once its screen is gone. */
async function expectGone(page: Page, secrets: string[]): Promise<void> {
  const found = await page.evaluate((values) => {
    const haystack = [
      document.documentElement.outerHTML,
      JSON.stringify({ ...localStorage }),
      JSON.stringify({ ...sessionStorage }),
      location.href,
    ].join('\n')
    return values.filter((value) => haystack.includes(value))
  }, secrets)
  expect(found).toEqual([])
}

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme })

    test('enrol in the profile, then sign in with the authenticator: every screen passes axe', async ({
      page,
      request,
    }) => {
      const email = uniqueEmail(`mfa.${colorScheme}`)
      await signUp(page, request, { email, firstName: 'Maya' })
      await page.goto('/account')
      await expect(section(page).getByText(/^Off\./)).toBeVisible()
      await expectAccessible(page, 'account page, two-step verification off')

      await section(page).getByRole('button', { name: 'Turn on' }).click()
      const secret = await setupKey(page)
      expect(secret).toMatch(/^[A-Z2-7]{32}$/)
      await expect(
        page.getByRole('img', { name: /QR code for your authenticator app/ })
      ).toBeVisible()
      await expectAccessible(page, 'enrolment: QR code and setup key')

      await page.getByLabel('Authentication code').fill('000000')
      await section(page).getByRole('button', { name: 'Turn on' }).click()
      await expect(page.getByRole('alert')).toContainText('That code is incorrect.')
      await expectAccessible(page, 'enrolment: wrong code')

      await page.getByLabel('Authentication code').fill(await authenticatorCode(request, secret))
      await section(page).getByRole('button', { name: 'Turn on' }).click()
      const codes = await shownCodes(page)
      expect(new Set(codes).size).toBe(10)
      for (const code of codes) {
        expect(code).toMatch(/^[2-9a-z]{5}-[2-9a-z]{5}$/)
      }
      await expectAccessible(page, 'backup codes')
      // Leaving needs the explicit confirmation.
      await page.getByRole('button', { name: 'Done' }).click()
      await expect(page.getByRole('alert')).toHaveText('Confirm that you have saved the codes.')
      await expect(page.getByLabel('I have saved these codes')).toBeFocused()
      await expectAccessible(page, 'backup codes, not confirmed')
      await page.getByLabel('I have saved these codes').check()
      await page.getByRole('button', { name: 'Done' }).click()
      await expect(section(page).getByText(/^On since/)).toBeVisible()
      await expect(section(page).getByText('10 backup codes left.')).toBeVisible()
      await expectAccessible(page, 'account page, two-step verification on')
      await expectGone(page, [secret, ...codes])

      await signOut(page)
      await signIn(page, email)
      const title = page.getByRole('heading', { name: 'Two-step verification' })
      await expect(title).toBeFocused()
      await expectAccessible(page, 'second factor: authenticator code')
      await page.getByLabel('Authentication code').fill('000000')
      await page.getByRole('button', { name: 'Verify' }).click()
      await expect(page.getByRole('alert')).toContainText('That code is incorrect.')
      await expect(page.getByLabel('Authentication code')).toBeFocused()
      await expectAccessible(page, 'second factor: wrong code')
      await page.getByRole('button', { name: 'Use a backup code' }).click()
      await expectAccessible(page, 'second factor: backup code')
      await page.getByRole('button', { name: 'Use your authenticator app' }).click()
      await page.getByLabel('Authentication code').fill(await authenticatorCode(request, secret))
      await page.getByRole('button', { name: 'Verify' }).click()
      await expect(page.getByRole('heading', { name: /^Hello, Maya/ })).toBeVisible()
    })

    test('the step-up dialog and enrolment inside a sign-in pass axe', async ({
      page,
      request,
    }) => {
      const email = uniqueEmail(`mfa.dialogs.${colorScheme}`)
      await signUp(page, request, { email })
      // Ten minutes on, the sign-up no longer counts as a recent authentication.
      await advanceClock(request, 11 * 60_000)
      await page.goto('/account')
      await section(page).getByRole('button', { name: 'Turn on' }).click()
      const dialog = page.getByRole('dialog', { name: 'Confirm it is you' })
      await expect(dialog.getByLabel('Password', { exact: true })).toBeFocused()
      await expectAccessible(page, 'step-up dialog: password')
      await dialog.getByLabel('Password', { exact: true }).fill('not the password')
      await dialog.getByRole('button', { name: 'Continue' }).click()
      await expect(dialog.getByRole('alert')).toHaveText('That password is incorrect.')
      await expectAccessible(page, 'step-up dialog: wrong password')
      await dialog.getByRole('button', { name: 'Cancel' }).click()
      await expect(dialog).toBeHidden()

      await signOut(page)
      await useSettings(request, { mfa: { policy: 'required' } })
      await signIn(page, email)
      await expect(
        page.getByRole('heading', { name: 'Set up two-step verification' })
      ).toBeFocused()
      await expectAccessible(page, 'required enrolment: before it starts')
      await page.getByRole('button', { name: 'Set up authenticator app' }).click()
      const secret = await setupKey(page)
      await expectAccessible(page, 'required enrolment: QR code and setup key')
      await page.getByLabel('Authentication code').fill(await authenticatorCode(request, secret))
      await page.getByRole('button', { name: 'Turn on' }).click()
      const codesDialog = page.getByRole('dialog', { name: 'Save your backup codes' })
      await expect(codesDialog).toBeVisible()
      await expectAccessible(page, 'backup codes dialog')
    })
  })
}

test('a backup code signs in once, and the profile counts it', async ({ page, request }) => {
  const email = uniqueEmail('mfa.backup')
  await signUp(page, request, { email })
  const { codes } = await enrol(page, request)
  const [first] = codes as [string]
  await signOut(page)

  await signIn(page, email)
  await page.getByRole('button', { name: 'Use a backup code' }).click()
  // Typed as a person would: capitals and a space instead of the dash.
  await page.getByLabel('Backup code').fill(first.toUpperCase().replace('-', ' '))
  await page.getByRole('button', { name: 'Verify' }).click()
  await expect(page.getByRole('heading', { name: /^Hello/ })).toBeVisible()
  await page.goto('/account')
  await expect(section(page).getByText('9 backup codes left.')).toBeVisible()

  await signOut(page)
  await signIn(page, email)
  await page.getByRole('button', { name: 'Use a backup code' }).click()
  await page.getByLabel('Backup code').fill(first)
  await page.getByRole('button', { name: 'Verify' }).click()
  await expect(page.getByRole('alert')).toContainText('That code is incorrect.')
})

test('a sensitive action on an old sign-in opens the step-up dialog, and is retried once proven', async ({
  page,
  request,
}) => {
  const email = uniqueEmail('mfa.stepup')
  await signUp(page, request, { email })
  const { secret, codes } = await enrol(page, request)
  await advanceClock(request, 11 * 60_000)

  await page.reload()
  await section(page).getByRole('button', { name: 'New backup codes' }).click()
  const dialog = page.getByRole('dialog', { name: 'Confirm it is you' })
  // A user with two-step verification is asked for it, never for the password alone.
  await expect(dialog.getByLabel('Authentication code')).toBeFocused()
  await expect(dialog.getByLabel('Password')).toHaveCount(0)
  await dialog.getByLabel('Authentication code').fill('000000')
  await dialog.getByRole('button', { name: 'Continue' }).click()
  await expect(dialog.getByRole('alert')).toContainText('That code is incorrect.')

  // Escape closes it as a cancel: nothing changed, nothing is shown as an error.
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(section(page).getByRole('alert')).toHaveCount(0)
  await expect(section(page).getByText('10 backup codes left.')).toBeVisible()
  // Focus goes back to the button that opened the dialog.
  await expect(section(page).getByRole('button', { name: 'New backup codes' })).toBeFocused()

  await section(page).getByRole('button', { name: 'New backup codes' }).click()
  await dialog.getByLabel('Authentication code').fill(await authenticatorCode(request, secret))
  await dialog.getByRole('button', { name: 'Continue' }).click()
  await expect(dialog).toBeHidden()
  const fresh = await shownCodes(page)
  expect(fresh.filter((code) => codes.includes(code))).toEqual([])
  await page.getByLabel('I have saved these codes').check()
  await page.getByRole('button', { name: 'Done' }).click()
  await expect(section(page).getByText('Your earlier backup codes no longer work.')).toBeVisible()

  // Proven a moment ago: turning it off needs no second dialog.
  await section(page).getByRole('button', { name: 'Turn off' }).click()
  await expect(section(page).getByText('Two-step verification is off.')).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expectGone(page, [secret, ...codes, ...fresh])

  await signOut(page)
  await signIn(page, email)
  await expect(page.getByRole('heading', { name: /^Hello/ })).toBeVisible()
})

test('where the app requires it, a sign-in enrols first and shows the codes before it lets go', async ({
  page,
  request,
}) => {
  const email = uniqueEmail('mfa.required')
  await signUp(page, request, { email })
  await signOut(page)
  await useSettings(request, { mfa: { policy: 'required' } })

  await signIn(page, email)
  await expect(page.getByRole('heading', { name: 'Set up two-step verification' })).toBeVisible()
  await page.getByRole('button', { name: 'Set up authenticator app' }).click()
  const secret = await setupKey(page)
  await page.getByLabel('Authentication code').fill(await authenticatorCode(request, secret))
  await page.getByRole('button', { name: 'Turn on' }).click()

  // The app has signed the user in and moved on; the codes stay on top until they are saved.
  const dialog = page.getByRole('dialog', { name: 'Save your backup codes' })
  await expect(dialog).toBeVisible()
  const codes = await shownCodes(page)
  await expect(page.getByRole('heading', { name: /^Hello/ })).toBeAttached()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('I have saved these codes').check()
  await dialog.getByRole('button', { name: 'Done' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('heading', { name: /^Hello/ })).toBeVisible()
  await expectGone(page, [secret, ...codes])

  // Required: the server refuses to turn it off. (The page may still offer the button: a
  // browser keeps the environment's public configuration for a short while.)
  await page.goto('/account')
  await section(page).getByRole('button', { name: 'Turn off' }).click()
  await expect(section(page).getByRole('alert')).toContainText('cannot be turned off')
  await expect(section(page).getByText(/^On since/)).toBeVisible()

  await signOut(page)
  await signIn(page, email)
  await page.getByLabel('Authentication code').fill(await authenticatorCode(request, secret))
  await page.getByRole('button', { name: 'Verify' }).click()
  await expect(page.getByRole('heading', { name: /^Hello/ })).toBeVisible()
})
