import { API_URL, uniqueEmail, useSettings } from '../support'
import {
  APP_URL,
  dialog,
  ENVIRONMENT_PATH,
  expect,
  expectNoSecretKept,
  expectScreenAccessible,
  open,
  signIn,
  test,
  WORKSPACE_ID,
} from './support'

// The settings screens share one save model: load with the revision, replace with If-Match,
// "changed elsewhere" on a stale revision, and a confirmation before a weaker policy.

/** The fixture's secret key: a server-side caller (here, `tula apply`) beside the dashboard. */
const SECRET_KEY = 'tula_sk_dev_e2e000000000000000000000000000000'

test.beforeEach(async ({ page }) => {
  await useSettings(page.request)
  await signIn(page)
})

test.afterEach(async ({ page }) => {
  await useSettings(page.request)
})

test('the password policy: a stricter one is saved and the sign-up form follows; a weaker one asks first', async ({
  page,
  browser,
}) => {
  await open(page, `${ENVIRONMENT_PATH}/password-policy`, 'Password policy')
  await expectScreenAccessible(page, 'password policy')
  await expect(page.getByRole('status').filter({ hasText: 'No unsaved changes.' })).toBeVisible()

  await page.getByLabel('Minimum length').fill('14')
  await expect(page.getByLabel('Policy preset')).toHaveValue('custom')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Settings saved')).toBeVisible()

  // The example app's sign-up checklist is drawn from the environment's policy.
  const visitor = await browser.newContext()
  const signUp = await visitor.newPage()
  await signUp.goto(`${APP_URL}/sign-up`)
  await signUp.getByLabel('Password', { exact: true }).fill('short')
  await expect(signUp.getByText('Not met: 14 or more characters')).toBeAttached()
  await visitor.close()

  // Weaker: the contract's definition of "weakened" asks for a confirmation that says what.
  await page.getByLabel('Minimum length').fill('8')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(dialog(page)).toContainText('This weakens security')
  await expect(dialog(page)).toContainText('Passwords may be shorter')
  await expectScreenAccessible(page, 'weakening confirmation')
  await dialog(page).getByRole('button', { name: 'Cancel' }).click()
  await expect(
    page.getByRole('status').filter({ hasText: 'You have unsaved changes.' })
  ).toBeVisible()
  await page.getByRole('button', { name: 'Save changes' }).click()
  await dialog(page).getByRole('button', { name: 'Save anyway' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'No unsaved changes.' })).toBeVisible()

  // Below the floor: the server's field error is shown on the field and in the summary.
  await page.getByLabel('Minimum length').fill('4')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('These settings were not saved.')).toBeVisible()
  await expect(page.getByLabel('Minimum length')).toHaveAttribute('aria-invalid', 'true')
  await expectScreenAccessible(page, 'password policy, refused')
})

test('412: settings saved elsewhere are not overwritten', async ({ page, browser }) => {
  await open(page, `${ENVIRONMENT_PATH}/settings`, 'Settings')
  await expectScreenAccessible(page, 'general settings')

  // A second operator, in another browser, saves first.
  const other = await browser.newContext()
  const otherPage = await other.newPage()
  await signIn(otherPage)
  await otherPage.goto(`${API_URL}/dashboard/${ENVIRONMENT_PATH}/settings`)
  await otherPage.getByLabel('App name').fill('Saved first')
  await otherPage.getByRole('button', { name: 'Save changes' }).click()
  await expect(otherPage.getByText('Settings saved')).toBeVisible()
  await other.close()

  await page.getByLabel('App name').fill('Saved second')
  await page.getByRole('button', { name: 'Save changes' }).click()
  const conflict = page.getByRole('alert').filter({ hasText: 'Changed elsewhere.' })
  await expect(conflict).toBeVisible()
  await expectScreenAccessible(page, 'settings changed elsewhere')
  await conflict.getByRole('button', { name: 'Reload settings' }).click()
  await expect(conflict).toBeHidden()
  await expect(page.getByLabel('App name')).toHaveValue('Saved first')

  // With the current revision the save goes through.
  await page.getByLabel('App name').fill('Saved second')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Settings saved')).toBeVisible()
})

