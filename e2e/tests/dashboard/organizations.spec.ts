import type { Page } from '@playwright/test'
import { API_URL, latestCode, uniqueEmail, useSettings } from '../support'
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

// Organizations, roles and their settings in the dashboard (TULA-120), against the real API
// under its real Content-Security-Policy. The fixture's environment has organizations off
// until a test switches them on; every test puts the defaults back and leaves no
// organization, role or user behind, because the environment is every later spec's too.

const DASHBOARD = {
  'x-tula-dashboard': '1',
  'x-tula-environment': ENVIRONMENT_ID,
  origin: API_URL,
}
const REDIRECT = 'https://app.example.com/join'
const ON = { organizations: { enabled: true }, urls: { allowedRedirectUrls: [REDIRECT] } }

interface Row {
  id: string
}

async function read<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(`${API_URL}${path}`, { headers: DASHBOARD })
  expect(response.ok(), path).toBe(true)
  return (await response.json()) as T
}

async function send(
  page: Page,
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string,
  data?: unknown,
  headers: Record<string, string> = {}
) {
  const response = await page.request.fetch(`${API_URL}${path}`, {
    method,
    headers: { ...DASHBOARD, ...headers },
    data,
  })
  expect(response.ok(), `${method} ${path}`).toBe(true)
  return response.status() === 204 ? null : await response.json()
}

/** A user with this address, made as an administrator can; returns the user's id. */
async function makeUser(page: Page, email: string): Promise<string> {
  const response = await page.request.post(`${API_URL}/__test/unverified-user`, { data: { email } })
  expect(response.ok()).toBe(true)
  const found = await read<{ data: Row[] }>(page, `/v1/admin/users?q=${encodeURIComponent(email)}`)
  expect(found.data).toHaveLength(1)
  return (found.data[0] as Row).id
}

/** An organization made through the API, with this user as its first manager. */
async function makeOrganization(
  page: Page,
  name: string,
  slug: string,
  manager?: string
): Promise<string> {
  const made = (await send(page, 'POST', '/v1/admin/organizations', { name, slug })) as Row
  if (manager) {
    await send(page, 'POST', `/v1/admin/organizations/${made.id}/memberships`, {
      userId: manager,
      role: 'admin',
    })
  }
  return made.id
}

const created: string[] = []

test.beforeEach(async ({ page }) => {
  await useSettings(page.request, ON)
  await signIn(page)
})

// Whatever a test (or its failure half-way) left, in the order the rules allow.
test.afterEach(async ({ page }) => {
  const organizations = await read<{ data: Row[] }>(page, '/v1/admin/organizations?size=100')
  for (const organization of organizations.data) {
    await send(page, 'DELETE', `/v1/admin/organizations/${organization.id}`)
  }
  const roles = await read<{ data: { key: string; builtIn: boolean; version: number }[] }>(
    page,
    '/v1/admin/organization-roles'
  )
  for (const role of roles.data.filter((entry) => !entry.builtIn)) {
    await send(page, 'DELETE', `/v1/admin/organization-roles/${role.key}`, undefined, {
      'if-match': `"${role.version}"`,
    })
  }
  for (const id of created.splice(0)) {
    await send(page, 'DELETE', `/v1/admin/users/${id}`)
  }
  await useSettings(page.request)
})

