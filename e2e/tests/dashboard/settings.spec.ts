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
      ['text-messages', 'Text messages'],
      // Last: the edit below is made on this screen.
      ['settings', 'Settings'],
    ] as const) {
      await open(page, `${ENVIRONMENT_PATH}/${path}`, heading)
      // Text messages has a second note (the deployment's SMS sender): this one by its words.
      const managed = page.getByRole('note').filter({ hasText: 'Managed by tula apply' })
      await expect(managed).toHaveCount(1)
      await expect(managed).toContainText('reported as drift')
    }
    await expect(
      page.getByRole('note').filter({ hasText: 'Managed by tula apply' })
    ).not.toContainText('Drift:')
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

  // The client id of a native app (ADR 0045): a gained one is asked about before it is saved.
  const nativeClient = '1234567890-android.apps.googleusercontent.com'
  await google.getByLabel('OAuth clients of your Android and iOS apps').fill(nativeClient)
  await google.getByRole('button', { name: 'Save Google' }).click()
  await expect(dialog(page)).toContainText('Accept Google ID tokens from 1 more app?')
  await expectScreenAccessible(page, 'sign-in methods, a native client id asked about')
  await dialog(page).getByRole('button', { name: 'Accept their tokens' }).click()
  await expect(page.getByText('Google saved').last()).toBeVisible()
  await page.reload()
  await expect(google.getByLabel('OAuth clients of your Android and iOS apps')).toHaveValue(
    nativeClient
  )

  await google.getByRole('button', { name: 'Replace secret' }).click()
  await expect(google.getByLabel('Client secret')).toHaveValue('')

  await google.getByRole('button', { name: 'Remove Google' }).click()
  await dialog(page).getByRole('button', { name: 'Remove Google' }).click()
  await expect(page.getByText('Google removed')).toBeVisible()
  await expect(google.getByText('Not configured')).toBeVisible()
})

for (const [provider, name] of [
  ['discord', 'Discord'],
  ['linkedin', 'LinkedIn'],
  ['x', 'X'],
  ['facebook', 'Facebook'],
] as const) {
  test(`${name}: a client id and a secret, saved once and never shown again`, async ({ page }) => {
    await open(page, `${ENVIRONMENT_PATH}/sign-in-methods`, 'Sign-in methods')
    const card = page
      .getByRole('listitem')
      .filter({ has: page.getByRole('heading', { name, exact: true }) })
    await expect(card.locator('code').first()).toContainText(`${API_URL}/v1/`)
    await expect(card.locator('code').first()).toContainText(provider)
    // Nothing but the two: no tenant, no team, no key.
    await expect(card.getByLabel('Who can sign in')).toHaveCount(0)
    const secret = `dashboard-e2e-${uniqueEmail(`${provider}-secret`)}`
    await card.getByLabel('Client ID').fill(`dashboard-e2e-${provider}-client`)
    await card.getByLabel('Client secret').fill(secret)
    await card.getByRole('button', { name: `Save ${name}` }).click()
    await expect(page.getByText(`${name} saved`)).toBeVisible()
    await expect(card.getByText(/A client secret is saved/)).toBeVisible()
    await expect(card.getByLabel('Client secret')).toHaveCount(0)
    await expectNoSecretKept(page, [secret])
    await expectScreenAccessible(page, `sign-in methods, ${name} configured`)

    await card.getByRole('button', { name: `Remove ${name}` }).click()
    await dialog(page)
      .getByRole('button', { name: `Remove ${name}` })
      .click()
    await expect(page.getByText(`${name} removed`)).toBeVisible()
    await expect(card.getByText('Not configured')).toBeVisible()
  })
}

