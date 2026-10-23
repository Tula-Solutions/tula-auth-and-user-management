import { expect, type Page, test } from '@playwright/test'
import { expectAccessible, resetLimits, signUp, uniqueEmail, useSettings } from '../support'

// The organization components of @tula-tech/nextjs (ADR 0065, Orgs 07) in the Next.js example:
// the switcher at /team, the form at /team/new and the profile at /team/profile. A switch
// changes the cookies the server components read.

test.beforeEach(async ({ request }) => {
  await resetLimits(request)
  await useSettings(request, { organizations: { enabled: true, allowUserCreated: true } })
})

test.afterEach(async ({ request }) => {
  await useSettings(request)
})

async function accessibleInBothSchemes(page: Page, state: string): Promise<void> {
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await expectAccessible(page, `Next.js: ${state} (${colorScheme})`)
  }
  await page.emulateMedia({ colorScheme: 'light' })
}

test('create an organization, see it active on the server, manage it', async ({
  page,
  request,
}) => {
  await signUp(page, request, { email: uniqueEmail('next-org-components'), firstName: 'Maya' })
  await page.goto('/team')
  await page.getByRole('button', { name: 'Organization: Personal account' }).click()
  await page.getByRole('button', { name: 'Create organization' }).click()
  await expect(page).toHaveURL(/\/team\/new$/)
  const name = `Acme ${Date.now().toString(36)}`
  await page.getByLabel('Name', { exact: true }).fill(name)
  await accessibleInBothSchemes(page, 'create organization')
  await page.getByRole('button', { name: 'Create organization' }).click()
  await expect(page).toHaveURL(/\/team$/)
  await expect(page.getByRole('button', { name: `Organization: ${name}` })).toBeVisible()

  // The server component sees the organization the form made active.
  await page.goto('/dashboard')
  await expect(page.getByTestId('server-org-role')).toHaveText('admin')

  await page.goto('/team')
  await page.getByRole('button', { name: `Organization: ${name}` }).click()
  await accessibleInBothSchemes(page, 'organization switcher, open')
  await page.getByRole('button', { name: 'Manage organization' }).click()
  await expect(page).toHaveURL(/\/team\/profile$/)

  const tabs = page.getByRole('tablist', { name: 'Organization settings' })
  await expect(tabs.getByRole('tab')).toHaveText(['General', 'Members', 'Invitations', 'Domains'])
  await accessibleInBothSchemes(page, 'organization profile: general')
  await page.getByLabel('Name', { exact: true }).fill(`${name} Inc`)
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Your changes were saved.')).toBeVisible()

  for (const tab of ['Members', 'Invitations', 'Domains']) {
    await tabs.getByRole('tab', { name: tab }).click()
    await expect(page.getByRole('heading', { name: tab })).toBeVisible()
    await accessibleInBothSchemes(page, `organization profile: ${tab.toLowerCase()}`)
  }

  const invited = uniqueEmail('next-org-invited')
  await tabs.getByRole('tab', { name: 'Invitations' }).click()
  await page.getByLabel('Email address').fill(invited)
  await page.getByRole('button', { name: 'Send invitation' }).click()
  await expect(page.getByText(`Invitation sent to ${invited}.`)).toBeVisible()
})

test('a visitor with no session is sent to sign in', async ({ page }) => {
  await page.goto('/team/profile')
  await expect(page).toHaveURL(/\/sign-in\?redirect_url=%2Fteam%2Fprofile$/)
})
