import {
  type APIRequestContext,
  type BrowserContext,
  expect,
  type Page,
  test,
} from '@playwright/test'
import {
  addVirtualAuthenticator,
  advanceClock,
  authenticatorCode,
  EMAIL_METHODS,
  emailCount,
  expectAccessible,
  latestCode,
  NEW_PASSWORD,
  PASSKEY_METHODS,
  PASSWORD,
  resetLimits,
  signIn,
  signUp,
  uniqueEmail,
  useSettings,
} from '../support'

// Every Phase 1 sign-in method and account feature, through the Next.js example and its
// proxy: the browser talks to this app's route handler only, the session is this app's
// cookies, and after each sign-in the server component says who it sees. The password
// sign-up, OAuth and the emailed link are in app.spec.ts and callbacks.spec.ts; this file is
// the rest. Which screens appear is decided by the environment's settings alone: the example
// has no code for any one method.
//
// Scenarios that move the fixture's clock are last in the file: the Next.js server judges a
// token's expiry by the real time (see the refresh scenario in app.spec.ts, which runs first).

const NEXT_URL = 'http://localhost:4319'

test.beforeEach(async ({ request }) => {
  await resetLimits(request)
})

test.afterEach(async ({ request }) => {
  // Every scenario shares the one in-memory environment: put its settings back.
  await useSettings(request)
})

const account = (page: Page) => page.getByRole('region', { name: 'Account' })
const passkeys = (page: Page) =>
  account(page).locator('section', { has: page.getByRole('heading', { name: 'Passkeys' }) })
const twoStep = (page: Page) =>
  account(page).locator('section', {
    has: page.getByRole('heading', { name: 'Two-step verification' }),
  })

/** A message of the app's own; Next.js keeps a second, empty alert for its route announcer. */
const alert = (page: Page) => page.getByRole('main').getByRole('alert')

/** The app's Tula cookies, by name. */
async function tulaCookies(context: BrowserContext) {
  const cookies = await context.cookies(NEXT_URL)
  return new Map(
    cookies
      .filter((cookie) => cookie.name.startsWith('tula_'))
      .map((cookie) => [cookie.name, cookie])
  )
}

/** Sign out through the user button; the example then shows its public home page. */
async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Account menu for/ }).click()
  await page.getByRole('menuitem', { name: 'Sign out' }).click()
  await expect(page.getByRole('link', { name: 'Create an account' })).toBeVisible()
}

/** axe on the page as it is, in the light and in the dark scheme (left in light). */
async function expectAccessibleInBothSchemes(page: Page, state: string): Promise<void> {
  for (const colorScheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme })
    await expectAccessible(page, `next ${state} (${colorScheme})`)
  }
}

/** The server component's view: the dashboard rendered for this address. */
async function expectServerSees(page: Page, email: string): Promise<void> {
  await expect(page).toHaveURL(`${NEXT_URL}/dashboard`)
  await expect(page.getByTestId('server-email')).toHaveText(email)
}

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
  await page.goto('/profile')
  await twoStep(page).getByRole('button', { name: 'Turn on' }).click()
  const secret = await setupKey(page)
  await page.getByLabel('Authentication code').fill(await authenticatorCode(request, secret))
  await twoStep(page).getByRole('button', { name: 'Turn on' }).click()
  const codes = await shownCodes(page)
  await page.getByLabel('I have saved these codes').check()
  await page.getByRole('button', { name: 'Done' }).click()
  await expect(twoStep(page).getByText(/^On since/)).toBeVisible()
  return { secret, codes }
}

