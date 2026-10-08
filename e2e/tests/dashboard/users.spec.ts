import type { Page } from '@playwright/test'
import { authenticatorCode, consentAtProvider, uniqueEmail, useProviders } from '../support'
import {
  APP_URL,
  dialog,
  ENVIRONMENT_PATH,
  expect,
  expectNoSecretKept,
  expectScreenAccessible,
  open,
  openUser,
  signIn,
  signUpInExampleApp,
  test,
} from './support'

// Managing users from the dashboard, against users who signed up through the example app.

test.beforeEach(async ({ page }) => {
  await signIn(page)
})

test('find a user created by the example app, ban and unban them', async ({ page, browser }) => {
  const email = uniqueEmail('dash-ban')
  const userContext = await browser.newContext()
  const userPage = await userContext.newPage()
  await signUpInExampleApp(userPage, email)

  await open(page, `${ENVIRONMENT_PATH}/users`, 'Users')
  await expectScreenAccessible(page, 'users list')
  await page.getByLabel('Search users').fill(email)
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  // The search is in the address: a link to it, and a reload, show the same result.
  await expect(page).toHaveURL(/users\?q=/)
  await page.reload()
  await expect(page.getByRole('link', { name: email })).toBeVisible()
  await page.getByRole('link', { name: email }).click()
  await expect(page.getByRole('heading', { level: 1, name: email })).toBeVisible()
  await expect(page.getByRole('table', { name: 'Active sessions' })).toContainText('web')
  await expectScreenAccessible(page, 'user detail')

  await page.getByRole('button', { name: 'Ban user', exact: true }).click()
  await expect(dialog(page)).toContainText(`Ban ${email}?`)
  await expectScreenAccessible(page, 'confirm ban')
  // Escape closes the dialog and gives the focus back to the button that opened it.
  await page.keyboard.press('Escape')
  await expect(dialog(page)).toBeHidden()
  await expect(page.getByRole('button', { name: 'Ban user', exact: true })).toBeFocused()

  await page.getByRole('button', { name: 'Ban user', exact: true }).click()
  await dialog(page).getByRole('button', { name: 'Ban user', exact: true }).click()
  await expect(page.getByText('Banned', { exact: true }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Unban user' })).toBeVisible()

  // The example app, in the user's own browser, is signed out by the ban.
  await userPage.goto(`${APP_URL}/`)
  await expect(userPage.getByRole('heading', { name: 'Northline' })).toBeVisible()

  await page.getByRole('button', { name: 'Unban user' }).click()
  await dialog(page).getByRole('button', { name: 'Unban user' }).click()
  await expect(page.getByRole('button', { name: 'Ban user', exact: true })).toBeVisible()

  // Both are in the audit log, done by the dashboard's actor.
  const activity = page.getByRole('table', { name: 'Recent activity for this user' })
  await expect(activity).toContainText('user.banned')
  await expect(activity).toContainText('user.unbanned')
  await expect(activity).toContainText('instance_admin')
  await userContext.close()
})

test('revoke one session: the example app is signed out', async ({ page, browser }) => {
  const email = uniqueEmail('dash-revoke')
  const userContext = await browser.newContext()
  const userPage = await userContext.newPage()
  await signUpInExampleApp(userPage, email)

  await openUser(page, email)
  await page.getByRole('button', { name: /^Revoke the web session/ }).click()
  await expect(dialog(page)).toContainText(`Revoke this session of ${email}?`)
  await dialog(page).getByRole('button', { name: 'Revoke session' }).click()
  await expect(page.getByText('No active sessions')).toBeVisible()

  await userPage.goto(`${APP_URL}/`)
  await expect(userPage.getByRole('heading', { name: 'Northline' })).toBeVisible()
  await userContext.close()
})

test('set a password (policy errors shown), reset two-step verification, delete', async ({
  page,
  browser,
}) => {
  const email = uniqueEmail('dash-manage')
  const userContext = await browser.newContext()
  await signUpInExampleApp(await userContext.newPage(), email)
  await userContext.close()

  await openUser(page, email)
  await page.getByRole('button', { name: 'Set password' }).click()
  await expectScreenAccessible(page, 'set password dialog')
  await dialog(page).getByLabel('New password').fill('short')
  await dialog(page).getByRole('button', { name: 'Set password' }).click()
  await expect(dialog(page).getByRole('alert').first()).toBeVisible()
  await expectScreenAccessible(page, 'set password dialog, refused')
  const password = 'granite-Lantern-hums-93-softly'
  await dialog(page).getByLabel('New password').fill(password)
  await dialog(page).getByRole('button', { name: 'Set password' }).click()
  await expect(dialog(page)).toBeHidden()
  await expect(page.getByText('No active sessions')).toBeVisible()
  await expectNoSecretKept(page, [password])

  await page.getByRole('button', { name: 'Reset two-step verification' }).click()
  await dialog(page).getByRole('button', { name: 'Reset two-step verification' }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'can still sign in' })).toBeVisible()
  await expectScreenAccessible(page, 'user detail after a factor reset')

  await page.getByRole('button', { name: 'Delete user' }).click()
  await expect(dialog(page)).toContainText(`Delete ${email}?`)
  await dialog(page).getByRole('button', { name: 'Delete user' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Users' })).toBeVisible()
  await page.getByLabel('Search users').fill(email)
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  await expect(page.getByText('No user matches that search')).toBeVisible()
  await expectScreenAccessible(page, 'users list, no match')
})

/** The "How this user signs in" section of the open user. */
function signInMethods(page: Page) {
  return page.locator('section', {
    has: page.getByRole('heading', { name: 'How this user signs in' }),
  })
}

test('how a user signs in: a password with an authenticator app', async ({ page, browser }) => {
  const email = uniqueEmail('dash-totp')
  const userContext = await browser.newContext()
  const userPage = await userContext.newPage()
  await signUpInExampleApp(userPage, email)
  // Turn two-step verification on in the example app's profile, as the user would.
  await userPage.goto(`${APP_URL}/account`)
  const twoStep = userPage.getByRole('region', { name: 'Account' }).locator('section', {
    has: userPage.getByRole('heading', { name: 'Two-step verification' }),
  })
  await twoStep.getByRole('button', { name: 'Turn on' }).click()
  const key = userPage.getByRole('group', { name: 'Setup key' }).locator('code')
  await expect(key).toBeVisible()
  const secret = (await key.innerText()).replace(/\s/g, '')
  await userPage
    .getByLabel('Authentication code')
    .fill(await authenticatorCode(userPage.request, secret))
  await twoStep.getByRole('button', { name: 'Turn on' }).click()
  const shown = userPage.getByRole('list', { name: 'Backup codes' }).getByRole('listitem')
  await expect(shown).toHaveCount(10)
  const codes = await shown.allInnerTexts()
  await userPage.getByLabel('I have saved these codes').check()
  await userPage.getByRole('button', { name: 'Done' }).click()
  await expect(twoStep.getByText(/^On since/)).toBeVisible()
  await userContext.close()

  await openUser(page, email)
  const methods = signInMethods(page)
  await expect(methods).toContainText('Has a password')
  await expect(methods).toContainText('Verified')
  await expect(methods).toContainText('No linked accounts')
  await expect(methods).toContainText(/Authenticator app since /)
  await expect(methods).toContainText(`${codes.length} backup codes left`)
  await expect(methods).toContainText('No passkeys')
  await expectScreenAccessible(page, 'user detail, password and authenticator app')
  // The dashboard is told that the factor exists, never what it is.
  await expectNoSecretKept(page, [secret, ...codes])

  // This user keeps their password: the reset says nothing about being locked out.
  await page.getByRole('button', { name: 'Reset two-step verification' }).click()
  await expect(dialog(page)).not.toContainText('Warning')
  await dialog(page).getByRole('button', { name: 'Reset two-step verification' }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'can still sign in' })).toBeVisible()
  await expect(methods).toContainText('Off')
  await expect(methods).not.toContainText('backup code')
})

