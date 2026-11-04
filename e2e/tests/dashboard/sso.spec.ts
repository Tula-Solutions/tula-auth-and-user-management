import type { Page } from '@playwright/test'
import { API_URL, bindSsoDomain, restoreSettings } from '../support'
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

// The SSO section of an organization's page (TULA-146), against the real API under its real
// Content-Security-Policy. `bindSsoDomain` makes an organization with an active OIDC
// connection on the API's own mock identity provider; the test puts the environment back.

const DASHBOARD = {
  'x-tula-dashboard': '1',
  'x-tula-environment': ENVIRONMENT_ID,
  origin: API_URL,
}
const DOMAIN = 'dashboard-sso.example.test'

interface Row {
  id: string
  slug?: string
}

async function read<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(`${API_URL}${path}`, { headers: DASHBOARD })
  expect(response.ok(), path).toBe(true)
  return (await response.json()) as T
}

/** Every organization and the connections on it go, in the order the rules allow. */
async function clear(page: Page): Promise<void> {
  const organizations = await read<{ data: Row[] }>(page, '/v1/admin/organizations?size=100')
  for (const organization of organizations.data) {
    const listed = await read<{ connections: Row[] }>(
      page,
      `/v1/admin/sso-connections?organizationId=${organization.id}`
    )
    for (const connection of listed.connections) {
      // An active connection cannot be deleted (decision 13): disable it first.
      await page.request.patch(`${API_URL}/v1/admin/sso-connections/${connection.id}`, {
        headers: DASHBOARD,
        data: { status: 'disabled' },
      })
      await page.request.delete(`${API_URL}/v1/admin/sso-connections/${connection.id}`, {
        headers: DASHBOARD,
      })
    }
    await page.request.delete(`${API_URL}/v1/admin/organizations/${organization.id}`, {
      headers: DASHBOARD,
    })
  }
}

async function organizationId(page: Page): Promise<string> {
  const organizations = await read<{ data: Row[] }>(page, '/v1/admin/organizations?size=100')
  const found = organizations.data.find((entry) => entry.slug === 'sso-dashboard-sso')
  expect(found).toBeDefined()
  return (found as Row).id
}

test.beforeEach(async ({ page }) => {
  await signIn(page)
  await restoreSettings(page.request)
  await bindSsoDomain(page.request, DOMAIN)
})

test.afterEach(async ({ page }) => {
  try {
    await signIn(page)
    await clear(page)
  } finally {
    await restoreSettings(page.request)
  }
})

test('the connection is listed with its protocol, status and domain, and its secret is never shown', async ({
  page,
}) => {
  await open(page, `${ENVIRONMENT_PATH}/organizations/${await organizationId(page)}`, 'SSO Org')
  const card = page.getByRole('listitem', { name: 'Connection Mock IdP' })
  await expect(card).toBeVisible()
  await expect(card.getByText('OIDC')).toBeVisible()
  await expect(card.getByText('Active')).toBeVisible()
  await expect(card.getByText(DOMAIN)).toBeVisible()
  await expect(card.getByText('Saved, never shown again')).toBeVisible()
  expect(await page.content()).not.toContain('e2e-sso-secret')
  await expectScreenAccessible(page, 'organization with an SSO connection')
})

test('trusting the identity provider asks first, and the question is accessible', async ({
  page,
}) => {
  await open(page, `${ENVIRONMENT_PATH}/organizations/${await organizationId(page)}`, 'SSO Org')
  await page.getByRole('button', { name: 'Edit Mock IdP' }).click()
  const form = dialog(page)
  await expectScreenAccessible(page, 'connection form')
  await form
    .getByRole('switch', { name: 'Trust the identity provider for two-step verification' })
    .click()
  await form.getByRole('button', { name: 'Save changes' }).click()
  await expect(form.getByTestId('weakening')).toContainText('second step')
  await expectScreenAccessible(page, 'connection weakening question')
  await form.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  const listed = await read<{ connections: { trustIdpMfa: boolean }[] }>(
    page,
    `/v1/admin/sso-connections?organizationId=${await organizationId(page)}`
  )
  expect(listed.connections[0]?.trustIdpMfa).toBe(true)
})

test('disabling a connection asks, and the section then says it is disabled', async ({ page }) => {
  await open(page, `${ENVIRONMENT_PATH}/organizations/${await organizationId(page)}`, 'SSO Org')
  await page.getByRole('button', { name: 'Disable Mock IdP' }).click()
  await expectScreenAccessible(page, 'disable connection')
  await page.getByRole('dialog').getByRole('button', { name: 'Disable' }).click()
  await expect(
    page.getByRole('listitem', { name: 'Connection Mock IdP' }).getByText('Disabled')
  ).toBeVisible()
})

test('the settings screen has the single sign-on switch, on', async ({ page }) => {
  await open(page, `${ENVIRONMENT_PATH}/organization-settings`, 'Organization settings')
  await expect(page.getByRole('switch', { name: 'Single sign-on is on' })).toBeChecked()
  await expectScreenAccessible(page, 'organization settings with single sign-on')
})

test('a test sign-in from the dashboard passes through the setup page and unlocks Activate', async ({
  page,
  context,
}) => {
  // The mock provider signs in whoever the login hint names; a popup is a page of the context.
  await context.route('**/v1/dev/sso/authorize*', (route) => {
    const url = new URL(route.request().url())
    url.searchParams.set('login_hint', `tester@${DOMAIN}`)
    return route.continue({ url: url.toString() })
  })
  await open(page, `${ENVIRONMENT_PATH}/organizations/${await organizationId(page)}`, 'SSO Org')
  await page.getByRole('button', { name: 'Disable Mock IdP' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Disable' }).click()
  const card = page.getByRole('listitem', { name: 'Connection Mock IdP' })
  await expect(card.getByText('Disabled')).toBeVisible()
  const popup = page.waitForEvent('popup')
  await card.getByRole('button', { name: 'Run test sign-in for Mock IdP' }).click()
  await popup
  await expect(card.getByText(/The test passed/)).toBeVisible({ timeout: 20_000 })
  await expect(card.getByText(/on a verified domain/)).toBeVisible()
  await expect(card.getByRole('button', { name: 'Activate Mock IdP' })).toBeEnabled()
  await expectScreenAccessible(page, 'connection with a passed test sign-in')
})
