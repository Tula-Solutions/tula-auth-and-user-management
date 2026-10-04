import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import {
  advanceClock,
  authenticatorCode,
  consentAtProvider,
  EMAIL_METHODS,
  latestCode,
  latestLink,
  PASSWORD,
  resetLimits,
  signOut,
  signUp,
  uniqueEmail,
  useProviders,
  useSettings,
} from './support'

// Regenerates the screenshots the READMEs show (examples/react-vite/docs). Not part of the
// suite: it only runs when asked for.
//
//   bun run e2e:screenshots

test.skip(!process.env.SCREENSHOTS, 'run with `bun run e2e:screenshots`')

const docs = join(import.meta.dirname, '..', '..', 'examples', 'react-vite', 'docs')
const DESKTOP = { width: 1000, height: 740 }
const PHONE = { width: 375, height: 760 }

async function shot(page: Page, name: string): Promise<void> {
  // Let transitions (the strength bar, focus rings) settle.
  await page.waitForTimeout(300)
  await page.screenshot({ path: join(docs, `${name}.png`), animations: 'disabled' })
}

test.beforeEach(async ({ request }) => {
  await resetLimits(request)
})

test.afterEach(async ({ request }) => {
  await useSettings(request)
  await useProviders(request)
})

test('sign-up with the checklist, the emailed code, and the profile', async ({ page, request }) => {
  await page.setViewportSize(DESKTOP)
  await page.goto('/sign-up')
  await page.getByLabel('First name').fill('Maya')
  await page.getByLabel('Last name').fill('Torres')
  await page.getByLabel('Email address').fill('maya@northline.app')
  await page.getByLabel('Password', { exact: true }).fill('maya-2026')
  await expect(page.getByText('Not met: 10 or more characters')).toBeAttached()
  await shot(page, 'sign-up-checklist')

  const email = uniqueEmail('maya')
  await page.getByLabel('Email address').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
  const code = await latestCode(request, email)
  await page.getByLabel('Verification code').fill(code === '000000' ? '000001' : '000000')
  await page.getByRole('button', { name: 'Verify' }).click()
  await expect(page.getByRole('alert')).toContainText('attempts left')
  await shot(page, 'verification')

  await page.getByLabel('Verification code').fill(code)
  await page.getByRole('button', { name: 'Verify' }).click()
  await page.getByRole('link', { name: 'Manage your account' }).click()
  await expect(page.locator('[data-tula-element="sessionItem"]')).toHaveCount(1)
  await page.setViewportSize({ width: 1000, height: 900 })
  await shot(page, 'user-profile')
})

test('sign-in, light and dark, and sign-up on a phone', async ({ page, request, browser }) => {
  const email = uniqueEmail('maya')
  await signUp(page, request, { email })
  await page.getByRole('button', { name: /^Account menu for/ }).click()
  await page.getByRole('menuitem', { name: 'Sign out' }).click()
  await page.setViewportSize(DESKTOP)
  await page.getByLabel('Email address').fill('maya@northline.app')
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('heading', { name: 'Enter your password' })).toBeVisible()
  await page.getByLabel('Password', { exact: true }).focus()
  await shot(page, 'sign-in')

  const dark = await browser.newContext({ colorScheme: 'dark', viewport: DESKTOP })
  const night = await dark.newPage()
  await night.goto('/sign-in')
  await expect(night.getByText(/^to continue to/)).toBeVisible()
  await shot(night, 'dark-sign-in')
  await dark.close()

  const phone = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2 })
  const mobile = await phone.newPage()
  await mobile.goto('/sign-up')
  await mobile.getByLabel('Email address').fill('maya@northline.app')
  await mobile.getByLabel('Password', { exact: true }).fill('northline-rocks')
  await expect(mobile.getByText('Met: 10 or more characters')).toBeAttached()
  await shot(mobile, 'mobile-sign-up')
  await phone.close()
})

