import { type APIRequestContext, expect, type Page, test } from '@playwright/test'
import {
  addVirtualAuthenticator,
  advanceClock,
  authenticatorCode,
  expectAccessible,
  latestCode,
  PASSKEY_METHODS,
  resetLimits,
  signIn,
  signOut,
  signUp,
  uniqueEmail,
  useSettings,
} from './support'

// Passkeys (ADR 0027) in a real browser against the real API. The ceremonies are Chromium's
// own (`navigator.credentials.create` and `.get`, its JSON helpers, its errors); the device is
// a virtual authenticator attached through the DevTools protocol: a platform authenticator
// with discoverable credentials and user verification. No physical authenticator is involved.

test.beforeEach(async ({ request }) => {
  await resetLimits(request)
})

test.afterEach(async ({ request }) => {
  await useSettings(request)
})

const account = (page: Page) => page.getByRole('region', { name: 'Account' })
const passkeys = (page: Page) =>
  account(page).locator('section', { has: page.getByRole('heading', { name: 'Passkeys' }) })
const twoStep = (page: Page) =>
  account(page).locator('section', {
    has: page.getByRole('heading', { name: 'Two-step verification' }),
  })
const CANCELLED = /The passkey request was cancelled or timed out/

/** Console errors, uncaught errors and failed requests while a scenario runs. */
function recordProblems(page: Page): string[] {
  const problems: string[] = []
  page.on('console', (message) => {
    const text = message.text()
    // The browser's own lines for two answers that are the design: a refused refresh on a
    // signed-out page (401) and "step up first" (403, `auth.step_up_required`).
    const expected = text.includes('401') || text.includes('403')
    if ((message.type() === 'error' || message.type() === 'warning') && !expected) {
      problems.push(text)
    }
  })
  page.on('pageerror', (error) => problems.push(String(error)))
  return problems
}

/** Add a passkey from the profile and wait for it to be listed. */
async function addPasskey(page: Page): Promise<void> {
  await page.goto('/account')
  await passkeys(page).getByRole('button', { name: 'Add a passkey' }).click()
  await expect(passkeys(page).getByText('Your passkey was added.')).toBeVisible()
  await expect(passkeys(page).getByRole('listitem')).toHaveCount(1)
}

/** Remove the passkey called `name` from the profile, answering the confirmation. */
async function removePasskey(page: Page, name: string): Promise<void> {
  await passkeys(page)
    .getByRole('button', { name: `Remove ${name}`, exact: true })
    .click()
  await passkeys(page)
    .getByRole('group')
    .getByRole('button', { name: 'Remove passkey', exact: true })
    .click()
}

