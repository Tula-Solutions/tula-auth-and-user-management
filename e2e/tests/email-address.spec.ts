import { type APIRequestContext, expect, type Page, test } from '@playwright/test'
import {
  API_URL,
  advanceClock,
  consentAtProvider,
  emailCount,
  expectAccessible,
  latestCode,
  resetLimits,
  signOut,
  signUp,
  uniqueEmail,
  useProviders,
} from './support'

// An email address for an account that has none (ADR 0059), in a real browser against the
// real API: an account made by signing in with X (the mock provider, asked for no address)
// adds one from its profile with a code emailed to it. The address another account holds is
// answered like a free one and is sent no code.

test.beforeEach(async ({ request }) => {
  await resetLimits(request)
  await useProviders(request, ['x'])
})

test.afterEach(async ({ request }) => {
  await useProviders(request)
})

/** An X account id nobody has used: digits, in one spelling. */
const xAccount = () => String(BigInt(Date.now()) * 4096n + BigInt(Math.floor(Math.random() * 4096)))

const CHECK_INBOX =
  /^Check .\*\*\*@northline\.test\. If that address can be added to this account, the email we sent holds a 6-digit code\.$/

/** Sign in with X as `account` and open the account page. */
async function signInWithX(page: Page, account: string): Promise<void> {
  await page.goto('/sign-in')
  await page.getByRole('button', { name: 'Continue with X', exact: true }).click()
  await consentAtProvider(page, { subject: account })
  await expect(page.getByRole('heading', { name: 'Hello, there' })).toBeVisible()
  await page.goto('/account')
}

const profile = (page: Page) => page.getByRole('region', { name: 'Account' })

/** The profile's "Email address" section, which only an account with no address has. */
const section = (page: Page) =>
  profile(page).locator('section', {
    has: page.getByRole('heading', { name: 'Email address', exact: true }),
  })

/** axe on the page as it is, in both colour schemes. */
async function accessible(page: Page, state: string): Promise<void> {
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await expectAccessible(page, `${state} (${colorScheme})`)
  }
  await page.emulateMedia({ colorScheme: 'light' })
}

/** The subjects of what an address was emailed, oldest first. */
async function subjects(request: APIRequestContext, email: string): Promise<string[]> {
  const response = await request.get(`${API_URL}/__test/outbox?to=${encodeURIComponent(email)}`)
  const { data } = (await response.json()) as { data: { subject: string }[] }
  return data.map(({ subject }) => subject)
}

/** Open the form, type the address and ask; resolves on the code screen. */
async function askFor(page: Page, email: string): Promise<void> {
  await section(page).getByRole('button', { name: 'Add an email address' }).click()
  const address = section(page).getByLabel('Email address')
  await expect(address).toBeFocused()
  await address.fill(email)
  await section(page).getByRole('button', { name: 'Send code' }).click()
  await expect(section(page).getByLabel('Verification code')).toBeFocused()
}

test('an account made with X adds an email address with an emailed code', async ({
  page,
  request,
}) => {
  const email = uniqueEmail('added')
  await signInWithX(page, xAccount())

  // No address: the section says so and offers to add one.
  await expect(section(page).getByText('This account has no email address.')).toBeVisible()
  await expect(profile(page).getByRole('heading', { name: 'Password' })).toHaveCount(0)
  await accessible(page, 'profile with no email address: the section')

  await section(page).getByRole('button', { name: 'Add an email address' }).click()
  const address = section(page).getByLabel('Email address')
  await expect(address).toBeFocused()
  await accessible(page, 'email address: the address form')

  // Nothing typed is said at the field, and nothing is sent.
  await section(page).getByRole('button', { name: 'Send code' }).click()
  await expect(section(page).getByRole('alert')).toBeVisible()
  await accessible(page, 'email address: nothing typed')
  expect(await emailCount(request, email)).toBe(0)

  await address.fill(email)
  await section(page).getByRole('button', { name: 'Send code' }).click()
  const code = section(page).getByLabel('Verification code')
  await expect(code).toBeFocused()
  // Where to look, never "we sent a code", and only the server's mask of the address.
  await expect(section(page).getByText(CHECK_INBOX)).toBeVisible()
  await expect(section(page).getByText(email)).toHaveCount(0)
  await accessible(page, 'email address: the code form')

  const emailed = await latestCode(request, email)
  await code.fill(emailed === '000000' ? '111111' : '000000')
  await section(page).getByRole('button', { name: 'Verify' }).click()
  await expect(section(page).getByRole('alert')).toBeVisible()
  await expect(code).toHaveValue('')
  await accessible(page, 'email address: a wrong code')
  await expect(profile(page).getByText(email)).toHaveCount(0)

  await code.fill(emailed)
  await section(page).getByRole('button', { name: 'Verify' }).click()
  await expect(section(page).getByText('Your email address was added.')).toBeVisible()
  // The address is the account's, shown by the profile, and there is nothing left to add.
  await expect(profile(page).getByText(email)).toBeVisible()
  await expect(section(page).getByRole('button', { name: 'Add an email address' })).toHaveCount(0)
  await expect(section(page).getByLabel('Verification code')).toHaveCount(0)
  await expect(section(page).getByRole('heading', { name: 'Email address' })).toBeFocused()
  await accessible(page, 'email address: added')

  // The new address is told, with no code: one message with a code, one notice.
  await expect
    .poll(() => subjects(request, email), { message: 'the notice to the added address' })
    .toHaveLength(2)
  const [first, notice] = await subjects(request, email)
  expect(first).toMatch(/^\d{6}\b/)
  expect(notice).not.toMatch(/\d{6}/)

  // Loaded afresh, the account has its address and the section is gone.
  await page.reload()
  await expect(profile(page).getByText(email)).toBeVisible()
  await expect(
    profile(page).getByRole('heading', { name: 'Email address', exact: true })
  ).toHaveCount(0)
  // Nothing of the address or the code was kept by the page.
  expect(
    await page.evaluate(() => [...Object.keys(sessionStorage), ...Object.keys(localStorage)])
  ).toEqual([])
  await accessible(page, 'profile after an email address was added')
})