test('how a user signs in: no password, a linked provider account; the reset warns first', async ({
  page,
  browser,
}) => {
  const email = uniqueEmail('dash-oauth')
  await useProviders(page.request, ['google'])
  try {
    const userContext = await browser.newContext()
    const userPage = await userContext.newPage()
    await userPage.goto(`${APP_URL}/sign-in`)
    await userPage.getByRole('button', { name: 'Continue with Google' }).click()
    await consentAtProvider(userPage, { email })
    await expect(userPage.getByRole('heading', { name: /^Hello/ })).toBeVisible()
    await userContext.close()

    await openUser(page, email)
    const methods = signInMethods(page)
    await expect(methods).toContainText('No password; signs in with Google.')
    await expect(methods).toContainText(/Google, linked /)
    await expect(methods).toContainText('Off')
    await expectScreenAccessible(page, 'user detail, no password and a linked account')

    // While Google is on, the linked account is a way in: no warning.
    await page.getByRole('button', { name: 'Reset two-step verification' }).click()
    await expect(dialog(page)).not.toContainText('Warning')
    await page.keyboard.press('Escape')
    await expect(dialog(page)).toBeHidden()
  } finally {
    await useProviders(page.request)
  }

  // With the provider switched off nothing the account has is accepted here any more (the
  // fixture has no emailed code): the dialog says so before anything is reset.
  await page.reload()
  await expect(signInMethods(page)).toContainText('No password; signs in with Google.')
  await page.getByRole('button', { name: 'Reset two-step verification' }).click()
  await expect(dialog(page)).toContainText(/Warning: .*no way left to sign in/)
  await expectScreenAccessible(page, 'reset two-step verification, warned of a lock-out')
  await dialog(page).getByRole('button', { name: 'Reset two-step verification' }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'no way left to sign in' })).toBeVisible()
  await expectScreenAccessible(page, 'user detail after a reset that left no way in')
})

test('create a user from the dashboard; a refused address is shown on its field', async ({
  page,
}) => {
  await open(page, `${ENVIRONMENT_PATH}/users`, 'Users')
  await page.getByRole('button', { name: 'Create user' }).click()
  await expectScreenAccessible(page, 'create user dialog')
  await dialog(page).getByRole('button', { name: 'Create user' }).click()
  await expect(dialog(page).getByRole('alert')).toHaveText('Enter an email address.')

  const email = uniqueEmail('dash-created')
  await dialog(page).getByLabel('Email', { exact: true }).fill(email)
  await dialog(page).getByLabel('Mark the email as verified').check()
  await dialog(page).getByRole('button', { name: 'Create user' }).click()
  await expect(dialog(page)).toBeHidden()
  await page.getByLabel('Search users').fill(email)
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  await expect(page.getByRole('link', { name: email })).toBeVisible()

  // The same address again: the server's refusal is shown, not swallowed.
  await page.getByRole('button', { name: 'Create user' }).click()
  await dialog(page).getByLabel('Email', { exact: true }).fill(email)
  await dialog(page).getByRole('button', { name: 'Create user' }).click()
  await expect(dialog(page).getByRole('alert')).toBeVisible()
})
