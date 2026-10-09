import type { Page } from '@playwright/test'
import { API_URL } from '../support'
import {
  dialog,
  ENVIRONMENT_ID,
  ENVIRONMENT_PATH,
  expect,
  expectScreenAccessible,
  open,
  signIn,
  test,
} from './support'

// Native apps: an iOS and an Android app from registration to removal, against the real API,
// and the two association files as the API really serves them. Whether Apple and Android
// accept those files cannot be shown here: they fetch them from the root of an app's own
// domain.

const DASHBOARD = {
  'x-tula-dashboard': '1',
  'x-tula-environment': ENVIRONMENT_ID,
  origin: API_URL,
}
const WELL_KNOWN = `${API_URL}/v1/environments/${ENVIRONMENT_ID}/.well-known`
const fingerprint = (byte: string) => Array.from({ length: 32 }, () => byte).join(':')
const FIRST = fingerprint('1A')
const SECOND = fingerprint('2B')
const BUNDLE = 'app.northline.e2e-ios'
const PACKAGE = 'app.northline.e2e_android'

function card(page: Page, platform: string) {
  return page.locator(`[data-testid="native-app"][data-platform="${platform}"]`)
}

/** The environment's native apps, read as the dashboard reads them. */
async function apps(page: Page): Promise<{ id: string; platform: string }[]> {
  const response = await page.request.get(`${API_URL}/v1/admin/native-apps`, {
    headers: DASHBOARD,
  })
  expect(response.ok()).toBe(true)
  return ((await response.json()) as { data: { id: string; platform: string }[] }).data
}

/** A served file, fetched as a platform would: no key, no cookie's worth of difference. */
async function served(page: Page, name: string): Promise<unknown> {
  const response = await page.request.get(`${WELL_KNOWN}/${name}`, { maxRedirects: 0 })
  expect(response.status()).toBe(200)
  expect(response.headers()['content-type']).toMatch(/^application\/json\b/)
  return response.json()
}

test.beforeEach(async ({ page }) => {
  await signIn(page)
})

// The fixture's environment is every later spec's too: nothing is left behind by a test that
// failed half-way.
test.afterEach(async ({ page }) => {
  for (const app of await apps(page)) {
    await page.request.delete(`${API_URL}/v1/admin/native-apps/${app.id}`, { headers: DASHBOARD })
  }
  expect(await apps(page)).toEqual([])
})

test('native apps: registered after a question, named in the served files, changed and removed', async ({
  page,
}) => {
  await open(page, `${ENVIRONMENT_PATH}/native-apps`, 'Native apps')
  await expect(page.getByText('No native apps yet')).toBeVisible()
  // The two addresses are shown as text to copy, for this environment.
  await expect(page.getByTestId('association-file')).toHaveCount(2)
  await expect(page.getByTestId('association-file').first()).toContainText(
    `${WELL_KNOWN}/apple-app-site-association`
  )
  await expect(page.getByTestId('association-file').last()).toContainText(
    `${WELL_KNOWN}/assetlinks.json`
  )
  await expectScreenAccessible(page, 'native apps, none registered')
  expect(await served(page, 'apple-app-site-association')).toEqual({})
  expect(await served(page, 'assetlinks.json')).toEqual([])

  // Refusals of the form itself, in words, on their fields.
  await page.getByRole('button', { name: 'Register app' }).click()
  await dialog(page).getByLabel('Team ID').fill('a1b2c3d4e5')
  await dialog(page).getByLabel('Bundle ID').fill('northline')
  await dialog(page).getByRole('button', { name: 'Continue' }).click()
  await expect(dialog(page).getByRole('alert')).toHaveCount(2)
  await expectScreenAccessible(page, 'register an app, with errors')

  // Registering is asked about before anything is sent.
  await dialog(page).getByLabel('Team ID').fill('A1B2C3D4E5')
  await dialog(page).getByLabel('Bundle ID').fill(BUNDLE)
  await dialog(page).getByRole('button', { name: 'Continue' }).click()
  await expect(dialog(page).getByRole('heading')).toHaveText('Register this app?')
  await expect(dialog(page).getByTestId('weakening')).toContainText(
    'The file Apple fetches for this environment will name this app.'
  )
  expect(await apps(page)).toEqual([])
  await expectScreenAccessible(page, 'the question before an app is registered')
  await dialog(page).getByRole('button', { name: 'Register app' }).click()
  await expect(card(page, 'ios')).toContainText(`A1B2C3D4E5.${BUNDLE}`)
  expect(await served(page, 'apple-app-site-association')).toEqual({
    webcredentials: { apps: [`A1B2C3D4E5.${BUNDLE}`] },
  })

  // An Android app, its fingerprint pasted as `apksigner` prints it.
  await page.getByRole('button', { name: 'Register app' }).click()
  await dialog(page).getByLabel('Platform').selectOption('android')
  await dialog(page).getByLabel('Package name').fill(PACKAGE)
  await dialog(page)
    .getByLabel('Certificate fingerprints (SHA-256)')
    .fill(FIRST.replaceAll(':', '').toLowerCase())
  await dialog(page).getByRole('button', { name: 'Continue' }).click()
  await dialog(page).getByRole('button', { name: 'Register app' }).click()
  await expect(card(page, 'android')).toContainText(FIRST)
  await expect(page.getByText('2 of 20 apps')).toBeVisible()
  await expectScreenAccessible(page, 'native apps, two registered')
  expect(await served(page, 'assetlinks.json')).toEqual([
    {
      relation: ['delegate_permission/common.get_login_creds'],
      target: {
        namespace: 'android_app',
        package_name: PACKAGE,
        sha256_cert_fingerprints: [FIRST],
      },
    },
  ])

  // A gained fingerprint is asked about; the file follows.
  await page.getByRole('button', { name: `Edit ${PACKAGE}` }).click()
  await dialog(page).getByLabel('Certificate fingerprints (SHA-256)').fill(`${FIRST}\n${SECOND}`)
  await dialog(page).getByRole('button', { name: 'Save changes' }).click()
  await expect(dialog(page).getByRole('heading')).toHaveText('Add a certificate?')
  await expectScreenAccessible(page, 'the question before a certificate is added')
  await dialog(page).getByRole('button', { name: 'Save changes' }).click()
  await expect(card(page, 'android')).toContainText(SECOND)
  expect(await served(page, 'assetlinks.json')).toMatchObject([
    { target: { sha256_cert_fingerprints: [FIRST, SECOND] } },
  ])

  // Removal names the app, and the file stops naming it.
  await page.getByRole('button', { name: `Remove ${BUNDLE}` }).click()
  await expect(dialog(page).getByRole('heading')).toHaveText(`Remove the iOS app ${BUNDLE}?`)
  await expectScreenAccessible(page, 'the confirmation before an app is removed')
  await dialog(page).getByRole('button', { name: 'Remove app' }).click()
  await expect(card(page, 'ios')).toHaveCount(0)
  await expect(page.getByRole('heading', { level: 1, name: 'Native apps' })).toBeFocused()
  expect(await served(page, 'apple-app-site-association')).toEqual({})
})