test('emailed code: chosen beside the password, it signs in on the hybrid profile’s two cookies', async ({
  page,
  request,
  context,
}) => {
  const email = uniqueEmail('next-code')
  await signUp(page, request, { email, firstName: 'Maya' })
  await signOut(page)
  await useSettings(request, EMAIL_METHODS)
  await resetLimits(request)
  const before = await emailCount(request, email)

  await page.goto('/sign-in')
  await page.getByLabel('Email address').fill(email)
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  const others = page.getByRole('list', { name: 'Other ways to sign in' })
  await expect(others.getByRole('button')).toHaveText(['Email me a code', 'Email me a link'])
  await expectAccessibleInBothSchemes(page, 'sign-in, password with the email methods')
  await others.getByRole('button', { name: 'Email me a code' }).click()
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeFocused()
  await expectAccessibleInBothSchemes(page, 'sign-in, emailed code')

  const code = await latestCode(request, email, before)
  await page.getByLabel('Verification code').fill(code === '000000' ? '000001' : '000000')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(alert(page)).toContainText('That code is incorrect. 4 attempts left.')
  await page.getByLabel('Verification code').fill(code)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Hello, Maya' })).toBeVisible()
  await expectServerSees(page, email)

  // The default (hybrid) profile through the proxy: a short access token and a rotating
  // refresh token, both this origin's httpOnly cookies and nothing a script can read.
  const cookies = await tulaCookies(context)
  expect([...cookies.keys()].sort()).toEqual(['tula_at', 'tula_rt'])
  expect([...cookies.values()].every((cookie) => cookie.httpOnly)).toBe(true)
  expect(await page.evaluate(() => document.cookie)).not.toContain('tula_')
})

test('sign-up without a password, then an emailed code is the way in', async ({
  page,
  request,
}) => {
  await useSettings(request, {
    signIn: {
      methods: {
        password: { enabled: true },
        emailCode: { enabled: true },
        emailLink: { enabled: false },
      },
    },
    signUp: { password: 'optional' },
  })
  const email = uniqueEmail('next-nopw')
  await page.goto('/sign-up')
  await expect(page.getByLabel('Password (optional)')).toBeVisible()
  await expectAccessibleInBothSchemes(page, 'sign-up, optional password')
  await page.getByLabel('First name').fill('Ines')
  await page.getByLabel('Email address').fill(email)
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
  await page.getByLabel('Verification code').fill(await latestCode(request, email))
  await page.getByRole('button', { name: 'Verify' }).click()
  await expect(page.getByRole('heading', { name: 'Hello, Ines' })).toBeVisible()
  await expectServerSees(page, email)

  await signOut(page)
  await resetLimits(request)
  const before = await emailCount(request, email)
  await page.goto('/sign-in')
  await page.getByLabel('Email address').fill(email)
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.getByRole('button', { name: 'Email me a code' }).click()
  await page.getByLabel('Verification code').fill(await latestCode(request, email, before))
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expectServerSees(page, email)
})

test('forgot password: reset with the emailed code, signed in, and the old password is refused', async ({
  page,
  request,
}) => {
  const email = uniqueEmail('next-reset')
  await signUp(page, request, { email })
  await signOut(page)
  await resetLimits(request)
  const before = await emailCount(request, email)

  await page.goto('/sign-in')
  await page.getByLabel('Email address').fill(email)
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.getByRole('button', { name: 'Forgot password?' }).click()
  await expect(page.getByRole('heading', { name: 'Reset your password' })).toBeFocused()
  await expectAccessibleInBothSchemes(page, 'password reset, the address')
  await page.getByRole('button', { name: 'Send code' }).click()
  await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeFocused()
  await expectAccessibleInBothSchemes(page, 'password reset, the code and the new password')
  await page.getByLabel('Verification code').fill(await latestCode(request, email, before))
  await page.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD)
  await page.getByRole('button', { name: 'Reset password' }).click()
  await expectServerSees(page, email)

  await signOut(page)
  await signIn(page, email, PASSWORD)
  await expect(alert(page)).toHaveText('The email or password is incorrect.')
  await signIn(page, email, NEW_PASSWORD)
  await expectServerSees(page, email)
})

