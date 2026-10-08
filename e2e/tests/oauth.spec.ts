import { type APIRequestContext, expect, type Page, test } from '@playwright/test'
import {
  API_URL,
  advanceClock,
  authenticatorCode,
  consentAtProvider,
  expectAccessible,
  latestCode,
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

test('an exchange that gets no answer can be tried again from the callback page, and then signs in', async ({
  page,
}) => {
  const email = uniqueEmail('oauth-retry')
  // The first exchange never reaches the API (the network drops it); later ones go through.
  let dropped = 0
  await page.route('**/v1/client/sign-ins/oauth/exchange', async (route) => {
    if (dropped === 0) {
      dropped += 1
      await route.abort('connectionfailed')
    } else {
      await route.continue()
    }
  })
  await continueWithGoogle(page, { email })

  const retry = page.getByRole('button', { name: 'Try again' })
  await expect(retry).toBeVisible()
  await expect(page.getByRole('alert')).not.toBeEmpty()
  await expect(page.getByRole('heading', { name: /^Hello/ })).toHaveCount(0)
  expect(dropped).toBe(1)
  // The ticket left the address before the request; only the binding is kept, for the retry.
  expect(page.url()).not.toContain('tula_ticket')
  expect(page.url()).not.toContain('#')
  const kept = await storage(page)
  expect(kept.local).toEqual([])
  expect(kept.session).toHaveLength(1)
  expect(kept.session[0]).toMatch(/^tula\.oauth\./)
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await expectAccessible(page, `OAuth callback: no answer, try again (${colorScheme})`)
  }
  await page.emulateMedia({ colorScheme: 'light' })
  // The keyboard reaches the retry.
  await retry.focus()
  await page.keyboard.press('Enter')

  await expect(page.getByRole('heading', { name: /^Hello/ })).toBeVisible()
  expect(await storage(page)).toEqual({ session: [], local: [] })
})

test('a user with no password steps up with an emailed code, and their profile says how to add a password', async ({
  page,
  request,
}) => {
  const email = uniqueEmail('oauth-step-up')
  await continueWithGoogle(page, { email })
  await expect(page.getByRole('heading', { name: /^Hello/ })).toBeVisible()

  // No password: the profile explains how to add one instead of asking for the current one.
  await page.goto('/account')
  const account = page.getByRole('region', { name: 'Account' })
  const password = account.locator('section', {
    has: page.getByRole('heading', { name: 'Password', exact: true }),
  })
  await expect(password).toContainText('This account has no password')
  await expect(password).toContainText('Forgot password?')
  await expect(page.getByLabel('Current password')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Update password' })).toHaveCount(0)
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await expectAccessible(page, `profile without a password (${colorScheme})`)
  }
  await page.emulateMedia({ colorScheme: 'light' })

  // Eleven minutes on, turning two-step verification on needs a fresh proof. This user has
  // no password and no second factor: the dialog emails a code, once.
  await advanceClock(request, 11 * 60_000)
  const twoStep = account.locator('section', {
    has: page.getByRole('heading', { name: 'Two-step verification' }),
  })
  await twoStep.getByRole('button', { name: 'Turn on' }).click()
  const dialog = page.getByRole('dialog', { name: 'Confirm it is you' })
  await expect(dialog.getByText(/Enter the 6-digit code we sent to .\*\*\*@/)).toBeVisible()
  const field = dialog.getByLabel('Verification code')
  await expect(field).toBeFocused()
  await expect(dialog.getByLabel('Password', { exact: true })).toHaveCount(0)
  const code = await latestCode(request, email)
  const outbox = await request.get(`${API_URL}/__test/outbox?to=${encodeURIComponent(email)}`)
  const { data } = (await outbox.json()) as { data: { subject: string; text: string }[] }
  const codes = data.filter(({ subject }) => /^\d{6} is your .* confirmation code$/.test(subject))
  expect(codes).toHaveLength(1)
  // A step-up email carries a code and no link.
  expect(codes[0]?.text).not.toMatch(/https?:\/\//)
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await expectAccessible(page, `step-up dialog: emailed code (${colorScheme})`)
  }

  await field.fill(code === '000000' ? '111111' : '000000')
  await dialog.getByRole('button', { name: 'Continue' }).click()
  await expect(dialog.getByRole('alert')).toContainText('That code is incorrect. 4 attempts left.')
  await expect(field).toBeFocused()
  await expect(field).toHaveValue('')
  for (const colorScheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme })
    await expectAccessible(page, `step-up dialog: wrong emailed code (${colorScheme})`)
  }

  await field.fill(code)
  await dialog.getByRole('button', { name: 'Continue' }).click()
  await expect(dialog).toHaveCount(0)
  // The action that asked was repeated with the proof: the enrolment is on screen.
  await expect(page.getByRole('group', { name: 'Setup key' })).toBeVisible()
  // Nothing of the code is left in the page or its address.
  expect(await page.content()).not.toContain(code)
  expect(page.url()).not.toContain(code)
})

