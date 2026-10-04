import { uniqueEmail } from '../support'
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
