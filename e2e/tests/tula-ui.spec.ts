import { expect, type Page, test } from '@playwright/test'
import { expectAccessible, resetLimits, signUp, uniqueEmail, useSettings } from './support'

// Tula UI's organization items (`organization-switcher` and `organization-profile`, ADR 0064 and
// ADR 0065), drawn by a real browser. Until now they were covered by Testing Library in
// happy-dom, which has no layout and no styles, so no contrast and no focus ring was ever
// checked. The harness (`packages/ui/browser`) draws the items from the registry's sources with
// shadcn's real primitives and the registry's own `theme` item, and the fixture serves it at
// `/__ui/` beside the example app, against the same API. The user is signed up through the
// example; the cookie the sign-up leaves for the API is what signs the harness in.

const ORGANIZATIONS = { organizations: { enabled: true, allowUserCreated: true } }
const HARNESS = '/__ui/'

test.beforeEach(async ({ request }) => {
  await resetLimits(request)
  await useSettings(request, ORGANIZATIONS)
})

test.afterEach(async ({ request }) => {
  await useSettings(request)
})

/** Run axe on the page in both colour schemes, leaving it in the light one. */
async function accessibleInBothSchemes(page: Page, state: string): Promise<void> {
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await expectAccessible(page, `${state} (${colorScheme})`)
  }
  await page.emulateMedia({ colorScheme: 'light' })
}

test('the switcher and the profile items are accessible in both colour schemes', async ({
  page,
  request,
}) => {
  await signUp(page, request, { email: uniqueEmail('tula-ui'), firstName: 'Maya' })
  await page.goto(HARNESS)

  // Signed in, in no organization: the switcher offers the personal account and the way to
  // create one, and the profile says no organization is active.
  const switcher = page.getByRole('region', { name: 'Organization switcher' })
  const profile = page.getByRole('region', { name: 'Organization profile' })
  await expect(switcher.getByLabel('Organization')).toBeVisible()
  await expect(profile.getByText('No organization is active.')).toBeVisible()
  await accessibleInBothSchemes(page, 'Tula UI: personal account')

  // The create form.
  await switcher.getByRole('button', { name: 'New organization' }).click()
  await expect(switcher.getByLabel('Name', { exact: true })).toBeVisible()
  await accessibleInBothSchemes(page, 'Tula UI: create form')

  // An empty submission: the messages under the fields.
  await switcher.getByRole('button', { name: 'Create organization' }).click()
  await expect(switcher.getByLabel('Name', { exact: true })).toHaveAttribute('aria-invalid', 'true')
  await expect(switcher.getByLabel('Name', { exact: true })).toBeFocused()
  await accessibleInBothSchemes(page, 'Tula UI: create form, empty fields')

  // Created and made active: the switcher says so and the profile shows the organization.
  const name = `Acme ${Date.now().toString(36)}`
  const slug = `acme-${Date.now().toString(36)}`
  await switcher.getByLabel('Name', { exact: true }).fill(name)
  await switcher.getByLabel('Short name').fill(slug)
  await switcher.getByRole('button', { name: 'Create organization' }).click()
  await expect(
    switcher.getByText(`${name} was created and is now the active organization.`)
  ).toBeVisible()
  await expect(profile.getByRole('heading', { name })).toBeVisible()
  await expect(profile.getByText('You can manage members.')).toBeVisible()
  await accessibleInBothSchemes(page, 'Tula UI: organization active')

  // Back to the personal account through the select.
  await switcher.getByLabel('Organization').selectOption({ label: 'Personal account' })
  await expect(switcher.getByText('Now using your personal account.')).toBeVisible()
  await expect(profile.getByText('No organization is active.')).toBeVisible()
  await accessibleInBothSchemes(page, 'Tula UI: back to the personal account')
})

test('the page is accessible with organizations off', async ({ page, request }) => {
  await signUp(page, request, { email: uniqueEmail('tula-ui-off') })
  // Off before the page loads: the public configuration is cached by the browser.
  await useSettings(request)
  await page.goto(HARNESS)
  await expect(page.getByRole('heading', { name: 'Tula UI items' })).toBeVisible()
  await accessibleInBothSchemes(page, 'Tula UI: organizations off')
})