test('devices: the profile lists both browsers and signs the other one out', async ({
  page,
  request,
  browser,
}) => {
  const email = uniqueEmail('next-devices')
  await signUp(page, request, { email })
  const other = await browser.newContext()
  const second = await other.newPage()
  await signIn(second, email)
  await expect(second.getByRole('heading', { name: /^Hello/ })).toBeVisible()

  await page.goto('/profile')
  const devices = page.locator('[data-tula-element="sessionItem"]')
  await expect(devices).toHaveCount(2)
  await expectAccessibleInBothSchemes(page, 'profile, two devices')
  await page.getByRole('button', { name: /^Sign out Chrome on/ }).click()
  await expect(page.getByText('That device was signed out.')).toBeVisible()
  await expect(devices).toHaveCount(1)

  // The other browser's access token is verified offline until it expires (a minute); once
  // it is gone the proxy's refresh is refused and that browser is signed out.
  await other.clearCookies({ name: 'tula_at' })
  await second.goto('/dashboard')
  await expect(second).toHaveURL(`${NEXT_URL}/sign-in?redirect_url=%2Fdashboard`)
  expect((await tulaCookies(other)).size).toBe(0)
  await other.close()
})

test('the session limit: a refused sign-in says why, and signing out elsewhere frees a place', async ({
  page,
  request,
  browser,
}) => {
  await useSettings(request, { sessions: { maxPerUser: 1, onLimit: 'refuse_newest' } })
  const email = uniqueEmail('next-limit')
  await signUp(page, request, { email })

  const other = await browser.newContext()
  const second = await other.newPage()
  await signIn(second, email)
  await expect(alert(second)).toContainText('You are signed in on too many devices')
  expect((await tulaCookies(other)).size).toBe(0)
  await expectAccessibleInBothSchemes(second, 'sign-in refused at the session limit')
  await second.goto('/dashboard')
  await expect(second).toHaveURL(`${NEXT_URL}/sign-in?redirect_url=%2Fdashboard`)

  await signOut(page)
  await signIn(second, email)
  await expectServerSees(second, email)
  await other.close()
})

test('where the app requires two steps, a sign-in enrols first and shows the codes before it lets go', async ({
  page,
  request,
}) => {
  const email = uniqueEmail('next-required')
  await signUp(page, request, { email })
  await signOut(page)
  await useSettings(request, { mfa: { policy: 'required' } })

  await signIn(page, email)
  await expect(page.getByRole('heading', { name: 'Set up two-step verification' })).toBeFocused()
  // Not signed in yet: the server has no session to show.
  expect((await page.request.get('/api/whoami')).status()).toBe(401)
  await expectAccessibleInBothSchemes(page, 'required enrolment, before it starts')
  await page.getByRole('button', { name: 'Set up authenticator app' }).click()
  const secret = await setupKey(page)
  await expectAccessibleInBothSchemes(page, 'required enrolment, QR code and setup key')
  await page.getByLabel('Authentication code').fill(await authenticatorCode(request, secret))
  await page.getByRole('button', { name: 'Turn on' }).click()

  // The app has moved on to the dashboard; the provider keeps the codes on top until saved.
  const dialog = page.getByRole('dialog', { name: 'Save your backup codes' })
  await expect(dialog).toBeVisible()
  await shownCodes(page)
  await expectAccessibleInBothSchemes(page, 'backup codes dialog over the dashboard')
  await dialog.getByLabel('I have saved these codes').check()
  await dialog.getByRole('button', { name: 'Done' }).click()
  await expect(dialog).toBeHidden()
  await expectServerSees(page, email)

  await signOut(page)
  await signIn(page, email)
  await page.getByLabel('Authentication code').fill(await authenticatorCode(request, secret))
  await page.getByRole('button', { name: 'Verify' }).click()
  await expectServerSees(page, email)
})

