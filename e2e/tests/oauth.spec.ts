import { type APIRequestContext, expect, type Page, test } from '@playwright/test'
import {
  API_URL,
  advanceClock,
  authenticatorCode,
  consentAtProvider,
  expectAccessible,
  resetLimits,
  signOut,
  signUp,
  uniqueEmail,
  useProviders,
} from './support'

// Signing in with an OAuth provider in a real browser, against the real API: the redirect to
// the provider (the API's mock provider, whose consent page the test fills in), the callback on
// the API, the ticket in the URL fragment, and the exchange on the app's page.

test.beforeEach(async ({ request }) => {
  await resetLimits(request)
  await useProviders(request, ['google', 'github'])
})

test.afterEach(async ({ request }) => {
  await useProviders(request)
})

const connected = (page: Page) =>
  page.getByRole('region', { name: 'Account' }).locator('section', {
    has: page.getByRole('heading', { name: 'Connected accounts' }),
  })

/** "Continue with Google" from the sign-in page, through the provider, back to the app. */
async function continueWithGoogle(
  page: Page,
  consent: Parameters<typeof consentAtProvider>[1],
  from = '/sign-in'
): Promise<void> {
  await page.goto(from)
  await page.getByRole('button', { name: 'Continue with Google' }).click()
  await consentAtProvider(page, consent)
}

/** What the tab and the origin keep in web storage. */
function storage(page: Page) {
  return page.evaluate(() => ({
    session: Object.keys(sessionStorage),
    local: Object.keys(localStorage),
  }))
}

test('sign up with a provider, land signed in with a clean address and clean storage, and sign in again', async ({
  page,
}) => {
  const email = uniqueEmail('oauth-new')
  const urls: string[] = []
  page.on('request', (sent) => urls.push(sent.url()))

  await page.goto('/sign-in')
  const google = page.getByRole('button', { name: 'Continue with Google' })
  await expect(google).toBeVisible()
  await expect(page.getByRole('button', { name: 'Continue with GitHub' })).toBeVisible()
  await google.click()
  // While at the provider the tab keeps the binding, and nothing token-like.
  await expect(page.getByRole('heading', { name: 'Mock Google sign-in' })).toBeVisible()
  await consentAtProvider(page, { email })

  await expect(page.getByRole('heading', { name: /^Hello/ })).toBeVisible()
  expect(page.url()).not.toContain('tula_ticket')
  expect(page.url()).not.toContain('#')
  expect(await storage(page)).toEqual({ session: [], local: [] })
  // No request the app made carries a ticket; the only URLs with a code or state are the
  // provider's own redirect to the API's callback.
  for (const url of urls) {
    expect(url).not.toContain('tula_ot_')
    expect(url).not.toContain('tula_ob_')
    if (/[?&](code|state)=/.test(url)) {
      expect(new URL(url).pathname).toMatch(
        /^\/v1\/(oauth\/callback\/google|dev\/oauth\/authorize)$/
      )
    }
  }
  // Going back does not bring the ticket back into the address bar.
  await page.goto('/account')
  await expect(connected(page).getByText('Google')).toBeVisible()

  await signOut(page)
  await continueWithGoogle(page, { email })
  await expect(page.getByRole('heading', { name: /^Hello/ })).toBeVisible()
  await page.goto('/account')
  await expect(page.getByText(email)).toBeVisible()
})