/** Turn two-step verification on in the profile with an authenticator app the test plays. */
async function enrolAuthenticatorApp(page: Page, request: APIRequestContext): Promise<void> {
  await twoStep(page).getByRole('button', { name: 'Turn on' }).click()
  const key = page.getByRole('group', { name: 'Setup key' }).locator('code')
  await expect(key).toBeVisible()
  const secret = (await key.innerText()).replace(/\s/g, '')
  await page.getByLabel('Authentication code').fill(await authenticatorCode(request, secret))
  await twoStep(page).getByRole('button', { name: 'Turn on' }).click()
  await page.getByLabel('I have saved these codes').check()
  await page.getByRole('button', { name: 'Done' }).click()
  await expect(twoStep(page).getByText(/^On since/)).toBeVisible()
}

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme })

    test('a passkey from the profile: sign in with it, step up with it, rename it, remove it', async ({
      page,
      request,
    }) => {
      await useSettings(request, { ...PASSKEY_METHODS, mfa: { policy: 'optional' } })
      const authenticator = await addVirtualAuthenticator(page)
      const problems = recordProblems(page)
      const email = uniqueEmail(`passkey.${colorScheme}`)
      await signUp(page, request, { email, firstName: 'Maya' })

      await page.goto('/account')
      await expect(passkeys(page).getByText('You have no passkeys yet.')).toBeVisible()
      await expectAccessible(page, 'profile, no passkeys')

      // Registration: the browser's own `create()`, its `toJSON()` output accepted by the API.
      await passkeys(page).getByRole('button', { name: 'Add a passkey' }).click()
      await expect(passkeys(page).getByText('Your passkey was added.')).toBeVisible()
      const row = passkeys(page).getByRole('listitem')
      await expect(row).toHaveCount(1)
      await expect(row).toContainText('Passkey')
      await expect(row).toContainText(/Synced across your devices|On this device only/)
      await expect(row).toContainText('Not used yet')
      expect(await authenticator.credentialCount()).toBe(1)
      await expectAccessible(page, 'profile, one passkey')

      // The same authenticator again: `excludeCredentials` makes the browser refuse
      // (`InvalidStateError`), and nothing new is stored on either side.
      await passkeys(page).getByRole('button', { name: 'Add a passkey' }).click()
      await expect(passkeys(page).getByRole('alert')).toHaveText(
        'This device already has a passkey for this account.'
      )
      await expect(row).toHaveCount(1)
      expect(await authenticator.credentialCount()).toBe(1)
      await expectAccessible(page, 'profile, passkey already on this device')

      // An authenticator app as well: a passkey sign-in must not be asked for it.
      await enrolAuthenticatorApp(page, request)

      // From here the authenticator waits to be chosen, as it does in front of a person: the
      // request in the address field's autofill stays open instead of answering itself.
      await authenticator.setAnswering(false)
      await signOut(page)
      const button = page.getByRole('button', { name: 'Sign in with a passkey' })
      await expect(button).toBeVisible()
      await expect(page.getByLabel('Email address')).toHaveAttribute(
        'autocomplete',
        'username webauthn'
      )
      await expectAccessible(page, 'sign-in with the passkey button')

      // Usernameless: no address is typed. The button ends the autofill request and asks.
      await authenticator.setAnswering(true)
      await button.click()
      await expect(page.getByRole('heading', { name: 'Hello, Maya' })).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Two-step verification' })).toHaveCount(0)

      await page.goto('/account')
      await expect(passkeys(page).getByRole('listitem')).toContainText(/Last used /)

      // Ten minutes on, a change to the passkey needs a step-up; the passkey is one way.
      await advanceClock(request, 11 * 60_000)
      await page.goto('/account')
      await passkeys(page).getByRole('button', { name: 'Rename Passkey' }).click()
      const name = passkeys(page).getByLabel('Passkey name')
      await expect(name).toBeFocused()
      await expectAccessible(page, 'profile, renaming a passkey')
      await name.fill('Work laptop')
      await passkeys(page).getByRole('button', { name: 'Save' }).click()

      const dialog = page.getByRole('dialog', { name: 'Confirm it is you' })
      await expect(dialog.getByLabel('Authentication code')).toBeVisible()
      await expectAccessible(page, 'step-up dialog, a code with the passkey one click away')
      await dialog.getByRole('button', { name: 'Use your passkey instead' }).click()
      await expect(dialog.getByRole('button', { name: 'Use your passkey' })).toBeFocused()
      await expectAccessible(page, 'step-up dialog, passkey')
      await dialog.getByRole('button', { name: 'Use your passkey' }).click()
      await expect(dialog).toHaveCount(0)
      await expect(passkeys(page).getByText('The passkey was renamed.')).toBeVisible()
      await expect(passkeys(page).getByRole('listitem')).toContainText('Work laptop')

      await passkeys(page).getByRole('button', { name: 'Remove Work laptop' }).click()
      const question = passkeys(page).getByRole('group', { name: /^Remove “Work laptop”\?/ })
      await expect(question.getByRole('button', { name: 'Cancel' })).toBeFocused()
      await expectAccessible(page, 'profile, removing a passkey')
      await question.getByRole('button', { name: 'Remove passkey' }).click()
      await expect(passkeys(page).getByText('The passkey was removed.')).toBeVisible()
      await expect(passkeys(page).getByText('You have no passkeys yet.')).toBeVisible()
      await expectAccessible(page, 'profile, passkey removed')
      expect(problems).toEqual([])
    })

    test('a password, then the passkey as the second factor where the app requires two steps', async ({
      page,
      request,
    }) => {
      await useSettings(request, PASSKEY_METHODS)
      const authenticator = await addVirtualAuthenticator(page)
      const email = uniqueEmail(`passkey.second.${colorScheme}`)
      await signUp(page, request, { email, firstName: 'Ines' })
      await addPasskey(page)
      await authenticator.setAnswering(false)
      await signOut(page)

      await useSettings(request, { ...PASSKEY_METHODS, mfa: { policy: 'required' } })
      // The address field is waiting for a passkey from autofill all along: the form works.
      await signIn(page, email)
      await expect(page.getByRole('heading', { name: 'Two-step verification' })).toBeVisible()
      await expect(page.getByText('Use your passkey to finish signing in.')).toBeVisible()
      // The passkey is this user's only factor: no code is asked for, and none is enrolled.
      await expect(page.getByLabel('Authentication code')).toHaveCount(0)
      await expectAccessible(page, 'second factor, passkey')
      // Had the autofill request not been ended with its screen, this one would be refused:
      // a page may have one WebAuthn request pending.
      await authenticator.setAnswering(true)
      await page.getByRole('button', { name: 'Use your passkey' }).click()
      await expect(page.getByRole('heading', { name: 'Hello, Ines' })).toBeVisible()
    })

    test('a ceremony the authenticator refuses is said quietly, and the next try works', async ({
      page,
      request,
    }) => {
      await useSettings(request, PASSKEY_METHODS)
      const authenticator = await addVirtualAuthenticator(page)
      const email = uniqueEmail(`passkey.refused.${colorScheme}`)
      await signUp(page, request, { email, firstName: 'Noor' })
      await addPasskey(page)
      // The device does not verify the user: the browser ends the request (`NotAllowedError`).
      await authenticator.setUserVerified(false)
      await signOut(page)

      const button = page.getByRole('button', { name: 'Sign in with a passkey' })
      await button.click()
      await expect(page.getByText(CANCELLED)).toBeVisible()
      await expect(page.getByRole('alert')).toHaveCount(0)
      await expect(button).toBeFocused()
      await expect(button).not.toHaveAttribute('aria-disabled', 'true')
      await expectAccessible(page, 'sign-in, passkey request cancelled')
      // The rest of the screen still works after it: the address can be typed.
      await page.getByLabel('Email address').fill(email)
      await expect(page.getByLabel('Email address')).toHaveValue(email)

      await authenticator.setUserVerified(true)
      await button.click()
      await expect(page.getByRole('heading', { name: 'Hello, Noor' })).toBeVisible()

      // The same in the profile: a refused registration changes nothing and can be retried.
      await page.goto('/account')
      await removePasskey(page, 'Passkey')
      await expect(passkeys(page).getByText('You have no passkeys yet.')).toBeVisible()
      await authenticator.setUserVerified(false)
      await passkeys(page).getByRole('button', { name: 'Add a passkey' }).click()
      await expect(passkeys(page).getByText(CANCELLED)).toBeVisible()
      await expect(passkeys(page).getByRole('alert')).toHaveCount(0)
      await expect(passkeys(page).getByRole('button', { name: 'Add a passkey' })).toBeFocused()
      await expectAccessible(page, 'profile, passkey request cancelled')
      await authenticator.setUserVerified(true)
      await passkeys(page).getByRole('button', { name: 'Add a passkey' }).click()
      await expect(passkeys(page).getByText('Your passkey was added.')).toBeVisible()
    })
  })
}

