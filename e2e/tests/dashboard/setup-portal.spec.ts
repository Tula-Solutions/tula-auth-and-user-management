import type { Page } from '@playwright/test'
import { API_URL, bindSsoDomain, restoreSettings } from '../support'
import {
  ENVIRONMENT_ID,
  ENVIRONMENT_PATH,
  expect,
  expectNoSecretKept,
  expectScreenAccessible,
  signIn,
  test,
} from './support'

// The self-serve SSO setup portal (TULA-149): an operator makes a setup link, and someone with
// no account sets up, tests and activates an OIDC connection on the API's own mock identity
// provider through it, under the real Content-Security-Policy.

const DASHBOARD = {
  'x-tula-dashboard': '1',
  'x-tula-environment': ENVIRONMENT_ID,
  origin: API_URL,
}
const DOMAIN = 'setup-portal.example.test'

interface Row {
  id: string
  slug?: string
}

async function read<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(`${API_URL}${path}`, { headers: DASHBOARD })
  expect(response.ok(), path).toBe(true)
  return (await response.json()) as T
}

/** Every organization, its connections and its setup links go. */
async function clear(page: Page): Promise<void> {
  const organizations = await read<{ data: Row[] }>(page, '/v1/admin/organizations?size=100')
  for (const organization of organizations.data) {
    const links = await read<{ links: Row[] }>(
      page,
      `/v1/admin/setup-links?organizationId=${organization.id}`
    )
    for (const link of links.links) {
      await page.request.delete(
        `${API_URL}/v1/admin/setup-links/${link.id}?organizationId=${organization.id}`,
        { headers: DASHBOARD }
      )
    }
    const listed = await read<{ connections: Row[] }>(
      page,
      `/v1/admin/sso-connections?organizationId=${organization.id}`
    )
    for (const connection of listed.connections) {
      await page.request.delete(`${API_URL}/v1/admin/sso-connections/${connection.id}`, {
        headers: DASHBOARD,
      })
    }
    await page.request.delete(`${API_URL}/v1/admin/organizations/${organization.id}`, {
      headers: DASHBOARD,
    })
  }
}

let issuer = ''

test.beforeEach(async ({ page }) => {
  await signIn(page)
  await restoreSettings(page.request)
  issuer = await bindSsoDomain(page.request, DOMAIN)
})

test.afterEach(async ({ page }) => {
  try {
    await signIn(page)
    await clear(page)
  } finally {
    await restoreSettings(page.request)
  }
})

test('a setup link carries someone with no account through a full OIDC setup', async ({
  page,
  context,
}) => {
  // The fixture's organization has a verified domain and an active connection: take the
  // connection away so that the portal starts from nothing.
  const organizations = await read<{ data: Row[] }>(page, '/v1/admin/organizations?size=100')
  const organization = organizations.data.find((entry) => entry.slug === 'sso-setup-portal')
  expect(organization).toBeDefined()
  const organizationId = (organization as Row).id
  const existing = await read<{ connections: Row[] }>(
    page,
    `/v1/admin/sso-connections?organizationId=${organizationId}`
  )
  for (const connection of existing.connections) {
    await page.request.delete(`${API_URL}/v1/admin/sso-connections/${connection.id}`, {
      headers: DASHBOARD,
    })
  }

  // The operator makes the link in the dashboard; the address is shown once.
  await page.goto(`${ENVIRONMENT_PATH}/organizations/${organizationId}`)
  await page.getByRole('button', { name: 'Create setup link' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Create link' }).click()
  const address = (await page.getByTestId('created-setup-link').textContent()) ?? ''
  expect(address).toContain('/dashboard/setup#token=tula_setup_')
  await page.getByRole('button', { name: 'I have copied it' }).click()
  await expect(page.getByRole('listitem', { name: 'Setup link SSO setup' })).toBeVisible()

  // Someone with no session opens it. The mock provider needs a login hint, as in sso.spec.
  await context.clearCookies()
  await context.route('**/v1/dev/sso/authorize*', (route) => {
    const url = new URL(route.request().url())
    url.searchParams.set('login_hint', `tester@${DOMAIN}`)
    return route.continue({ url: url.toString() })
  })
  const token = address.split('#token=')[1] ?? ''
  await page.goto(address)
  await expect(page.getByText(/Set up single sign-on for SSO Org/)).toBeVisible()
  // The fragment is taken out of the address at once, and nothing keeps the token.
  expect(page.url()).not.toContain(token)
  await expectNoSecretKept(page, [token])
  await expectScreenAccessible(page, 'setup portal, empty')

  await page.getByLabel('Connection name').fill('Mock IdP')
  await page.getByLabel('Issuer address').fill(issuer)
  await page.getByLabel('Client ID').fill('e2e-sso')
  await page.getByLabel('Client secret').fill('e2e-sso-secret')
  await page.getByLabel(DOMAIN).check()
  await page.getByRole('button', { name: 'Create connection' }).click()
  await expect(page.getByText(/\/v1\/sso\/callback\//)).toBeVisible()
  expect(await page.content()).not.toContain('e2e-sso-secret')
  await expectScreenAccessible(page, 'setup portal, connection saved')

  const activate = page.getByRole('button', { name: 'Activate the connection' })
  await expect(activate).toBeDisabled()
  const popup = page.waitForEvent('popup')
  await page.getByRole('button', { name: 'Run a test sign-in' }).click()
  await popup
  await expect(page.getByText('The test passed.')).toBeVisible({ timeout: 20_000 })
  await expect(activate).toBeEnabled()
  await activate.click()
  await expect(page.getByText(/This connection is active/)).toBeVisible()
  await expectScreenAccessible(page, 'setup portal, activated')
  await expectNoSecretKept(page, [token, 'e2e-sso-secret'])

  // The audit log names the setup link as the actor of what the portal changed.
  await signIn(page)
  const listed = await read<{ connections: { status: string }[] }>(
    page,
    `/v1/admin/sso-connections?organizationId=${organizationId}`
  )
  expect(listed.connections.map((connection) => connection.status)).toEqual(['active'])
})

test('a revoked link is shown as not valid', async ({ page, context }) => {
  const organizations = await read<{ data: Row[] }>(page, '/v1/admin/organizations?size=100')
  const organizationId = (
    organizations.data.find((entry) => entry.slug === 'sso-setup-portal') as Row
  ).id
  const created = await page.request.post(`${API_URL}/v1/admin/setup-links`, {
    headers: DASHBOARD,
    data: { organizationId, name: 'Revoked', expiresInDays: 7 },
  })
  expect(created.status()).toBe(201)
  const link = (await created.json()) as { id: string; url: string }
  const revoked = await page.request.delete(
    `${API_URL}/v1/admin/setup-links/${link.id}?organizationId=${organizationId}`,
    { headers: DASHBOARD }
  )
  expect(revoked.ok()).toBe(true)
  await context.clearCookies()
  await page.goto(link.url)
  await expect(page.getByText('This setup link is not valid')).toBeVisible()
  await expectScreenAccessible(page, 'setup portal, invalid link')
})