test('a step-up code asked for again too soon is not claimed to be sent: the dialog says when it can be', async ({
  page,
  request,
}) => {
  const email = uniqueEmail('oauth-step-up-soon')
  await continueWithGoogle(page, { email })
  await expect(page.getByRole('heading', { name: /^Hello/ })).toBeVisible()
  await page.goto('/account')
  await advanceClock(request, 11 * 60_000)
  const turnOn = page
    .getByRole('region', { name: 'Account' })
    .locator('section', { has: page.getByRole('heading', { name: 'Two-step verification' }) })
    .getByRole('button', { name: 'Turn on' })
  await turnOn.click()
  const dialog = page.getByRole('dialog', { name: 'Confirm it is you' })
  await expect(dialog.getByText(/Enter the 6-digit code we sent to .\*\*\*@/)).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toHaveCount(0)

  // A new dialog within the minute: its send is refused, so it has sent nothing and says so.
  await turnOn.click()
  await expect(dialog.getByText(/Try again in \d+s\./)).toBeVisible()
  await expect(dialog.getByLabel('Verification code')).toHaveCount(0)
  await expect(dialog).not.toContainText(/we sent|we emailed/i)
  await expect(dialog.getByRole('button', { name: 'Send code' })).toHaveAttribute(
    'aria-disabled',
    'true'
  )
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await expectAccessible(page, `step-up dialog: code refused for now (${colorScheme})`)
  }
  const outbox = await request.get(`${API_URL}/__test/outbox?to=${encodeURIComponent(email)}`)
  const { data } = (await outbox.json()) as { data: { subject: string }[] }
  expect(data.filter(({ subject }) => /^\d{6} is your /.test(subject))).toHaveLength(1)
})

