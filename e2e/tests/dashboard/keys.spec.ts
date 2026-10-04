import { advanceClock } from '../support'
import {
  dialog,
  ENVIRONMENT_PATH,
  expect,
  expectNoSecretKept,
  expectScreenAccessible,
  open,
  signIn,
  test,
} from './support'

// API keys (shown once), signing keys (rotation), the audit logs and diagnostics.

test.beforeEach(async ({ page }) => {
  await signIn(page)
})

test('an API key is shown once, leaves nothing behind, and can be revoked', async ({ page }) => {
  await open(page, `${ENVIRONMENT_PATH}/api-keys`, 'API keys')
  await expectScreenAccessible(page, 'API keys')

  await page.getByRole('button', { name: 'Create key' }).click()
  await dialog(page).getByRole('button', { name: 'Create key' }).click()
  await expect(dialog(page).getByRole('alert')).toContainText('Enter a name')
  const name = `e2e server ${Date.now()}`
  await dialog(page).getByLabel('Name').fill(name)
  await dialog(page).getByLabel('Kind').selectOption('secret')
  await dialog(page).getByRole('button', { name: 'Create key' }).click()

  await expect(dialog(page)).toContainText('Copy this key now')
  const key = (await dialog(page).getByTestId('created-key').textContent()) ?? ''
  expect(key).toMatch(/^tula_sk_/)
  await expectScreenAccessible(page, 'the new key, shown once')
  await dialog(page).getByRole('button', { name: 'I have copied it' }).click()
  await expect(dialog(page)).toBeHidden()

  // Gone: not in the document, the address, either storage, or a readable cookie.
  await expectNoSecretKept(page, [key])
  const row = page.getByRole('row').filter({ hasText: name })
  await expect(row).toContainText(`tula_sk_…${key.slice(-4)}`)
  await expect(row).toContainText('Active')
  // Opening the dialog again starts from an empty form, not from the last key.
  await page.getByRole('button', { name: 'Create key' }).click()
  await expect(dialog(page).getByLabel('Name')).toHaveValue('')
  await expectNoSecretKept(page, [key])
  await page.keyboard.press('Escape')
  await page.reload()
  await expect(page.getByRole('heading', { level: 1, name: 'API keys' })).toBeVisible()
  await expectNoSecretKept(page, [key])

  await row.getByRole('button', { name: `Revoke ${name}` }).click()
  await expect(dialog(page)).toContainText(`Revoke “${name}”?`)
  await dialog(page).getByRole('button', { name: 'Revoke key' }).click()
  await expect(row).toContainText('Revoked')

  // Both are in the environment's audit log, done by the dashboard's actor.
  await open(page, `${ENVIRONMENT_PATH}/audit-log`, 'Audit log')
  await page.getByLabel('Actor type').selectOption('instance_admin')
  await page.getByRole('button', { name: 'Apply filters' }).click()
  await expect(page).toHaveURL(/actorType=/)
  const entries = page.getByRole('table', { name: 'Audit entries' })
  await expect(entries).toContainText('api_key.revoked')
  await expect(entries).toContainText('api_key.created')
  await expect(entries.locator('[data-actor-type]').first()).toHaveText('instance_admin')
  await expectScreenAccessible(page, 'audit log, filtered')
  expect(await entries.innerHTML()).not.toContain(key)

  await page.getByLabel('Action').selectOption('user.deleted')
  await page.getByLabel('From (day, UTC)').fill('2001-01-01')
  await page.getByLabel('To (day, UTC)').fill('2001-01-02')
  await page.getByRole('button', { name: 'Apply filters' }).click()
  await expect(page.getByText('No entry matches these filters')).toBeVisible()
  await page.getByRole('button', { name: 'Clear filters' }).click()
  await expect(entries).toBeVisible()
})

test('signing keys: rotate, and a rotation that comes too soon is refused in words', async ({
  page,
}) => {
  // The fixture's keys were made when it started; a `next` key must have been published for
  // ten minutes before it may sign.
  await advanceClock(page.request, 11 * 60_000)
  await open(page, `${ENVIRONMENT_PATH}/signing-keys`, 'Signing keys')
  await expectScreenAccessible(page, 'signing keys')
  const keys = page.getByRole('table', { name: 'Signing keys' })
  const activeBefore = await keys
    .getByRole('row')
    .filter({ has: page.locator('[data-status="active"]') })
    .locator('code')
    .textContent()

  await page.getByRole('button', { name: 'Rotate keys' }).click()
  await expectScreenAccessible(page, 'confirm rotation')
  await dialog(page).getByRole('button', { name: 'Rotate keys' }).click()
  await expect(page.getByText('Signing keys rotated')).toBeVisible()
  await expect(
    keys
      .getByRole('row')
      .filter({ has: page.locator('[data-status="retired"]') })
      .first()
  ).toContainText(activeBefore ?? '')

  // The new `next` key is seconds old: the server refuses, and the dialog says so.
  await page.getByRole('button', { name: 'Rotate keys' }).click()
  await dialog(page).getByRole('button', { name: 'Rotate keys' }).click()
  await expect(dialog(page).getByRole('alert')).toBeVisible()
  await dialog(page).getByRole('button', { name: 'Cancel' }).click()

  await open(page, `${ENVIRONMENT_PATH}/audit-log?action=signing_key.rotated`, 'Audit log')
  await expect(page.getByRole('table', { name: 'Audit entries' })).toContainText('instance_admin')
})

test('diagnostics are rendered with their fix lines; the instance log shows the sign-in', async ({
  page,
}) => {
  await open(page, 'instance/diagnostics', 'Diagnostics')
  await expect(page.getByRole('heading', { name: 'Checks' })).toBeVisible()
  await expect(page.locator('[data-status]').first()).toBeVisible()
  await expect(page.getByText('Fix:').first()).toBeVisible()
  await expectScreenAccessible(page, 'diagnostics')

  await open(page, 'instance/audit-log', 'Instance audit log')
  const entries = page.getByRole('table', { name: 'Audit entries' })
  await expect(entries).toContainText('instance.signed_in')
  await expectScreenAccessible(page, 'instance audit log')
})