test('the last way to sign in cannot be removed', async ({ page, request }) => {
  // An account with no password: it signs in by emailed code, then gets a passkey.
  await useSettings(request, {
    signIn: {
      methods: {
        password: { enabled: true },
        emailCode: { enabled: true },
        emailLink: { enabled: false },
        passkey: { enabled: true },
      },
    },
    signUp: { password: 'optional' },
  })
  const authenticator = await addVirtualAuthenticator(page)
  const email = uniqueEmail('passkey.last')
  await page.goto('/sign-up')
  await page.getByLabel('First name').fill('Ada')
  await page.getByLabel('Email address').fill(email)
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.getByLabel('Verification code').fill(await latestCode(request, email))
  await page.getByRole('button', { name: 'Verify' }).click()
  await expect(page.getByRole('heading', { name: 'Hello, Ada' })).toBeVisible()
  await addPasskey(page)

  // The app stops emailing codes: the passkey is now all this account has.
  await useSettings(request, PASSKEY_METHODS)
  await removePasskey(page, 'Passkey')
  await expect(passkeys(page).getByRole('alert')).toContainText(/only way to sign in/i)
  await expect(passkeys(page).getByRole('listitem')).toHaveCount(1)
  await expect(
    passkeys(page).getByRole('button', { name: 'Remove Passkey', exact: true })
  ).toBeFocused()
  await expectAccessible(page, 'profile, the last way to sign in cannot be removed')

  // It still signs in. Nobody presses a button here: the request the address field keeps open
  // for its autofill is answered by the authenticator (a person would pick the passkey from
  // the field's suggestions), and that alone signs in.
  expect(await authenticator.credentialCount()).toBe(1)
  await signOut(page)
  await expect(page.getByRole('heading', { name: 'Hello, Ada' })).toBeVisible()
})