test('a user with a password is offered the emailed code as the other way, and nothing is sent until they ask', async ({
  page,
  request,
}) => {
  const email = uniqueEmail('step-up-choice')
  await signUp(page, request, { email })
  await advanceClock(request, 11 * 60_000)
  await page.goto('/account')
  const before = await request.get(`${API_URL}/__test/outbox?to=${encodeURIComponent(email)}`)
  const sentBefore = ((await before.json()) as { data: unknown[] }).data.length
  await page
    .getByRole('region', { name: 'Account' })
    .locator('section', { has: page.getByRole('heading', { name: 'Two-step verification' }) })
    .getByRole('button', { name: 'Turn on' })
    .click()
  const dialog = page.getByRole('dialog', { name: 'Confirm it is you' })
  await expect(dialog.getByLabel('Password', { exact: true })).toBeFocused()
  await expectAccessible(page, 'step-up dialog: password or emailed code')
  const during = await request.get(`${API_URL}/__test/outbox?to=${encodeURIComponent(email)}`)
  expect(((await during.json()) as { data: unknown[] }).data).toHaveLength(sentBefore)

  await dialog.getByRole('button', { name: 'Email me a code instead' }).click()
  await expect(dialog.getByLabel('Verification code')).toBeFocused()
  await dialog.getByLabel('Verification code').fill(await latestCode(request, email, sentBefore))
  await dialog.getByRole('button', { name: 'Continue' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('group', { name: 'Setup key' })).toBeVisible()
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

// Microsoft: an account is its tenant and object ids, and its address counts as verified
// only with the verified-domain claim. The browser sees outcomes, as with every provider.
for (const colorScheme of ['light', 'dark'] as const) {
  test(`sign up and sign in with Microsoft; an address without the verified-domain claim is refused (${colorScheme})`, async ({
    page,
    request,
  }) => {
    await useProviders(request, ['google', 'microsoft'])
    await page.emulateMedia({ colorScheme })
    const email = uniqueEmail(`oauth-microsoft-${colorScheme}`)
    const account = { tenantId: crypto.randomUUID(), objectId: crypto.randomUUID() }

    await page.goto('/sign-in')
    const microsoft = page.getByRole('button', { name: 'Continue with Microsoft' })
    await expect(microsoft).toBeVisible()
    await expectAccessible(page, `sign-in with a Microsoft button (${colorScheme})`)
    await microsoft.click()
    await expect(page.getByRole('heading', { name: 'Mock Microsoft sign-in' })).toBeVisible()
    await consentAtProvider(page, { email, ...account })
    await expect(page.getByRole('heading', { name: /^Hello/ })).toBeVisible()
    expect(page.url()).not.toContain('tula_ticket')
    expect(await storage(page)).toEqual({ session: [], local: [] })
    await page.goto('/account')
    await expect(connected(page).getByText('Microsoft')).toBeVisible()
    await expectAccessible(page, `profile with a Microsoft account (${colorScheme})`)
    await signOut(page)

    // The same two ids sign the same user in, whatever address the token carries and
    // whether or not it carries the claim.
    await page.goto('/sign-in')
    await page.getByRole('button', { name: 'Continue with Microsoft' }).click()
    await consentAtProvider(page, {
      email: uniqueEmail('oauth-microsoft-renamed'),
      ...account,
      unverified: true,
    })
    await expect(page.getByRole('heading', { name: /^Hello/ })).toBeVisible()
    await page.goto('/account')
    await expect(page.getByText(email)).toBeVisible()
    await signOut(page)

    // Another tenant's account that carries this user's address and no claim: nobody is
    // signed in, and nothing is linked.
    await page.goto('/sign-in')
    await page.getByRole('button', { name: 'Continue with Microsoft' }).click()
    await consentAtProvider(page, {
      email,
      tenantId: crypto.randomUUID(),
      objectId: crypto.randomUUID(),
      unverified: true,
    })
    await expect(page.getByRole('heading', { name: 'We could not sign you in' })).toBeVisible()
    await expect(page.getByText(/not verified with this provider/)).toBeVisible()
    await expectAccessible(page, `OAuth callback: Microsoft address not verified (${colorScheme})`)
    await page.goto('/')
    await expect(page.getByRole('heading', { name: /^Hello/ })).toHaveCount(0)
  })
}

// Discord and LinkedIn: an account is the provider's own id, and its address counts as
// verified only when the provider says so (Discord's `verified`, LinkedIn's
// `email_verified`). The browser sees outcomes, as with every provider.
for (const colorScheme of ['light', 'dark'] as const) {
  for (const [provider, name, subject] of [
    [
      'discord',
      'Discord',
      () => String(BigInt(Date.now()) * 4194304n + BigInt(Math.floor(Math.random() * 4194304))),
    ],
    ['linkedin', 'LinkedIn', () => `li-${crypto.randomUUID()}`],
  ] as const) {
    test(`sign up and sign in with ${name}; an address the provider does not vouch for is refused (${colorScheme})`, async ({
      page,
      request,
    }) => {
      await useProviders(request, ['google', provider])
      await page.emulateMedia({ colorScheme })
      const email = uniqueEmail(`oauth-${provider}-${colorScheme}`)
      const account = subject()

      await page.goto('/sign-in')
      const button = page.getByRole('button', { name: `Continue with ${name}` })
      await expect(button).toBeVisible()
      await expectAccessible(page, `sign-in with a ${name} button (${colorScheme})`)
      await button.click()
      await expect(page.getByRole('heading', { name: `Mock ${name} sign-in` })).toBeVisible()
      await consentAtProvider(page, { email, subject: account })
      await expect(page.getByRole('heading', { name: /^Hello/ })).toBeVisible()
      expect(page.url()).not.toContain('tula_ticket')
      expect(await storage(page)).toEqual({ session: [], local: [] })
      await page.goto('/account')
      await expect(connected(page).getByText(name)).toBeVisible()
      await expectAccessible(page, `profile with a ${name} account (${colorScheme})`)
      await signOut(page)

      // The same id signs the same user in, whatever address the provider now reports and
      // whether or not it vouches for it.
      await page.goto('/sign-in')
      await page.getByRole('button', { name: `Continue with ${name}` }).click()
      await consentAtProvider(page, {
        email: uniqueEmail(`oauth-${provider}-renamed`),
        subject: account,
        unverified: true,
      })
      await expect(page.getByRole('heading', { name: /^Hello/ })).toBeVisible()
      await page.goto('/account')
      await expect(page.getByText(email)).toBeVisible()
      await signOut(page)

      // Another account that carries this user's address, unverified: nobody is signed in,
      // and nothing is linked.
      await page.goto('/sign-in')
      await page.getByRole('button', { name: `Continue with ${name}` }).click()
      await consentAtProvider(page, { email, subject: subject(), unverified: true })
      await expect(page.getByRole('heading', { name: 'We could not sign you in' })).toBeVisible()
      await expect(page.getByText(/not verified with this provider/)).toBeVisible()
      await expectAccessible(page, `OAuth callback: ${name} address not verified (${colorScheme})`)
      await page.goto('/')
      await expect(page.getByRole('heading', { name: /^Hello/ })).toHaveCount(0)
    })
  }
}

// The provider buttons: each drawn with its mark, named, and readable in both schemes
// at a desktop width and on a 375 px phone.
for (const colorScheme of ['light', 'dark'] as const) {
  for (const width of [1280, 375]) {
    test(`all six provider buttons render with their marks (${colorScheme}, ${width}px)`, async ({
      page,
      request,
    }) => {
      await useProviders(request, ['google', 'github', 'apple', 'microsoft', 'discord', 'linkedin'])
      await page.setViewportSize({ width, height: 800 })
      await page.emulateMedia({ colorScheme })
      await page.goto('/sign-in')
      for (const name of ['Google', 'GitHub', 'Apple', 'Microsoft', 'Discord', 'LinkedIn']) {
        const button = page.getByRole('button', { name: `Continue with ${name}`, exact: true })
        await expect(button).toBeVisible()
        // The mark is decorative (the label names the provider), 18 px square, and drawn.
        const mark = button.locator('svg')
        await expect(mark).toHaveCount(1)
        await expect(mark).toHaveAttribute('aria-hidden', 'true')
        const box = await mark.boundingBox()
        expect(Math.round(box?.width ?? 0)).toBe(18)
        expect(Math.round(box?.height ?? 0)).toBe(18)
        // On a phone the button fits the screen and its label is on one line.
        const size = await button.boundingBox()
        expect((size?.x ?? 0) + (size?.width ?? 0)).toBeLessThanOrEqual(width)
        expect(size?.height ?? 0).toBeLessThan(60)
      }
      // GitHub's and Apple's marks take the label's colour; Google's and Microsoft's keep
      // their own four, Discord's and LinkedIn's their own one.
      const colours = await page.evaluate(() =>
        [...document.querySelectorAll('.tula-oauth-buttons button')].map((button) => ({
          label: getComputedStyle(button.querySelector('span') ?? button).color,
          fills: [...button.querySelectorAll('svg path')].map(
            (path) => getComputedStyle(path).fill
          ),
        }))
      )
      expect(colours).toHaveLength(6)
      expect(new Set(colours[0]?.fills).size).toBe(4)
      expect(colours[1]?.fills).toEqual([colours[1]?.label])
      expect(colours[2]?.fills).toEqual([colours[2]?.label])
      expect(new Set(colours[3]?.fills).size).toBe(4)
      expect(colours[4]?.fills).toEqual(['rgb(88, 101, 242)'])
      expect(colours[5]?.fills).toEqual(['rgb(10, 102, 194)'])
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width
      )
      await expectAccessible(page, `six provider buttons (${colorScheme}, ${width}px)`)
    })
  }
}