test('a password, then the passkey as the second factor where the app requires two steps', async ({
  page,
  request,
}) => {
  await useSettings(request, PASSKEY_METHODS)
  const authenticator = await addVirtualAuthenticator(page)
  const email = uniqueEmail('next-passkey-second')
  await signUp(page, request, { email, firstName: 'Ines' })
  await page.goto('/profile')
  await passkeys(page).getByRole('button', { name: 'Add a passkey' }).click()
  await expect(passkeys(page).getByText('Your passkey was added.')).toBeVisible()
  await authenticator.setAnswering(false)
  await signOut(page)

  await useSettings(request, { ...PASSKEY_METHODS, mfa: { policy: 'required' } })
  await signIn(page, email)
  await expect(page.getByRole('heading', { name: 'Two-step verification' })).toBeVisible()
  await expect(page.getByText('Use your passkey to finish signing in.')).toBeVisible()
  await expectAccessibleInBothSchemes(page, 'second factor, passkey')
  await authenticator.setAnswering(true)
  await page.getByRole('button', { name: 'Use your passkey' }).click()
  await expect(page.getByRole('heading', { name: 'Hello, Ines' })).toBeVisible()
  await expectServerSees(page, email)
})

// From here on the scenarios move the fixture's clock forward.

test('authenticator app: enrol in the profile, sign in with it, step up with it, sign in with a backup code', async ({
  page,
  request,
}) => {
  const email = uniqueEmail('next-totp')
  await signUp(page, request, { email, firstName: 'Maya' })
  await page.goto('/profile')
  await twoStep(page).getByRole('button', { name: 'Turn on' }).click()
  const secret = await setupKey(page)
  await expect(page.getByRole('img', { name: /QR code for your authenticator app/ })).toBeVisible()
  await expectAccessibleInBothSchemes(page, 'profile, authenticator enrolment')
  await page.getByLabel('Authentication code').fill(await authenticatorCode(request, secret))
  await twoStep(page).getByRole('button', { name: 'Turn on' }).click()
  await shownCodes(page)
  await expectAccessibleInBothSchemes(page, 'profile, backup codes')
  await page.getByLabel('I have saved these codes').check()
  await page.getByRole('button', { name: 'Done' }).click()
  await expect(twoStep(page).getByText('10 backup codes left.')).toBeVisible()

  await signOut(page)
  await signIn(page, email)
  await expect(page.getByRole('heading', { name: 'Two-step verification' })).toBeFocused()
  // The password alone is not a session: the server sees nobody.
  expect((await page.request.get('/api/whoami')).status()).toBe(401)
  await expectAccessibleInBothSchemes(page, 'second factor, authenticator code')
  await page.getByLabel('Authentication code').fill(await authenticatorCode(request, secret))
  await page.getByRole('button', { name: 'Verify' }).click()
  await expect(page.getByRole('heading', { name: 'Hello, Maya' })).toBeVisible()
  await expectServerSees(page, email)

  // Ten minutes on, the sign-in is no longer recent: new backup codes need the authenticator.
  await advanceClock(request, 11 * 60_000)
  await page.goto('/profile')
  await twoStep(page).getByRole('button', { name: 'New backup codes' }).click()
  const dialog = page.getByRole('dialog', { name: 'Confirm it is you' })
  await expect(dialog.getByLabel('Authentication code')).toBeFocused()
  await expect(dialog.getByLabel('Password')).toHaveCount(0)
  await expectAccessibleInBothSchemes(page, 'step-up dialog, authenticator code')
  await dialog.getByLabel('Authentication code').fill(await authenticatorCode(request, secret))
  await dialog.getByRole('button', { name: 'Continue' }).click()
  await expect(dialog).toBeHidden()
  const [backupCode] = (await shownCodes(page)) as [string]
  await page.getByLabel('I have saved these codes').check()
  await page.getByRole('button', { name: 'Done' }).click()

  await signOut(page)
  await signIn(page, email)
  await page.getByRole('button', { name: 'Use a backup code' }).click()
  await page.getByLabel('Backup code').fill(backupCode)
  await page.getByRole('button', { name: 'Verify' }).click()
  await expectServerSees(page, email)
  await page.goto('/profile')
  await expect(twoStep(page).getByText('9 backup codes left.')).toBeVisible()
})