test('organizations switched off are said, with the way to switch them on', async ({ page }) => {
  await useSettings(page.request)
  await open(page, `${ENVIRONMENT_PATH}/organizations`, 'Organizations')
  await expect(page.getByText('Organizations are switched off in this environment')).toBeVisible()
  await expectScreenAccessible(page, 'organizations, switched off')
  await page.getByRole('main').getByRole('link', { name: 'Organization settings' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Organization settings' })).toBeVisible()
  // Switching them on is not a weakening, so it saves without a question.
  await page.getByRole('switch', { name: 'Organizations are on' }).click()
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Settings saved')).toBeVisible()
  await page.getByRole('link', { name: 'Organizations', exact: true }).click()
  await expect(page.getByText('No organizations yet')).toBeVisible()
})

test('an organization from creation to deletion: members, a last manager, invitations', async ({
  page,
}) => {
  const ada = uniqueEmail('org-ada')
  const grace = uniqueEmail('org-grace')
  created.push(await makeUser(page, ada), await makeUser(page, grace))

  await open(page, `${ENVIRONMENT_PATH}/organizations`, 'Organizations')
  await expect(page.getByText('No organizations yet')).toBeVisible()
  await expectScreenAccessible(page, 'organizations, none yet')

  // The slug follows the name until it is typed over; a taken or malformed one is said.
  await page.getByRole('button', { name: 'Create organization' }).first().click()
  await dialog(page).getByLabel('Name').fill('Northline Labs')
  await expect(dialog(page).getByLabel('Slug')).toHaveValue('northline-labs')
  await dialog(page).getByLabel('Slug').fill('Not A Slug')
  await dialog(page).getByRole('button', { name: 'Create organization' }).click()
  await expect(dialog(page).getByRole('alert')).toHaveCount(1)
  await expectScreenAccessible(page, 'create an organization, with an error')
  await dialog(page).getByLabel('Slug').fill('northline-labs')
  await dialog(page).getByRole('button', { name: 'Create organization' }).click()
  await expect(dialog(page).getByRole('heading')).toHaveText('Organization created')
  await dialog(page).getByRole('link', { name: 'Open organization' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Northline Labs' })).toBeVisible()

  // The first member: found by a search, with a role.
  await page.getByRole('button', { name: 'Add member' }).click()
  await dialog(page).getByLabel('Find a user').fill(ada)
  await dialog(page).getByRole('button', { name: 'Search' }).click()
  await dialog(page).getByLabel('User', { exact: true }).selectOption({ label: ada })
  await dialog(page).getByLabel('Role').selectOption('admin')
  await expectScreenAccessible(page, 'add a member')
  await dialog(page).getByRole('button', { name: 'Add member' }).click()
  const members = page.getByRole('table', { name: 'Members of Northline Labs' })
  await expect(members).toContainText(ada)

  // The only manager cannot be demoted or removed: the refusal is said in the dialog.
  await page.getByRole('button', { name: `Change the role of ${ada}` }).click()
  await dialog(page).getByLabel('Role').selectOption('member')
  await dialog(page).getByRole('button', { name: 'Change role' }).click()
  await expect(dialog(page).getByRole('alert')).toContainText(
    'must keep at least one member who can manage'
  )
  await expectScreenAccessible(page, 'the only manager cannot be demoted')
  await dialog(page).getByRole('button', { name: 'Cancel' }).click()

  // A second member, and a role change that sticks.
  await page.getByRole('button', { name: 'Add member' }).click()
  await dialog(page).getByLabel('Find a user').fill(grace)
  await dialog(page).getByRole('button', { name: 'Search' }).click()
  await dialog(page).getByLabel('User', { exact: true }).selectOption({ label: grace })
  await dialog(page).getByRole('button', { name: 'Add member' }).click()
  await expect(members).toContainText(grace)
  await page.getByRole('button', { name: `Change the role of ${grace}` }).click()
  await dialog(page).getByLabel('Role').selectOption('admin')
  await dialog(page).getByRole('button', { name: 'Change role' }).click()
  await expect(page.getByText('Role changed')).toBeVisible()

  // Removal names the member and the organization, and keeps the account.
  await page.getByRole('button', { name: `Remove ${grace}` }).click()
  await expect(dialog(page).getByRole('heading')).toHaveText(`Remove ${grace} from Northline Labs?`)
  await expectScreenAccessible(page, 'the confirmation before a member is removed')
  await dialog(page).getByRole('button', { name: 'Remove member' }).click()
  await expect(members).not.toContainText(grace)

  // An invitation goes to an allowed redirect URL, and is withdrawn by name.
  await page.getByRole('button', { name: 'Invite by email' }).click()
  await dialog(page).getByLabel('Email address').fill('new.hire@example.com')
  await expect(dialog(page).getByLabel('The link leads to')).toHaveValue(REDIRECT)
  await expectScreenAccessible(page, 'invite by email')
  await dialog(page).getByRole('button', { name: 'Send invitation' }).click()
  const invitations = page.getByRole('table', { name: 'Pending invitations to Northline Labs' })
  await expect(invitations).toContainText('new.hire@example.com')
  await expectScreenAccessible(page, 'an organization with members and an invitation')
  await page
    .getByRole('button', { name: 'Withdraw the invitation to new.hire@example.com' })
    .click()
  await dialog(page).getByRole('button', { name: 'Withdraw invitation' }).click()
  await expect(page.getByText('No invitations are waiting')).toBeVisible()

  // Deleting names the organization and goes back to the list.
  await page.getByRole('button', { name: 'Delete organization' }).click()
  await expect(dialog(page).getByRole('heading')).toHaveText('Delete Northline Labs?')
  await expectScreenAccessible(page, 'the confirmation before an organization is deleted')
  await dialog(page).getByRole('button', { name: 'Delete organization' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Organizations' })).toBeVisible()
  await expect(page.getByText('No organizations yet')).toBeVisible()
})

test('the list is searched on its page, and the search is in the address', async ({ page }) => {
  await makeOrganization(page, 'Acme Corp', 'acme')
  await makeOrganization(page, 'Globex', 'globex')
  await open(page, `${ENVIRONMENT_PATH}/organizations`, 'Organizations')
  await expect(page.getByRole('link', { name: 'Acme Corp' })).toBeVisible()
  await page.getByLabel('Search organizations').fill('glob')
  await page.getByRole('button', { name: 'Search' }).click()
  await expect(page).toHaveURL(/organizations\?q=glob/)
  await page.reload()
  await expect(page.getByRole('link', { name: 'Globex' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Acme Corp' })).toHaveCount(0)
  await expectScreenAccessible(page, 'organizations, searched')
})

test('roles: built-in ones are read-only; custom ones are created, changed, asked about and deleted', async ({
  page,
}) => {
  await open(page, `${ENVIRONMENT_PATH}/roles`, 'Roles')
  const cards = page.getByTestId('role')
  await expect(cards).toHaveCount(2)
  await expect(cards.first().getByRole('button')).toHaveCount(0)
  await expect(page.getByText('No custom roles yet')).toBeVisible()
  await expectScreenAccessible(page, 'roles, built-in only')

  // The form says what is wrong before it sends anything.
  await page.getByRole('button', { name: 'Create role' }).click()
  await dialog(page).getByLabel('Name').fill('Billing manager')
  await dialog(page).getByLabel('Key').fill('Billing')
  await dialog(page).getByRole('button', { name: 'Create role' }).click()
  await expect(dialog(page).getByRole('alert')).toHaveCount(1)
  await expectScreenAccessible(page, 'create a role, with an error')
  await dialog(page).getByLabel('Key').fill('billing')
  await dialog(page).getByLabel('See the members').click()
  await dialog(page).getByLabel('Your own permissions').fill('org:billing:read')
  await dialog(page).getByRole('button', { name: 'Create role' }).click()
  await expect(page.getByText('Role created')).toBeVisible()
  const billing = page.locator('[data-testid="role"][data-key="billing"]')
  await expect(billing).toContainText('org:billing:read')
  await expect(billing).toContainText('See the members')

  // Taking a permission away is not asked about; giving one is, in words.
  await page.getByRole('button', { name: 'Edit the role Billing manager' }).click()
  await dialog(page).getByLabel('Your own permissions').fill('')
  await dialog(page).getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Role saved')).toBeVisible()
  await page.getByRole('button', { name: 'Edit the role Billing manager' }).click()
  await dialog(page).getByLabel('Manage the members').click()
  await dialog(page).getByRole('button', { name: 'Save changes' }).click()
  await expect(dialog(page).getByRole('heading')).toHaveText(
    'Give the role Billing manager more access?'
  )
  await expect(dialog(page).getByTestId('weakening')).toContainText('Manage the members')
  await expectScreenAccessible(page, 'the question before a role gains a permission')
  await dialog(page).getByRole('button', { name: 'Give more access' }).click()
  await expect(billing).toContainText('Manage the members')

  // Someone else renames it while a dialog is open: nothing is saved over theirs.
  await page.getByRole('button', { name: 'Edit the role Billing manager' }).click()
  const current = await read<{ data: { key: string; version: number }[] }>(
    page,
    '/v1/admin/organization-roles'
  )
  const version = current.data.find((role) => role.key === 'billing')?.version
  await send(
    page,
    'PATCH',
    '/v1/admin/organization-roles/billing',
    { name: 'Finance manager' },
    { 'if-match': `"${version}"` }
  )
  await dialog(page).getByLabel('Name').fill('Mine')
  await dialog(page).getByRole('button', { name: 'Save changes' }).click()
  await expect(dialog(page).getByRole('alert')).toContainText(/changed since you opened it/i)
  await expectScreenAccessible(page, 'a role changed since it was opened')
  await dialog(page).getByRole('button', { name: 'Load the current version' }).click()
  await expect(dialog(page).getByLabel('Name')).toHaveValue('Finance manager')
  await dialog(page).getByRole('button', { name: 'Cancel' }).click()

  // A role in use is refused in words; an idle one is deleted by name.
  await makeOrganization(page, 'Acme Corp', 'acme')
  const manager = uniqueEmail('role-holder')
  const userId = await makeUser(page, manager)
  created.push(userId)
  const [organization] = (await read<{ data: Row[] }>(page, '/v1/admin/organizations')).data
  await send(page, 'POST', `/v1/admin/organizations/${organization?.id}/memberships`, {
    userId,
    role: 'admin',
  })
  await send(page, 'POST', `/v1/admin/organizations/${organization?.id}/memberships`, {
    userId: await makeUser(page, uniqueEmail('role-holder-two')),
    role: 'billing',
  })
  await page.reload()
  await page.getByRole('button', { name: 'Delete the role Finance manager' }).click()
  await expect(dialog(page).getByRole('heading')).toHaveText('Delete the role Finance manager?')
  await dialog(page).getByRole('button', { name: 'Delete role' }).click()
  await expect(dialog(page).getByRole('alert')).toContainText('Members still hold this role')
  await expectScreenAccessible(page, 'a role in use cannot be deleted')
  await dialog(page).getByRole('button', { name: 'Cancel' }).click()
  await send(page, 'DELETE', `/v1/admin/organizations/${organization?.id}`)
  await page.getByRole('button', { name: 'Delete the role Finance manager' }).click()
  await dialog(page).getByRole('button', { name: 'Delete role' }).click()
  await expect(page.getByText('Role deleted')).toBeVisible()
  await expect(page.getByText('No custom roles yet')).toBeVisible()
})

test('organization settings: weakenings are asked about first, the rest saves', async ({
  page,
}) => {
  await open(page, `${ENVIRONMENT_PATH}/organization-settings`, 'Organization settings')
  await expectScreenAccessible(page, 'organization settings')

  await page.getByRole('switch', { name: 'Users may create organizations' }).click()
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(dialog(page).getByRole('heading')).toHaveText('This weakens security. Save anyway?')
  await expect(dialog(page)).toContainText('Any signed-in user may create an organization')
  await expectScreenAccessible(page, 'the question before users may create organizations')
  await dialog(page).getByRole('button', { name: 'Cancel' }).click()
  const before = await read<{ settings: { organizations: { allowUserCreated: boolean } } }>(
    page,
    '/v1/admin/settings'
  )
  expect(before.settings.organizations.allowUserCreated).toBe(false)

  await page.getByRole('button', { name: 'Save changes' }).click()
  await dialog(page).getByRole('button', { name: 'Save anyway' }).click()
  await expect(page.getByText('Settings saved')).toBeVisible()
  const after = await read<{ settings: { organizations: { allowUserCreated: boolean } } }>(
    page,
    '/v1/admin/settings'
  )
  expect(after.settings.organizations.allowUserCreated).toBe(true)

  // Lowering the cap is not a weakening.
  await page.getByLabel('Organizations one user may create').fill('2')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Settings saved')).toBeVisible()
  await expect(dialog(page)).toHaveCount(0)
})

test('a user’s page lists their organizations; the last manager of one cannot be deleted', async ({
  page,
}) => {
  const email = uniqueEmail('org-sole')
  const userId = await makeUser(page, email)
  created.push(userId)
  const organizationId = await makeOrganization(page, 'Northline Labs', 'northline-labs', userId)

  await open(page, `${ENVIRONMENT_PATH}/users/${userId}`, email)
  const table = page.getByRole('table', { name: 'Organizations of this user' })
  await expect(table).toContainText('Northline Labs')
  await expect(table).toContainText('Admin')
  await expectScreenAccessible(page, 'a user with an organization')

  await page.getByRole('button', { name: 'Delete user' }).click()
  await dialog(page).getByRole('button', { name: 'Delete user' }).click()
  await expect(dialog(page).getByRole('alert')).toContainText('only manager of an organization')
  await expect(dialog(page).getByRole('link', { name: 'Northline Labs' })).toBeVisible()
  await expectScreenAccessible(page, 'a user who is the last manager of an organization')
  await dialog(page).getByRole('link', { name: 'Northline Labs' }).click()
  await expect(page).toHaveURL(new RegExp(`organizations/${organizationId}$`))
  await expect(page.getByRole('heading', { level: 1, name: 'Northline Labs' })).toBeVisible()
})

test('domains: claimed with an emailed code, switched to joining automatically after a question, removed', async ({
  page,
}) => {
  const domain = `dom${Date.now()}.example.org`
  const address = `admin@${domain}`
  await makeOrganization(page, 'Northline Labs', 'northline-labs')
  const [organization] = (await read<{ data: Row[] }>(page, '/v1/admin/organizations')).data
  await open(page, `${ENVIRONMENT_PATH}/organizations/${organization?.id}`, 'Northline Labs')
  await expect(page.getByText('No domains claimed')).toBeVisible()
  await expectScreenAccessible(page, 'an organization, no domains')

  // A public mail domain is refused in words.
  await page.getByRole('button', { name: 'Claim a domain' }).click()
  await dialog(page).getByLabel('Domain', { exact: true }).fill('gmail.com')
  await dialog(page).getByLabel('Address on that domain').fill('someone@gmail.com')
  await dialog(page).getByRole('button', { name: 'Send code' }).click()
  await expect(dialog(page).getByRole('alert')).toContainText('public email domain')
  await expectScreenAccessible(page, 'claim a domain, refused')

  await dialog(page).getByLabel('Domain', { exact: true }).fill(domain)
  await dialog(page).getByLabel('Address on that domain').fill(address)
  await dialog(page).getByRole('button', { name: 'Send code' }).click()
  await expect(dialog(page).getByRole('heading')).toHaveText(`Verify ${domain}`)
  await dialog(page).getByLabel('Code').fill('000000')
  await dialog(page).getByRole('button', { name: 'Verify domain' }).click()
  await expect(dialog(page).getByRole('alert')).toContainText('not right')
  await expectScreenAccessible(page, 'verify a domain, wrong code')
  await dialog(page)
    .getByLabel('Code')
    .fill(await latestCode(page.request, address))
  await dialog(page).getByRole('button', { name: 'Verify domain' }).click()
  const table = page.getByRole('table', { name: 'Domains of Northline Labs' })
  await expect(table).toContainText('Verified')
  await expect(table).toContainText('Suggest the organization')
  await expectScreenAccessible(page, 'a verified domain')

  // Joining automatically is a weakening: asked first, then it holds.
  await page.getByRole('button', { name: `Join people automatically on ${domain}` }).click()
  await expect(dialog(page).getByRole('heading')).toHaveText(
    `Join people automatically on ${domain}?`
  )
  await expect(dialog(page)).toContainText('no invitation')
  await expectScreenAccessible(page, 'the question before a domain joins people automatically')
  await dialog(page).getByRole('button', { name: 'Cancel' }).click()
  await expect(table).toContainText('Suggest the organization')
  await page.getByRole('button', { name: `Join people automatically on ${domain}` }).click()
  await dialog(page).getByRole('button', { name: 'Join automatically' }).click()
  await expect(table).toContainText('Join automatically')

  await page.getByRole('button', { name: `Remove the domain ${domain}` }).click()
  await expect(dialog(page).getByRole('heading')).toHaveText(`Remove the domain ${domain}?`)
  await dialog(page).getByRole('button', { name: 'Remove domain' }).click()
  await expect(page.getByText('No domains claimed')).toBeVisible()
})