test('general settings: list editors validate with the contract, and a save is kept', async ({
  page,
}) => {
  await open(page, `${ENVIRONMENT_PATH}/settings`, 'Settings')
  const origins = page.getByRole('textbox', { name: 'Allowed origins' })
  await origins.fill('https://app.example.com/path')
  await page.getByRole('button', { name: 'Add origin' }).click()
  await expect(page.getByText(/must be an origin such as/)).toBeVisible()
  await expectScreenAccessible(page, 'general settings, a refused origin')
  await origins.fill('https://app.example.com')
  await origins.press('Enter')
  await expect(page.getByRole('list', { name: 'Allowed origins' })).toContainText(
    'https://app.example.com'
  )

  await page
    .getByRole('textbox', { name: 'Allowed redirect URLs' })
    .fill('https://app.example.com/callback')
  await page.getByRole('button', { name: 'Add URL' }).click()
  await page.getByLabel('Keep audit entries for (days)').fill('90')
  await page.getByRole('button', { name: 'Save changes' }).click()
  // A period where there was none deletes what is older, so the save asks first and says so.
  await expect(dialog(page)).toContainText('This deletes older audit entries for good')
  await expect(dialog(page)).toContainText(
    'Audit entries older than the new period are deleted for good'
  )
  await expectScreenAccessible(page, 'audit retention confirmation')
  await dialog(page).getByRole('button', { name: 'Save anyway' }).click()
  await expect(page.getByText('Settings saved')).toBeVisible()

  await page.reload()
  await expect(page.getByRole('list', { name: 'Allowed redirect URLs' })).toContainText(
    'https://app.example.com/callback'
  )
  await expect(page.getByLabel('Keep audit entries for (days)')).toHaveValue('90')

  // Switching a security notice off is a weakening too.
  await page.getByRole('switch', { name: 'A sign-in from a new device' }).click()
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(dialog(page)).toContainText('no longer told about a sign-in from a new device')
  await dialog(page).getByRole('button', { name: 'Cancel' }).click()
  await page.getByRole('button', { name: 'Discard changes' }).click()
  await expect(page.getByRole('switch', { name: 'A sign-in from a new device' })).toBeChecked()
})

test('managed by a config file: the banner, the confirmation and the drift notice', async ({
  page,
}) => {
  // What `tula apply` does: replace the settings and name itself and the config's hash.
  const current = await page.request.get(`${API_URL}/v1/admin/settings`, {
    headers: { authorization: `Bearer ${SECRET_KEY}` },
  })
  const state = (await current.json()) as { revision: number; settings: object }
  const applied = await page.request.put(`${API_URL}/v1/admin/settings`, {
    headers: {
      authorization: `Bearer ${SECRET_KEY}`,
      'if-match': `"${state.revision}"`,
      'x-tula-managed-by': 'tula-apply',
      'x-tula-config-hash': `sha256:${'ab'.repeat(32)}`,
    },
    data: state.settings,
  })
  expect(applied.status()).toBe(200)

  try {
    for (const [path, heading] of [
      ['sign-in-methods', 'Sign-in methods'],
      ['password-policy', 'Password policy'],
      ['sessions', 'Session profiles'],
      ['settings', 'Settings'],
    ] as const) {
      await open(page, `${ENVIRONMENT_PATH}/${path}`, heading)
      await expect(page.getByRole('note')).toContainText('Managed by tula apply')
      await expect(page.getByRole('note')).toContainText('reported as drift')
    }
    await expect(page.getByRole('note')).not.toContainText('Drift:')
    await expectScreenAccessible(page, 'settings managed by a config file')

    // Editing stays possible, but asks.
    await page.getByLabel('App name').fill('Edited in the dashboard')
    await page.getByRole('button', { name: 'Save changes' }).click()
    await expect(dialog(page)).toContainText('Change settings managed by a config file?')
    await dialog(page).getByRole('button', { name: 'Save anyway' }).click()
    await expect(page.getByText('Settings saved')).toBeVisible()
    await expect(page.getByRole('note')).toContainText('Drift:')
    await expectScreenAccessible(page, 'settings drifted from the config file')
  } finally {
    const now = await page.request.get(`${API_URL}/v1/admin/settings`, {
      headers: { authorization: `Bearer ${SECRET_KEY}` },
    })
    const latest = (await now.json()) as { revision: number; settings: object }
    await page.request.put(`${API_URL}/v1/admin/settings`, {
      headers: {
        authorization: `Bearer ${SECRET_KEY}`,
        'if-match': `"${latest.revision}"`,
        'x-tula-managed-by': 'none',
      },
      data: latest.settings,
    })
  }
})