test('step-up with an emailed code: a user with a password may ask for a code instead', async ({
  page,
  request,
}) => {
  const email = uniqueEmail('next-step-up-code')
  await signUp(page, request, { email })
  await advanceClock(request, 11 * 60_000)
  await page.goto('/profile')
  const before = await emailCount(request, email)
  await twoStep(page).getByRole('button', { name: 'Turn on' }).click()
  const dialog = page.getByRole('dialog', { name: 'Confirm it is you' })
  await expect(dialog.getByLabel('Password', { exact: true })).toBeFocused()
  await expectAccessibleInBothSchemes(page, 'step-up dialog, password or emailed code')
  // Nothing is emailed until it is asked for.
  expect(await emailCount(request, email)).toBe(before)
  await dialog.getByRole('button', { name: 'Email me a code instead' }).click()
  await expect(dialog.getByLabel('Verification code')).toBeFocused()
  await expectAccessibleInBothSchemes(page, 'step-up dialog, emailed code')
  await dialog.getByLabel('Verification code').fill(await latestCode(request, email, before))
  await dialog.getByRole('button', { name: 'Continue' }).click()
  await expect(dialog).toHaveCount(0)
  // The action that needed it is retried: the enrolment has started.
  await expect(page.getByRole('group', { name: 'Setup key' })).toBeVisible()
})

test('a passkey from the profile: sign in with it, step up with it, rename it, remove it', async ({
  page,
  request,
}) => {
  await useSettings(request, { ...PASSKEY_METHODS, mfa: { policy: 'optional' } })
  const authenticator = await addVirtualAuthenticator(page)
  const email = uniqueEmail('next-passkey')
  await signUp(page, request, { email, firstName: 'Maya' })

  await page.goto('/profile')
  await expect(passkeys(page).getByText('You have no passkeys yet.')).toBeVisible()
  await passkeys(page).getByRole('button', { name: 'Add a passkey' }).click()
  await expect(passkeys(page).getByText('Your passkey was added.')).toBeVisible()
  await expect(passkeys(page).getByRole('listitem')).toHaveCount(1)
  expect(await authenticator.credentialCount()).toBe(1)
  await expectAccessibleInBothSchemes(page, 'profile, one passkey')
  await enrol(page, request)

  // The sign-in page asks the browser for a passkey twice: for the address field's autofill,
  // and when the button is pressed. The authenticator stays silent until the first is pending.
  await authenticator.setAnswering(false)
  await signOut(page)
  await page.goto('/sign-in')
  const button = page.getByRole('button', { name: 'Sign in with a passkey' })
  await expect(button).toBeVisible()
  await expect(page.getByLabel('Email address')).toHaveAttribute(
    'autocomplete',
    'username webauthn'
  )
  await expectAccessibleInBothSchemes(page, 'sign-in with the passkey button')
  await authenticator.autofillWaiting()
  await authenticator.setAnswering(true)
  await button.click()
  // A passkey verifies the user itself: no second step, although an authenticator is enrolled.
  await expect(page.getByRole('heading', { name: 'Hello, Maya' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Two-step verification' })).toHaveCount(0)
  await expectServerSees(page, email)

  await advanceClock(request, 11 * 60_000)
  await page.goto('/profile')
  await passkeys(page).getByRole('button', { name: 'Rename Passkey' }).click()
  await passkeys(page).getByLabel('Passkey name').fill('Work laptop')
  await passkeys(page).getByRole('button', { name: 'Save' }).click()
  const dialog = page.getByRole('dialog', { name: 'Confirm it is you' })
  await dialog.getByRole('button', { name: 'Use your passkey instead' }).click()
  await expectAccessibleInBothSchemes(page, 'step-up dialog, passkey')
  await dialog.getByRole('button', { name: 'Use your passkey' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(passkeys(page).getByText('The passkey was renamed.')).toBeVisible()
  await expect(passkeys(page).getByRole('listitem')).toContainText('Work laptop')

  await passkeys(page).getByRole('button', { name: 'Remove Work laptop' }).click()
  await passkeys(page)
    .getByRole('group', { name: /^Remove “Work laptop”\?/ })
    .getByRole('button', { name: 'Remove passkey' })
    .click()
  await expect(passkeys(page).getByText('The passkey was removed.')).toBeVisible()
  await expect(passkeys(page).getByText('You have no passkeys yet.')).toBeVisible()
})