test('email sign-in: the choice, the emailed code, waiting for a link, and the link page', async ({
  page,
  request,
  browser,
}) => {
  const email = 'maya@northline.app'
  await signUp(page, request, { email, firstName: 'Maya' })
  await signOut(page)
  await resetLimits(request)
  await useSettings(request, EMAIL_METHODS)

  await page.setViewportSize(DESKTOP)
  await page.getByLabel('Email address').fill(email)
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('list', { name: 'Other ways to sign in' })).toBeVisible()
  await shot(page, 'sign-in-methods')

  await page.getByRole('button', { name: 'Email me a code' }).click()
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
  await page.getByLabel('Verification code').fill('482')
  await shot(page, 'email-code')

  await resetLimits(request)
  await page.getByRole('button', { name: 'Email me a link' }).click()
  await expect(page.getByText('Waiting for you to open the link…')).toBeVisible()
  await page.getByRole('heading', { name: 'Check your email' }).focus()
  // This card is taller than the others: the link's status, then the code as the way in from
  // another device.
  await page.setViewportSize({ width: 1000, height: 820 })
  await shot(page, 'email-link-waiting')

  // The link, opened in a browser that did not ask for it.
  const link = await latestLink(request, email)
  const other = await browser.newContext({ viewport: DESKTOP })
  const stranger = await other.newPage()
  await stranger.goto(link)
  await expect(
    stranger.getByRole('heading', { name: 'Open this link where you started' })
  ).toBeVisible()
  await shot(stranger, 'email-link-other-browser')
  await other.close()

  const phone = await browser.newContext({
    viewport: PHONE,
    deviceScaleFactor: 2,
    colorScheme: 'dark',
  })
  const mobile = await phone.newPage()
  await mobile.goto('/sign-in')
  await mobile.getByLabel('Email address').fill(email)
  await mobile.getByRole('button', { name: 'Continue' }).click()
  await resetLimits(request)
  await mobile.getByRole('button', { name: 'Email me a link' }).click()
  await expect(mobile.getByText('Waiting for you to open the link…')).toBeVisible()
  await shot(mobile, 'mobile-email-link-dark')
  await phone.close()
})

test('sign-up where the password is optional', async ({ page, request }) => {
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
  await page.setViewportSize(DESKTOP)
  await page.goto('/sign-up')
  await expect(page.getByLabel('Password (optional)')).toBeVisible()
  await page.getByLabel('First name').fill('Ines')
  await page.getByLabel('Email address').fill('ines@northline.app')
  await shot(page, 'sign-up-optional-password')
})

test('two-step verification: enrolment, backup codes, the second factor and the step-up dialog', async ({
  page,
  request,
}) => {
  // The accounts live in the fixture's memory and are gone when it stops: the setup key and
  // the backup codes in these pictures never worked anywhere else and work nowhere now.
  await page.setViewportSize({ width: 1000, height: 900 })
  const email = uniqueEmail('maya.mfa')
  await signUp(page, request, { email, firstName: 'Maya' })
  await page.goto('/account')
  const section = page.locator('section', {
    has: page.getByRole('heading', { name: 'Two-step verification' }),
  })
  await section.last().getByRole('button', { name: 'Turn on' }).click()
  const key = page.getByRole('group', { name: 'Setup key' })
  await expect(key).toBeVisible()
  await expect(page.getByRole('img', { name: /QR code/ })).toBeVisible()
  await page.getByRole('img', { name: /QR code/ }).scrollIntoViewIfNeeded()
  await page.mouse.wheel(0, 200)
  await shot(page, 'two-step-enrol')

  const secret = (await key.locator('code').innerText()).replace(/\s/g, '')
  await page.getByLabel('Authentication code').fill(await authenticatorCode(request, secret))
  await section.last().getByRole('button', { name: 'Turn on' }).click()
  await expect(page.getByRole('list', { name: 'Backup codes' })).toBeVisible()
  await shot(page, 'backup-codes')
  await page.getByLabel('I have saved these codes').check()
  await page.getByRole('button', { name: 'Done' }).click()
  await expect(section.last().getByText(/^On since/)).toBeVisible()

  // An old sign-in: the next sensitive action asks for the second factor again.
  await advanceClock(request, 11 * 60_000)
  await page.reload()
  await section.last().getByRole('button', { name: 'New backup codes' }).click()
  await expect(page.getByRole('dialog', { name: 'Confirm it is you' })).toBeVisible()
  await shot(page, 'step-up')
  await page.keyboard.press('Escape')

  await signOut(page)
  await page.setViewportSize(DESKTOP)
  await page.getByLabel('Email address').fill(email)
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Two-step verification' })).toBeVisible()
  await shot(page, 'second-factor')

  await page.setViewportSize(PHONE)
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.getByRole('button', { name: 'Use a backup code' }).click()
  await shot(page, 'mobile-second-factor-dark')
})