test('sign-in methods: toggles, the last-method refusal, and a provider whose secret is write-only', async ({
  page,
}) => {
  await open(page, `${ENVIRONMENT_PATH}/sign-in-methods`, 'Sign-in methods')
  await expect(page.getByRole('heading', { name: 'Google' })).toBeVisible()
  await expectScreenAccessible(page, 'sign-in methods')

  // The only method on is the password: switching it off is refused by the server, and said.
  await page.getByRole('switch', { name: 'Email and password' }).click()
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(
    page.getByText(/at least one sign-in method must stay enabled/).first()
  ).toBeVisible()
  await expectScreenAccessible(page, 'sign-in methods, last method refused')
  await page.getByRole('button', { name: 'Discard changes' }).click()

  await page.getByRole('switch', { name: 'Emailed code' }).click()
  await page.getByLabel('Two-step verification').selectOption('required')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Settings saved')).toBeVisible()
  await page.reload()
  await expect(page.getByRole('switch', { name: 'Emailed code' })).toBeChecked()
  await expect(page.getByLabel('Two-step verification')).toHaveValue('required')

  // A provider: the redirect URI to register, and a secret that is never shown again.
  const google = page
    .getByRole('listitem')
    .filter({ has: page.getByRole('heading', { name: 'Google' }) })
  await expect(google.locator('code').first()).toContainText(`${API_URL}/v1/`)
  await expect(google.locator('code').first()).toContainText('google')
  const secret = `dashboard-e2e-${uniqueEmail('secret')}`
  await google.getByLabel('Client ID').fill('dashboard-e2e-client')
  await google.getByLabel('Client secret').fill(secret)
  await google.getByRole('button', { name: 'Save Google' }).click()
  await expect(page.getByText('Google saved')).toBeVisible()
  await expect(google.getByText(/A client secret is saved/)).toBeVisible()
  await expect(google.getByLabel('Client secret')).toHaveCount(0)
  await expectNoSecretKept(page, [secret])
  await expectScreenAccessible(page, 'sign-in methods, a configured provider')

  await google.getByRole('button', { name: 'Replace secret' }).click()
  await expect(google.getByLabel('Client secret')).toHaveValue('')

  await google.getByRole('button', { name: 'Remove Google' }).click()
  await dialog(page).getByRole('button', { name: 'Remove Google' }).click()
  await expect(page.getByText('Google removed')).toBeVisible()
  await expect(google.getByText('Not configured')).toBeVisible()
})

test('session profiles: add a custom profile, set a limit, and a bad duration is refused on its field', async ({
  page,
}) => {
  await open(page, `${ENVIRONMENT_PATH}/sessions`, 'Session profiles')
  await expectScreenAccessible(page, 'session profiles')

  await page.getByLabel('New profile name').fill('Admin Panel')
  await page.getByRole('button', { name: 'Add profile' }).click()
  await expect(page.getByText(/Use lowercase letters/)).toBeVisible()
  await page.getByLabel('New profile name').fill('admin')
  await page.getByRole('button', { name: 'Add profile' }).click()
  const admin = page
    .getByRole('listitem')
    .filter({ has: page.getByRole('heading', { name: 'admin' }) })
  await admin.getByLabel('Idle timeout').fill('15m')
  await page.getByLabel('Sessions per user').fill('5')
  await page.getByRole('button', { name: 'Save changes' }).click()
  // A limit where there was none is stricter; a new profile copied from "web" is not weaker.
  await expect(page.getByText('Settings saved')).toBeVisible()

  await admin.getByLabel('Idle timeout').fill('soon')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('These settings were not saved.')).toBeVisible()
  await expectScreenAccessible(page, 'session profiles, refused')
})

test('a draft made in one environment does not follow the operator to another', async ({
  page,
}) => {
  // A project of its own: a development and a production environment with the same
  // (default) settings and the same revision, which is when a stale If-Match would pass.
  const headers = { 'x-tula-dashboard': '1', origin: API_URL }
  const created = await page.request.post(`${API_URL}/v1/instance/projects`, {
    headers,
    data: { workspaceId: WORKSPACE_ID, name: `Switch ${Date.now()}` },
  })
  expect(created.status()).toBe(201)
  const { project, environments } = (await created.json()) as {
    project: { id: string }
    environments: { id: string; kind: string }[]
  }
  const development = environments.find((entry) => entry.kind === 'development')?.id ?? ''
  const production = environments.find((entry) => entry.kind === 'production')?.id ?? ''
  const minimumOf = async (environmentId: string) => {
    const response = await page.request.get(`${API_URL}/v1/admin/settings`, {
      headers: { ...headers, 'x-tula-environment': environmentId },
    })
    return ((await response.json()) as { settings: { password: { minLength: number } } }).settings
      .password.minLength
  }
  const initial = await minimumOf(production)

  await open(
    page,
    `w/${WORKSPACE_ID}/p/${project.id}/e/${development}/password-policy`,
    'Password policy'
  )
  await page.getByLabel('Minimum length').fill('8')
  await expect(
    page.getByRole('status').filter({ hasText: 'You have unsaved changes.' })
  ).toBeVisible()

  await page
    .getByRole('group', { name: 'Switch environment' })
    .getByRole('link', { name: 'Production' })
    .click()
  await expect(page).toHaveURL(new RegExp(`/e/${production}/password-policy$`))

  // Production's own values, nothing to save, and no confirmation waiting.
  await expect(page.getByLabel('Minimum length')).toHaveValue(String(initial))
  await expect(page.getByRole('status').filter({ hasText: 'No unsaved changes.' })).toBeVisible()
  await expectScreenAccessible(page, 'password policy after an environment switch')

  // A save made here is production's document, changed here, and development is untouched.
  await page.getByLabel('Minimum length').fill(String(initial + 6))
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Settings saved')).toBeVisible()
  expect(await minimumOf(production)).toBe(initial + 6)
  expect(await minimumOf(development)).toBe(initial)
})