test('the provider’s answer works once: a replayed callback and a replayed ticket sign nobody in', async ({
  page,
  context,
}) => {
  const email = uniqueEmail('oauth-replay')
  let callback = ''
  let landing = ''
  page.on('response', (response) => {
    if (new URL(response.url()).pathname === '/v1/oauth/callback/google') {
      callback = response.url()
      landing = response.headers().location ?? ''
    }
  })
  await continueWithGoogle(page, { email })
  await expect(page.getByRole('heading', { name: /^Hello/ })).toBeVisible()
  expect(callback).toContain('code=')
  expect(landing).toContain('#tula_ticket=')

  // Another browser (no binding, no cookie) replays both URLs.
  const other = await (await context.browser()?.newContext())?.newPage()
  if (!other) {
    throw new Error('could not open a second browser context')
  }
  await other.goto(callback)
  // The attempt is complete and keeps nothing of the round trip: the state matches no sign-in,
  // so there is no app page to go to and the API shows its static page.
  await expect(other.getByRole('heading', { name: 'Sign-in could not be completed' })).toBeVisible()
  await other.goto(landing)
  await expect(other.getByRole('heading', { name: 'Start again in this browser' })).toBeVisible()
  expect(other.url()).not.toContain('tula_ticket')
  await other.goto('/')
  await expect(other.getByRole('heading', { name: /^Hello/ })).toHaveCount(0)
  await other.context().close()
})

test('cancelling at the provider and an unverified address are explained, and nobody is signed in', async ({
  page,
}) => {
  await continueWithGoogle(page, { email: uniqueEmail('oauth-cancel'), cancel: true })
  await expect(page.getByRole('heading', { name: 'Sign-in was cancelled' })).toBeVisible()
  await expectAccessible(page, 'OAuth callback: cancelled')
  expect(await storage(page)).toEqual({ session: [], local: [] })

  await continueWithGoogle(page, { email: uniqueEmail('oauth-unverified'), unverified: true })
  await expect(page.getByRole('heading', { name: 'We could not sign you in' })).toBeVisible()
  await expect(page.getByText(/not verified with this provider/)).toBeVisible()
  await page.getByRole('link', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
})

test('an existing account with an unverified address is not linked into; a verified one is', async ({
  page,
  request,
}) => {
  // A verified account (signed up with a password): the provider account is connected to it.
  const member = uniqueEmail('oauth-member')
  await signUp(page, request, { email: member })
  await signOut(page)
  await continueWithGoogle(page, { email: member })
  await expect(page.getByRole('heading', { name: /^Hello/ })).toBeVisible()
  await page.goto('/account')
  await expect(page.getByText(member)).toBeVisible()
  await expect(connected(page).getByText('Google')).toBeVisible()
  await signOut(page)

  // An account whose address was never verified (a sign-up abandoned at the code would create
  // none, so an administrator-created one stands in): refused, with the way forward.
  const squatted = uniqueEmail('oauth-squatted')
  const created = await request.post(`${API_URL}/__test/unverified-user`, {
    data: { email: squatted },
  })
  expect(created.ok()).toBe(true)
  await continueWithGoogle(page, { email: squatted })
  await expect(page.getByRole('heading', { name: 'You already have an account' })).toBeVisible()
  await expect(page.getByText(/connect this provider under “Connected accounts”/)).toBeVisible()
  await expectAccessible(page, 'OAuth callback: account exists')
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /^Hello/ })).toHaveCount(0)
})

test('connect and disconnect a provider from the profile; the last way in cannot be removed', async ({
  page,
  request,
}) => {
  const email = uniqueEmail('oauth-link')
  await signUp(page, request, { email })
  await page.goto('/account')
  await expect(connected(page).getByText('No accounts are connected.')).toBeVisible()
  await expectAccessible(page, 'profile: connected accounts, none')

  await connected(page).getByRole('button', { name: 'Connect GitHub' }).click()
  await consentAtProvider(page, { email: uniqueEmail('oauth-github-address') })
  await expect(page.getByRole('heading', { name: 'Account connected' })).toBeVisible()
  await expect(page.getByText('Your GitHub account is connected.')).toBeVisible()
  expect(page.url()).not.toContain('tula_ticket')
  expect(await storage(page)).toEqual({ session: [], local: [] })
  await expectAccessible(page, 'OAuth callback: linked')
  await page.getByRole('link', { name: 'Back to your account' }).click()
  await expect(connected(page).getByText('GitHub')).toBeVisible()
  await expect(
    connected(page).getByRole('button', { name: 'Connect GitHub', exact: true })
  ).toHaveCount(0)
  await expectAccessible(page, 'profile: connected accounts, one')

  // This account has a password, so the provider account can go.
  await connected(page).getByRole('button', { name: 'Disconnect GitHub' }).click()
  await expect(connected(page).getByRole('status')).toHaveText('GitHub was disconnected.')

  // An account whose only way in is the provider account cannot remove it.
  await signOut(page)
  await continueWithGoogle(page, { email: uniqueEmail('oauth-only') })
  await expect(page.getByRole('heading', { name: /^Hello/ })).toBeVisible()
  await page.goto('/account')
  await connected(page).getByRole('button', { name: 'Disconnect Google' }).click()
  await expect(connected(page).getByRole('alert')).toContainText('only way to sign in')
  await expect(connected(page).getByRole('button', { name: 'Disconnect Google' })).toBeVisible()
  await expectAccessible(page, 'profile: last sign-in method refused')
})