test('OAuth: the provider buttons, the mock provider, a passwordless profile, the emailed step-up, the second factor, and a callback that can be retried or was replayed', async ({
  page,
  request,
  browser,
}) => {
  // Served by the API's mock provider: the accounts exist only in the fixture's memory.
  await useProviders(request, ['google', 'github', 'apple'])
  await page.setViewportSize(DESKTOP)
  await page.goto('/sign-in')
  await expect(page.getByRole('button', { name: 'Continue with Apple' })).toBeVisible()
  await shot(page, 'oauth-sign-in')

  const phone = await browser.newPage({ viewport: PHONE, colorScheme: 'dark' })
  await phone.goto('/sign-in')
  await expect(phone.getByRole('button', { name: 'Continue with Apple' })).toBeVisible()
  await shot(phone, 'oauth-mobile-sign-in-dark')
  await phone.close()

  // Sign up with a provider. The first exchange is dropped, to show the retry.
  const email = uniqueEmail('maya.oauth')
  let callback = ''
  let landing = ''
  page.on('response', (response) => {
    if (new URL(response.url()).pathname === '/v1/oauth/callback/google') {
      callback = response.url()
      landing = response.headers().location ?? ''
    }
  })
  let dropped = false
  await page.route('**/v1/client/sign-ins/oauth/exchange', async (route) => {
    if (dropped) {
      await route.continue()
    } else {
      dropped = true
      await route.abort('connectionfailed')
    }
  })
  await page.getByRole('button', { name: 'Continue with Google' }).click()
  await expect(page.getByRole('heading', { name: 'Mock Google sign-in' })).toBeVisible()
  await page.getByLabel('Email address the provider reports').fill(email)
  await shot(page, 'oauth-mock-provider')
  await consentAtProvider(page, { email })
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible()
  await shot(page, 'oauth-callback-try-again')
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByRole('heading', { name: /^Hello/ })).toBeVisible()

  // The same callback and ticket replayed in another browser sign nobody in.
  const replay = await (await browser.newContext({ viewport: DESKTOP })).newPage()
  await replay.goto(callback)
  await expect(
    replay.getByRole('heading', { name: 'Sign-in could not be completed' })
  ).toBeVisible()
  await shot(replay, 'oauth-callback-replayed')
  await replay.goto(landing)
  await expect(replay.getByRole('heading', { name: 'Start again in this browser' })).toBeVisible()
  await shot(replay, 'oauth-ticket-other-browser')
  await replay.context().close()

  // No password: the profile says how to add one, and lists the connected account.
  await page.setViewportSize({ width: 1000, height: 1100 })
  await page.goto('/account')
  await expect(page.getByText('This account has no password')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Connected accounts' })).toBeVisible()
  await shot(page, 'oauth-profile-passwordless')

  // Eleven minutes on, a sensitive change asks for a code by email: this user has no password.
  await page.setViewportSize(DESKTOP)
  await advanceClock(request, 11 * 60_000)
  const section = page.locator('section', {
    has: page.getByRole('heading', { name: 'Two-step verification' }),
  })
  await section.last().getByRole('button', { name: 'Turn on' }).click()
  const dialog = page.getByRole('dialog', { name: 'Confirm it is you' })
  await expect(dialog.getByLabel('Verification code')).toBeFocused()
  await shot(page, 'oauth-step-up-email-code')
  const phoneDark = { viewport: PHONE, colorScheme: 'dark' } as const
  await page.setViewportSize(phoneDark.viewport)
  await page.emulateMedia({ colorScheme: phoneDark.colorScheme })
  await shot(page, 'oauth-mobile-step-up-email-code-dark')
  await page.emulateMedia({ colorScheme: 'light' })
  await page.setViewportSize({ width: 1000, height: 900 })

  // The code steps up, the authenticator is enrolled, and the next provider sign-in stops at
  // the second factor.
  await dialog.getByLabel('Verification code').fill(await latestCode(request, email))
  await dialog.getByRole('button', { name: 'Continue' }).click()
  const key = page.getByRole('group', { name: 'Setup key' })
  await expect(key).toBeVisible()
  const secret = (await key.locator('code').innerText()).replace(/\s/g, '')
  await page.getByLabel('Authentication code').fill(await authenticatorCode(request, secret))
  await section.last().getByRole('button', { name: 'Turn on' }).click()
  await page.getByLabel('I have saved these codes').check()
  await page.getByRole('button', { name: 'Done' }).click()
  await expect(section.last().getByText(/^On since/)).toBeVisible()
  await signOut(page)
  await advanceClock(request, 31_000)
  await page.setViewportSize(DESKTOP)
  await page.goto('/sign-in')
  await page.getByRole('button', { name: 'Continue with Google' }).click()
  await consentAtProvider(page, { email })
  await expect(page.getByRole('heading', { name: 'Two-step verification' })).toBeVisible()
  await shot(page, 'oauth-second-factor')
})