test('a browser with no authenticator: the request ends, the page says so and recovers', async ({
  page,
  request,
}) => {
  await useSettings(request, PASSKEY_METHODS)
  const authenticator = await addVirtualAuthenticator(page)
  const email = uniqueEmail('passkey.gone')
  await signUp(page, request, { email, firstName: 'Lena' })
  await addPasskey(page)
  // Unverified, so the request is refused; then the device is taken away altogether.
  await authenticator.setUserVerified(false)
  await signOut(page)

  await page.getByRole('button', { name: 'Sign in with a passkey' }).click()
  await expect(page.getByText(CANCELLED)).toBeVisible()
  await authenticator.remove()

  // The password still signs in on the same screen.
  await page.getByLabel('Email address').fill(email)
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toBeVisible()
  await page.getByLabel('Password', { exact: true }).fill('sturdy-Otter-plays-42-chess')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Hello, Lena' })).toBeVisible()
})

test('passkeys switched off: no button, no autofill token, no section', async ({
  page,
  request,
}) => {
  await useSettings(request)
  await addVirtualAuthenticator(page)
  const email = uniqueEmail('passkey.off')
  await signUp(page, request, { email })
  await page.goto('/account')
  await expect(page.getByRole('heading', { name: 'Where you’re signed in' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Passkeys' })).toHaveCount(0)
  await signOut(page)
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toHaveCount(0)
  await expect(page.getByLabel('Email address')).toHaveAttribute('autocomplete', 'username')
})

/** Which of WebAuthn's JSON helpers the page's browser has. */
function jsonHelpers(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const platform = PublicKeyCredential as unknown as Record<string, unknown>
    return [
      typeof platform.parseCreationOptionsFromJSON === 'function' ? 'parseCreation' : null,
      typeof platform.parseRequestOptionsFromJSON === 'function' ? 'parseRequest' : null,
      typeof PublicKeyCredential.prototype.toJSON === 'function' ? 'toJSON' : null,
    ].filter((name): name is string => name !== null)
  })
}

test('the browser’s JSON helpers are what the other scenarios ran on', async ({ page }) => {
  await page.goto('/sign-in')
  expect(await jsonHelpers(page)).toEqual(['parseCreation', 'parseRequest', 'toJSON'])
})

test('a browser without WebAuthn’s JSON helpers: the client’s own conversion registers and signs in', async ({
  page,
  request,
}) => {
  // An older browser: `create()` and `get()` take and return buffers only.
  await page.addInitScript(() => {
    const platform = PublicKeyCredential as unknown as Record<string, unknown>
    delete platform.parseCreationOptionsFromJSON
    delete platform.parseRequestOptionsFromJSON
    delete (PublicKeyCredential.prototype as unknown as Record<string, unknown>).toJSON
  })
  await useSettings(request, PASSKEY_METHODS)
  const authenticator = await addVirtualAuthenticator(page)
  const email = uniqueEmail('passkey.fallback')
  await signUp(page, request, { email, firstName: 'Omar' })
  expect(await jsonHelpers(page)).toEqual([])
  await addPasskey(page)
  // Twice is still refused: `excludeCredentials` survived the conversion.
  await passkeys(page).getByRole('button', { name: 'Add a passkey' }).click()
  await expect(passkeys(page).getByRole('alert')).toHaveText(
    'This device already has a passkey for this account.'
  )

  await authenticator.setAnswering(false)
  await signOut(page)
  await authenticator.setAnswering(true)
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click()
  await expect(page.getByRole('heading', { name: 'Hello, Omar' })).toBeVisible()
})

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme, after an address`, () => {
    test.use({ colorScheme })

    test('the passkey is one of the other ways, on a screen of its own', async ({
      page,
      request,
    }) => {
      await useSettings(request, PASSKEY_METHODS)
      const authenticator = await addVirtualAuthenticator(page)
      const email = uniqueEmail(`passkey.after.${colorScheme}`)
      await signUp(page, request, { email, firstName: 'Kai' })
      await addPasskey(page)
      await authenticator.setAnswering(false)
      await signOut(page)

      await page.getByLabel('Email address').fill(email)
      await page.getByRole('button', { name: 'Continue', exact: true }).click()
      await expect(page.getByLabel('Password', { exact: true })).toBeVisible()
      const others = page.getByRole('list', { name: 'Other ways to sign in' })
      await expect(others.getByRole('button')).toHaveText(['Sign in with a passkey'])
      await expectAccessible(page, 'password screen with the passkey among the other ways')

      await others.getByRole('button', { name: 'Sign in with a passkey' }).click()
      await expect(page.getByRole('heading', { name: 'Sign in with a passkey' })).toBeFocused()
      await expect(page.getByText(email)).toBeVisible()
      await expectAccessible(page, 'first factor, passkey')

      await authenticator.setAnswering(true)
      await page.getByRole('button', { name: 'Sign in with a passkey' }).click()
      await expect(page.getByRole('heading', { name: 'Hello, Kai' })).toBeVisible()
    })
  })
}
