import { expect, type Page, test } from '@playwright/test'
import {
  expectAccessible,
  latestCode,
  resetLimits,
  signUp,
  uniqueEmail,
  useSettings,
} from './support'

// The organization components of @tula-tech/react (ADR 0065, Orgs 07): the switcher, the form
// that makes an organization and the profile with its four tabs, driven in the Vite example
// against the real API.

const ORGANIZATIONS = { organizations: { enabled: true, allowUserCreated: true } }

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

let counter = 0
function unique(tag: string): string {
  counter += 1
  return `${tag}${Date.now().toString(36)}${counter}`
}

/** Sign up and make an organization through `<CreateOrganization>`; returns its name. */
async function createOrganization(
  page: Page,
  request: Parameters<typeof signUp>[1],
  tag: string
): Promise<string> {
  await signUp(page, request, { email: uniqueEmail(tag), firstName: 'Maya' })
  await page.goto('/organizations')
  await page.getByRole('button', { name: 'Organization: Personal account' }).click()
  await page.getByRole('button', { name: 'Create organization' }).click()
  await expect(page).toHaveURL(/\/organization\/new$/)
  const name = unique('Acme ')
  await page.getByLabel('Name', { exact: true }).fill(name)
  await accessibleInBothSchemes(page, 'Create organization')
  await page.getByRole('button', { name: 'Create organization' }).click()
  await expect(page).toHaveURL(/\/organizations$/)
  await expect(page.getByRole('button', { name: `Organization: ${name}` })).toBeVisible()
  return name
}

test('a user makes an organization, switches and sees it in the switcher', async ({
  page,
  request,
}) => {
  const name = await createOrganization(page, request, 'org-create')
  await page.getByRole('button', { name: `Organization: ${name}` }).click()
  const panel = page.getByRole('group', { name: 'Organizations' })
  await expect(panel).toBeVisible()
  await expect(panel.getByRole('button', { name: /^Personal account/ })).toBeVisible()
  await accessibleInBothSchemes(page, 'Organization switcher, open')

  await panel.getByRole('button', { name: /^Personal account/ }).click()
  await expect(page.getByRole('button', { name: 'Organization: Personal account' })).toBeVisible()
  await page.getByRole('button', { name: 'Organization: Personal account' }).click()
  await page.getByRole('button', { name: name }).click()
  await expect(page.getByRole('button', { name: `Organization: ${name}` })).toBeVisible()
})

test('the profile: rename, members, invitations, domains, leave and delete', async ({
  page,
  request,
}) => {
  const name = await createOrganization(page, request, 'org-profile')
  await page.getByRole('button', { name: `Organization: ${name}` }).click()
  await page.getByRole('button', { name: 'Manage organization' }).click()
  await expect(page).toHaveURL(/\/organization$/)

  // An admin sees every tab.
  const tabs = page.getByRole('tablist', { name: 'Organization settings' })
  await expect(tabs.getByRole('tab')).toHaveText(['General', 'Members', 'Invitations', 'Domains'])
  await accessibleInBothSchemes(page, 'Organization profile: general')

  const renamed = `${name} Inc`
  await page.getByLabel('Name', { exact: true }).fill(renamed)
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Your changes were saved.')).toBeVisible()
  await expect(page.getByText(renamed, { exact: true }).first()).toBeVisible()

  // Members: the user alone, as an admin, without a "Remove" for themselves.
  await tabs.getByRole('tab', { name: 'Members' }).click()
  await expect(page.getByText('You', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Remove/ })).toHaveCount(0)
  await accessibleInBothSchemes(page, 'Organization profile: members')

  // Invitations: send one, see it, revoke it.
  await tabs.getByRole('tab', { name: 'Invitations' }).click()
  const invited = uniqueEmail('org-invited')
  await page.getByLabel('Email address').fill(invited)
  await page.getByRole('button', { name: 'Send invitation' }).click()
  await expect(page.getByText(`Invitation sent to ${invited}.`)).toBeVisible()
  await expect(page.getByText(invited, { exact: true })).toBeVisible()
  await accessibleInBothSchemes(page, 'Organization profile: invitations')
  await page.getByRole('button', { name: `Revoke the invitation for ${invited}` }).click()
  await accessibleInBothSchemes(page, 'Organization profile: revoke question')
  await page.getByRole('button', { name: 'Yes, revoke' }).click()
  await expect(page.getByText(`The invitation for ${invited} was revoked.`)).toBeVisible()
  await expect(page.getByText('No invitations are waiting.')).toBeVisible()

  // Domains: claim one, verify it with the emailed code.
  await tabs.getByRole('tab', { name: 'Domains' }).click()
  const domain = `${unique('claim').toLowerCase()}.example`
  const address = `owner@${domain}`
  await page.getByLabel('Domain', { exact: true }).fill(domain)
  await page.getByLabel('An address on that domain').fill(address)
  await page.getByRole('button', { name: 'Send a code' }).click()
  await expect(page.getByText(`We emailed a code to ${address}.`)).toBeVisible()
  await accessibleInBothSchemes(page, 'Organization profile: domain waiting for its code')
  await page.getByLabel(`Code for ${domain}`).fill(await latestCode(request, address))
  await page.getByRole('button', { name: 'Verify' }).click()
  await expect(page.getByText(`${domain} is verified.`)).toBeVisible()
  await accessibleInBothSchemes(page, 'Organization profile: verified domain')

  // The only member who can manage members cannot leave.
  await tabs.getByRole('tab', { name: 'General' }).click()
  await page.getByRole('button', { name: 'Leave organization' }).click()
  await page.getByRole('button', { name: 'Yes, leave' }).click()
  await expect(
    page.getByText('An organization must keep at least one member who can manage its members.')
  ).toBeVisible()
  await accessibleInBothSchemes(page, 'Organization profile: last manager cannot leave')
  await page.getByRole('button', { name: 'Cancel' }).click()

  // Delete: the name has to be typed.
  await page.getByRole('button', { name: 'Delete organization' }).click()
  const confirm = page.getByRole('button', { name: 'Delete this organization' })
  await expect(confirm).toHaveAttribute('aria-disabled', 'true')
  await page.getByLabel('Name', { exact: true }).last().fill(renamed)
  await confirm.click()
  // The example sends the user on (afterDeleteUrl), so the page the notice was on is gone.
  await expect(page).toHaveURL(/\/organizations$/)
  await page.getByRole('button', { name: /^Organization: / }).click()
  await expect(page.getByRole('button', { name: renamed })).toHaveCount(0)
})

test('a visitor without a session is sent to sign in, and a user is told when organizations are off', async ({
  page,
  request,
}) => {
  // Organizations go off first: the public configuration is cached by the browser, so a page
  // opened while they were on would keep drawing them.
  await useSettings(request)
  await page.goto('/organization')
  await expect(page).toHaveURL(/\/sign-in$/)

  await signUp(page, request, { email: uniqueEmail('org-off') })
  await page.goto('/organization/new')
  await expect(page.getByText('Creating organizations is not available here.')).toBeVisible()
  await accessibleInBothSchemes(page, 'Create organization, organizations off')
})