test('Microsoft: who can sign in is asked, has no default, and one organization is its tenant id', async ({
  page,
}) => {
  await open(page, `${ENVIRONMENT_PATH}/sign-in-methods`, 'Sign-in methods')
  const microsoft = page
    .getByRole('listitem')
    .filter({ has: page.getByRole('heading', { name: 'Microsoft' }) })
  await expect(microsoft.locator('code').first()).toContainText('microsoft')
  const secret = `dashboard-e2e-${uniqueEmail('ms-secret')}`
  const audience = microsoft.getByLabel('Who can sign in')
  await expect(audience).toHaveValue('')
  await microsoft.getByLabel('Application (client) ID').fill('dashboard-e2e-ms-client')
  await microsoft.getByLabel('Client secret').fill(secret)

  // Nothing chosen: the API refuses it, and the question says so.
  await microsoft.getByRole('button', { name: 'Save Microsoft' }).click()
  await expect(audience).toHaveAttribute('aria-invalid', 'true')
  await expectScreenAccessible(page, 'sign-in methods, Microsoft without a tenant')

  // One organization, by a domain name: refused at the id; by its id: saved, lower-cased.
  await audience.selectOption('tenant')
  const tenant = microsoft.getByLabel('Directory (tenant) ID')
  await tenant.fill('contoso.onmicrosoft.com')
  await microsoft.getByRole('button', { name: 'Save Microsoft' }).click()
  await expect(tenant).toHaveAttribute('aria-invalid', 'true')
  await tenant.fill('72F988BF-86F1-41AF-91AB-2D7CD011DB47')
  await microsoft.getByRole('button', { name: 'Save Microsoft' }).click()
  await expect(page.getByText('Microsoft saved')).toBeVisible()
  await expect(microsoft.getByText(/A client secret is saved/)).toBeVisible()
  await expectNoSecretKept(page, [secret])
  await page.reload()
  await expect(microsoft.getByLabel('Who can sign in')).toHaveValue('tenant')
  await expect(microsoft.getByLabel('Directory (tenant) ID')).toHaveValue(
    '72f988bf-86f1-41af-91ab-2d7cd011db47'
  )
  await expectScreenAccessible(page, 'sign-in methods, Microsoft for one organization')

  // Widened to every account: saved without the secret being typed again.
  await microsoft.getByLabel('Who can sign in').selectOption('common')
  await expect(microsoft.getByLabel('Directory (tenant) ID')).toHaveCount(0)
  await microsoft.getByRole('button', { name: 'Save Microsoft' }).click()
  await expect(page.getByText('Microsoft saved')).toBeVisible()
  await page.reload()
  await expect(microsoft.getByLabel('Who can sign in')).toHaveValue('common')

  await microsoft.getByRole('button', { name: 'Remove Microsoft' }).click()
  await dialog(page).getByRole('button', { name: 'Remove Microsoft' }).click()
  await expect(page.getByText('Microsoft removed')).toBeVisible()
  await expect(microsoft.getByText('Not configured')).toBeVisible()
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

test('device binding: requiring a device key is saved at once; asking less asks first, in words', async ({
  page,
}) => {
  await open(page, `${ENVIRONMENT_PATH}/sessions`, 'Session profiles')
  const card = (name: string) =>
    page
      .getByRole('listitem')
      .filter({ has: page.getByRole('heading', { name }) })
      .filter({ has: page.getByLabel('Device binding') })
  const binding = async () => {
    const saved = await page.request.get(`${API_URL}/v1/admin/settings`, {
      headers: { authorization: `Bearer ${SECRET_KEY}` },
    })
    const { settings } = (await saved.json()) as {
      settings: { sessions: { profiles: Record<string, { deviceBinding: string }> } }
    }
    return settings.sessions.profiles.mobile?.deviceBinding
  }
  await expect(card('web').getByLabel('Device binding')).toHaveValue('none')
  await expect(card('mobile').getByLabel('Device binding')).toHaveValue('optional')
  await expect(card('mobile')).toContainText('A change applies to new sign-ins only')
  await expect(card('web')).toContainText('the value changes nothing here')

  // Asking for more weakens nothing: saved without a question.
  await card('mobile').getByLabel('Device binding').selectOption('required')
  await expectScreenAccessible(page, 'session profiles, device binding required')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Settings saved')).toBeVisible()
  expect(await binding()).toBe('required')

  // Asking for less is the contract's weakening, said in the operator's words.
  await card('mobile').getByLabel('Device binding').selectOption('optional')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(dialog(page)).toContainText('This weakens security')
  await expect(dialog(page)).toContainText(
    'Native apps that sign in under the “mobile” profile are asked less for a device key'
  )
  await expect(dialog(page)).toContainText('Sessions that exist are not changed')
  await expectScreenAccessible(page, 'device binding, asking less confirmation')
  // Nothing was sent before the answer.
  expect(await binding()).toBe('required')
  await dialog(page).getByRole('button', { name: 'Save anyway' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'No unsaved changes.' })).toBeVisible()
  expect(await binding()).toBe('optional')
})

test('JWT templates: a template is built, chosen for a profile and saved; a reserved claim and a template in use are refused; losing claims asks first', async ({
  page,
}) => {
  await open(page, `${ENVIRONMENT_PATH}/sessions`, 'Session profiles')
  await expect(page.getByText('No templates yet.')).toBeVisible()

  await page.getByLabel('New template name').fill('app')
  await page.getByRole('button', { name: 'Add template' }).click()
  const template = page
    .getByRole('listitem')
    .filter({ has: page.getByRole('heading', { name: 'app', exact: true }) })
  await expect(template.getByText('Not used by a profile.')).toBeVisible()

  // A claim Tula sets itself can never be a template's.
  await template.getByLabel('New claim name').fill('sub')
  await template.getByRole('button', { name: 'Add claim' }).click()
  await expect(template.getByText(/reserved claim name/)).toBeVisible()
  await expectScreenAccessible(page, 'jwt templates, a reserved claim refused')

  await template.getByLabel('New claim name').fill('role')
  await template.getByRole('button', { name: 'Add claim' }).click()
  await template.getByLabel('Value of role').selectOption('text')
  await template.getByLabel('Text of role').fill('member')
  await template.getByLabel('New claim name').fill('email')
  await template.getByLabel('New claim name').press('Enter')
  await template.getByLabel('Value of email').selectOption('user.email')
  await expect(template.getByText(/^Up to [\d,]+ of 1,024 bytes\.$/)).toBeVisible()

  const web = page
    .getByRole('listitem')
    .filter({ has: page.getByRole('heading', { name: 'web', exact: false }) })
    .filter({ has: page.getByLabel('JWT template') })
  await web.getByLabel('JWT template').selectOption('app')
  await expect(template.getByText('Used by: web.')).toBeVisible()
  await expectScreenAccessible(page, 'jwt templates, a template in use')

  // Adding claims weakens nothing: saved without a question.
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Settings saved')).toBeVisible()
  const saved = await page.request.get(`${API_URL}/v1/admin/settings`, {
    headers: { authorization: `Bearer ${SECRET_KEY}` },
  })
  const { settings } = (await saved.json()) as {
    settings: {
      sessions: { jwtTemplates: unknown; profiles: { web: { jwtTemplate: string | null } } }
    }
  }
  expect(settings.sessions.jwtTemplates).toEqual({
    app: { claims: { role: { value: 'member' }, email: { from: 'user.email' } } },
  })
  expect(settings.sessions.profiles.web.jwtTemplate).toBe('app')

  // A template a profile uses stays until the profile lets go of it.
  await template.getByRole('button', { name: 'Take out the app template' }).click()
  await expect(template.getByRole('alert')).toContainText('The web profile uses this template.')
  await expect(page.getByRole('status').filter({ hasText: 'No unsaved changes.' })).toBeVisible()

  // Taking claims away from a profile's sessions is asked about, in words.
  await web.getByLabel('JWT template').selectOption('')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(dialog(page)).toContainText('Sessions of the “web” profile lose custom claims')
  await expectScreenAccessible(page, 'jwt templates, losing claims confirmation')
  await dialog(page).getByRole('button', { name: 'Save anyway' }).click()
  // The first save's toast may still be showing (a toast stays five seconds), so the text
  // alone says nothing about this save: the server's settings do.
  await expect(page.getByText('Settings saved').last()).toBeVisible()
  await expect
    .poll(async () => {
      const after = await page.request.get(`${API_URL}/v1/admin/settings`, {
        headers: { authorization: `Bearer ${SECRET_KEY}` },
      })
      const body = (await after.json()) as {
        settings: { sessions: { profiles: { web: { jwtTemplate: string | null } } } }
      }
      return body.settings.sessions.profiles.web.jwtTemplate
    })
    .toBeNull()
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