/** Turn two-step verification on in the profile; returns the setup key. */
async function enrolAuthenticator(page: Page, request: APIRequestContext): Promise<string> {
  const section = page.getByRole('region', { name: 'Account' }).locator('section', {
    has: page.getByRole('heading', { name: 'Two-step verification' }),
  })
  await page.goto('/account')
  await section.getByRole('button', { name: 'Turn on' }).click()
  const key = page.getByRole('group', { name: 'Setup key' }).locator('code')
  await expect(key).toBeVisible()
  const secret = (await key.innerText()).replace(/\s/g, '')
  await page.getByLabel('Authentication code').fill(await authenticatorCode(request, secret))
  await section.getByRole('button', { name: 'Turn on' }).click()
  await page.getByLabel('I have saved these codes').check()
  await page.getByRole('button', { name: 'Done' }).click()
  await expect(section.getByText(/^On since/)).toBeVisible()
  return secret
}

test('a provider is only the first factor: a user with an authenticator is asked for it', async ({
  page,
  request,
}) => {
  const email = uniqueEmail('oauth-mfa')
  await continueWithGoogle(page, { email })
  await expect(page.getByRole('heading', { name: /^Hello/ })).toBeVisible()
  const secret = await enrolAuthenticator(page, request)
  await signOut(page)
  await advanceClock(request, 31_000)

  await continueWithGoogle(page, { email })
  await expect(page.getByRole('heading', { name: 'Two-step verification' })).toBeVisible()
  expect(page.url()).not.toContain('tula_ticket')
  await expectAccessible(page, 'OAuth callback: second factor')
  // Not signed in yet: the home page is the signed-out one.
  await page.getByLabel('Authentication code').fill(await authenticatorCode(request, secret))
  await page.getByRole('button', { name: 'Verify' }).click()
  await expect(page.getByRole('heading', { name: /^Hello/ })).toBeVisible()
})

for (const colorScheme of ['light', 'dark'] as const) {
  test(`the provider buttons and the connected accounts are accessible (${colorScheme})`, async ({
    page,
    request,
  }) => {
    await page.emulateMedia({ colorScheme })
    await page.goto('/sign-in')
    await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible()
    await expectAccessible(page, `sign-in with provider buttons (${colorScheme})`)
    await page.goto('/sign-up')
    await expect(page.getByRole('button', { name: 'Continue with GitHub' })).toBeVisible()
    await expectAccessible(page, `sign-up with provider buttons (${colorScheme})`)
    // The keyboard reaches the provider buttons first, then the form.
    await page.goto('/sign-in')
    await page.getByRole('button', { name: 'Continue with Google' }).focus()
    await page.keyboard.press('Tab')
    await expect(page.getByRole('button', { name: 'Continue with GitHub' })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(page.getByLabel('Email address')).toBeFocused()

    const email = uniqueEmail(`oauth-axe-${colorScheme}`)
    await signUp(page, request, { email })
    await page.goto('/account')
    await expect(page.getByRole('heading', { name: 'Connected accounts' })).toBeVisible()
    await expectAccessible(page, `profile with connected accounts (${colorScheme})`)
  })
}
