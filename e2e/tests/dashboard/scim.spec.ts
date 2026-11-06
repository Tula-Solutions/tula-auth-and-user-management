import type { Page } from '@playwright/test'
import { API_URL, restoreSettings, type TestSettings, useSettings } from '../support'
import {
  dialog,
  ENVIRONMENT_ID,
  ENVIRONMENT_PATH,
  expect,
  expectNoSecretKept,
  expectScreenAccessible,
  open,
  signIn,
  test,
} from './support'

// The SCIM section of an organization's page (TULA-154), against the real API under its real
// Content-Security-Policy: a token is created and shown once with the base URL, listed with
// its last use, and revoked after a question.

const DASHBOARD = {
  'x-tula-dashboard': '1',
  'x-tula-environment': ENVIRONMENT_ID,
  origin: API_URL,
}

// The organization routes answer `organization.disabled` while the environment has them off.
const ORGANIZATIONS_ON: TestSettings = { organizations: { enabled: true } }

interface Row {
  id: string
  slug?: string
}

async function read<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(`${API_URL}${path}`, { headers: DASHBOARD })
  expect(response.ok(), path).toBe(true)
  return (await response.json()) as T
}

/** Every organization goes; their tokens go with them. */
async function clear(page: Page): Promise<void> {
  const organizations = await read<{ data: Row[] }>(page, '/v1/admin/organizations?size=100')
  for (const organization of organizations.data) {
    await page.request.delete(`${API_URL}/v1/admin/organizations/${organization.id}`, {
      headers: DASHBOARD,
    })
  }
}

test.beforeEach(async ({ page }) => {
  await signIn(page)
  await useSettings(page.request, ORGANIZATIONS_ON)
  await clear(page)
  const created = await page.request.post(`${API_URL}/v1/admin/organizations`, {
    headers: DASHBOARD,
    data: { name: 'Scim Org', slug: 'scim-org' },
  })
  expect(created.ok(), await created.text()).toBe(true)
})

test.afterEach(async ({ page }) => {
  try {
    await signIn(page)
    await useSettings(page.request, ORGANIZATIONS_ON)
    await clear(page)
  } finally {
    await restoreSettings(page.request)
  }
})

async function organizationPath(page: Page): Promise<string> {
  const organizations = await read<{ data: Row[] }>(page, '/v1/admin/organizations?size=100')
  const found = organizations.data.find((entry) => entry.slug === 'scim-org')
  expect(found).toBeDefined()
  return `${ENVIRONMENT_PATH}/organizations/${(found as Row).id}`
}

test('a token is shown once with the base URL, listed, then revoked after a question', async ({
  page,
}) => {
  await open(page, await organizationPath(page), 'Scim Org')
  await expect(page.getByText('No SCIM tokens')).toBeVisible()
  await expectScreenAccessible(page, 'organization with no SCIM tokens')

  await page.getByRole('button', { name: 'Create token' }).click()
  await dialog(page).getByLabel('Name').fill('Okta provisioning')
  await expectScreenAccessible(page, 'create SCIM token')
  await dialog(page).getByRole('button', { name: 'Create token' }).click()

  const shown = dialog(page).getByTestId('created-scim-token')
  const token = (await shown.textContent()) ?? ''
  expect(token).toMatch(/^tula_scim_/)
  await expect(dialog(page).getByTestId('scim-base-url')).toHaveText(`${API_URL}/v1/scim/v2`)
  await expectScreenAccessible(page, 'SCIM token shown once')
  await dialog(page).getByRole('button', { name: 'I have copied it' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)

  const row = page.getByRole('row', { name: /Okta provisioning/ })
  await expect(row).toContainText('Never')
  await expect(row).toContainText('Active')
  await expectNoSecretKept(page, [token])
  await page.reload()
  await expect(page.getByRole('row', { name: /Okta provisioning/ })).toBeVisible()
  await expectNoSecretKept(page, [token])
  await expectScreenAccessible(page, 'SCIM token listed')

  await page.getByRole('button', { name: 'Revoke Okta provisioning' }).click()
  await expectScreenAccessible(page, 'revoke SCIM token')
  await dialog(page).getByRole('button', { name: 'Revoke token' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('row', { name: /Okta provisioning/ })).toContainText('Revoked')
  await expect(page.getByRole('button', { name: 'Revoke Okta provisioning' })).toHaveCount(0)
  await expectScreenAccessible(page, 'SCIM token revoked')
})