test('an address another account holds gets the same answer and no code, and is never added', async ({
  page,
  request,
}) => {
  const taken = uniqueEmail('taken')
  await signUp(page, request, { email: taken })
  await signOut(page)
  const before = await subjects(request, taken)

  await signInWithX(page, xAccount())
  await askFor(page, taken)
  // The same screen as for a free address: nothing on it says the address has an account.
  await expect(section(page).getByText(CHECK_INBOX)).toBeVisible()
  await expect(section(page).getByRole('alert')).toHaveCount(0)
  await accessible(page, 'email address: the code form, for a taken address')

  // Its inbox is told, in one message that holds no code.
  await expect
    .poll(() => subjects(request, taken), { message: 'the notice to the taken address' })
    .toHaveLength(before.length + 1)
  const notice = (await subjects(request, taken)).at(-1) ?? ''
  expect(notice).not.toMatch(/\d{6}/)

  // No code confirms it: a guess is refused like any wrong code, and nothing is added.
  const code = section(page).getByLabel('Verification code')
  await code.fill('482913')
  await section(page).getByRole('button', { name: 'Verify' }).click()
  await expect(section(page).getByRole('alert')).toBeVisible()
  await expect(section(page).getByText('Your email address was added.')).toHaveCount(0)
  await accessible(page, 'email address: a guess at a taken address')

  await page.reload()
  await expect(section(page).getByText('This account has no email address.')).toBeVisible()
  await expect(profile(page).getByText(taken)).toHaveCount(0)
})

test('ten minutes after signing in, an account with nothing to step up with is told to sign in again, and then adds the address', async ({
  page,
  request,
}) => {
  const email = uniqueEmail('later')
  const account = xAccount()
  await signInWithX(page, account)
  await expect(section(page).getByText('This account has no email address.')).toBeVisible()

  // No password, no passkey, no authenticator and no address to send a code to.
  await advanceClock(request, 11 * 60_000)
  await section(page).getByRole('button', { name: 'Add an email address' }).click()
  await section(page).getByLabel('Email address').fill(email)
  await section(page).getByRole('button', { name: 'Send code' }).click()
  const dialog = page.getByRole('dialog', { name: 'Confirm it is you' })
  await expect(
    dialog.getByText('For your security, sign out and sign in again to continue.')
  ).toBeVisible()
  await accessible(page, 'email address: step-up with nothing to step up with')
  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect(dialog).toHaveCount(0)
  // Declining is not an error, nothing was sent, and the form is still there.
  await expect(section(page).getByRole('alert')).toHaveCount(0)
  await expect(section(page).getByLabel('Verification code')).toHaveCount(0)
  await expect(section(page).getByLabel('Email address')).toHaveValue(email)
  expect(await emailCount(request, email)).toBe(0)

  // Signing in again is the step-up this account has.
  await signOut(page)
  await signInWithX(page, account)
  await askFor(page, email)
  await section(page)
    .getByLabel('Verification code')
    .fill(await latestCode(request, email))
  await section(page).getByRole('button', { name: 'Verify' }).click()
  await expect(section(page).getByText('Your email address was added.')).toBeVisible()
  await expect(profile(page).getByText(email)).toBeVisible()
})
