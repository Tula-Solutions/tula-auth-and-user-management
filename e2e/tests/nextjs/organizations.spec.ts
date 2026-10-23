import { type APIRequestContext, expect, type Page, test } from '@playwright/test'
import {
  API_URL,
  expectAccessible,
  resetLimits,
  signUp,
  uniqueEmail,
  useSettings,
} from '../support'

// The active organization and `has()` in the Next.js example (ADR 0065, TULA-117): a page
// that needs `org:billing:read` is allowed, refused or, with no organization, refused too.
// The proxy decides from the verified claims of the session cookies; the server component and
// the browser's hook read the same claims.

const NEXT_URL = 'http://localhost:4319'
const SECRET_KEY = 'tula_sk_dev_e2e000000000000000000000000000000'
const ADMIN = { authorization: `Bearer ${SECRET_KEY}` }

let counter = 0
/** A key, slug or name part nobody has used in this run. */
function unique(tag: string): string {
  counter += 1
  return `${tag}${Date.now().toString(36)}${counter}`
}

test.beforeEach(async ({ request }) => {
  await resetLimits(request)
})

test.afterEach(async ({ request }) => {
  await useSettings(request)
})

async function admin(
  request: APIRequestContext,
  path: string,
  data: object
): Promise<{ id?: string }> {
  const response = await request.post(`${API_URL}/v1/admin/${path}`, { headers: ADMIN, data })
  expect(response.status(), `${path}: ${await response.text()}`).toBeLessThan(300)
  return (await response.json()) as { id?: string }
}

/** The signed-in user's id, as the example's protected route reports it. */
async function userIdOf(page: Page): Promise<string> {
  const response = await page.request.get('/api/whoami')
  expect(response.status()).toBe(200)
  return ((await response.json()) as { userId: string }).userId
}

/** An organization the signed-in user belongs to with `role`; returns its name. */
async function joinOrganization(
  page: Page,
  request: APIRequestContext,
  role: string
): Promise<{ id: string; name: string }> {
  const name = unique('Acme ')
  const created = await admin(request, 'organizations', { name, slug: unique('acme-') })
  const id = created.id as string
  await admin(request, `organizations/${id}/memberships`, {
    userId: await userIdOf(page),
    role,
  })
  return { id, name }
}

async function billingManagerRole(request: APIRequestContext): Promise<string> {
  const key = unique('billing_').replace(/[^a-z0-9_]/g, '_')
  await admin(request, 'organization-roles', {
    key,
    name: 'Billing manager',
    permissions: ['org:billing:read'],
  })
  return key
}

async function switchTo(page: Page, label: string | RegExp): Promise<void> {
  await page.getByRole('button', { name: label }).click()
}

test('a permission of the active organization opens a protected page', async ({
  page,
  request,
}) => {
  await useSettings(request, { organizations: { enabled: true } })
  const role = await billingManagerRole(request)
  await signUp(page, request, { email: uniqueEmail('next-org-allowed'), firstName: 'Maya' })
  const org = await joinOrganization(page, request, role)

  // Signed in, no organization active yet: the server and the browser both say so.
  await page.goto('/dashboard')
  await expect(page.getByTestId('server-org-id')).toHaveText('none')
  await page.goto('/organizations')
  await expect(page.getByTestId('client-can-billing')).toHaveText('No billing access.')

  await switchTo(page, `Switch to ${org.name}`)
  await expect(page.getByTestId('client-role')).toHaveText(`Your role here: ${role}`)
  await expect(page.getByTestId('client-can-billing')).toHaveText('You can read billing.')
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await expectAccessible(page, `Next.js: organizations (${colorScheme})`)
  }
  await page.emulateMedia({ colorScheme: 'light' })

  // The switch changed the cookie the server reads.
  await page.goto('/dashboard')
  await expect(page.getByTestId('server-org-id')).toHaveText(org.id)
  await expect(page.getByTestId('server-org-role')).toHaveText(role)

  await page.goto('/billing')
  await expect(page).toHaveURL(`${NEXT_URL}/billing`)
  await expect(page.getByRole('heading', { name: 'Billing' })).toBeVisible()
  await expect(page.getByTestId('billing-org')).toHaveText(org.id)
  await expect(page.getByTestId('billing-role')).toHaveText(role)
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await expectAccessible(page, `Next.js: billing (${colorScheme})`)
  }
})

test('a role without the permission is sent to the no-access page', async ({ page, request }) => {
  await useSettings(request, { organizations: { enabled: true } })
  await signUp(page, request, { email: uniqueEmail('next-org-refused') })
  const org = await joinOrganization(page, request, 'member')
  await page.goto('/organizations')
  await switchTo(page, `Switch to ${org.name}`)
  await expect(page.getByTestId('client-role')).toHaveText('Your role here: member')
  await expect(page.getByTestId('client-can-billing')).toHaveText('No billing access.')
  await page.goto('/dashboard')
  await expect(page.getByTestId('server-org-role')).toHaveText('member')

  await page.goto('/billing')
  await expect(page).toHaveURL(`${NEXT_URL}/no-access`)
  await expect(page.getByTestId('no-access-detail')).toContainText('(member)')
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await expectAccessible(page, `Next.js: no access (${colorScheme})`)
  }
})

test('with no organization active the protected page is refused, and a visitor is sent to sign in', async ({
  page,
  request,
}) => {
  await useSettings(request, { organizations: { enabled: true } })
  const role = await billingManagerRole(request)
  await signUp(page, request, { email: uniqueEmail('next-org-none') })
  // A member of an organization holding the permission, but acting as the personal account.
  await joinOrganization(page, request, role)
  await page.goto('/billing')
  await expect(page).toHaveURL(`${NEXT_URL}/no-access`)
  await expect(page.getByTestId('no-access-detail')).toHaveText(
    'No organization is active for this session.'
  )

  // The no-access page offers the switch; choosing the organization opens the page.
  await switchTo(page, /^Switch to Acme/)
  await expect(page.getByTestId('client-role')).toContainText(role)
  await page.goto('/billing')
  await expect(page).toHaveURL(`${NEXT_URL}/billing`)

  // Back to the personal account: refused again.
  await page.goto('/no-access')
  await switchTo(page, 'Personal account')
  await expect(page.getByTestId('no-access-detail')).toHaveText(
    'No organization is active for this session.'
  )
  await page.goto('/billing')
  await expect(page).toHaveURL(`${NEXT_URL}/no-access`)
})

test('a visitor with no session is sent to sign in, not to the no-access page', async ({
  page,
}) => {
  await page.goto('/billing')
  await expect(page).toHaveURL(`${NEXT_URL}/sign-in?redirect_url=%2Fbilling`)
})

test('the largest role and the largest custom claims fit in the cookies and still open the page', async ({
  page,
  request,
  context,
}) => {
  // The worst case the API allows (TULA-112): a custom role of 32 permissions of 69 characters
  // and a 32-character key, on top of the largest custom-claims template. The access token is
  // about 5.3 kB, more than a browser keeps in one cookie, so the SDK stores it in two.
  const claims = Object.fromEntries(
    ['a', 'b', 'c', 'd'].map((key, i) => [
      key,
      { value: String.fromCharCode(120 + i).repeat(i < 3 ? 256 : 220) },
    ])
  )
  await useSettings(request, {
    organizations: { enabled: true },
    sessions: {
      jwtTemplates: { app: { claims } },
      profiles: { web: { jwtTemplate: 'app' } },
    },
  })
  const role = 'r'.repeat(31) + 'x'
  const permissions = [
    'org:billing:read',
    ...Array.from(
      { length: 31 },
      (_, i) =>
        `org:${'f'.repeat(30)}${String(i).padStart(2, '0')}:${'a'.repeat(30)}${String(i).padStart(2, '0')}`
    ),
  ]
  await admin(request, 'organization-roles', { key: role, name: 'Biggest', permissions })
  await signUp(page, request, { email: uniqueEmail('next-org-big') })
  const org = await joinOrganization(page, request, role)
  await page.goto('/organizations')
  await switchTo(page, `Switch to ${org.name}`)
  await expect(page.getByTestId('client-role')).toHaveText(`Your role here: ${role}`)

  const cookies = (await context.cookies(NEXT_URL)).filter((cookie) =>
    cookie.name.startsWith('tula_at')
  )
  expect(cookies.map((cookie) => cookie.name).sort()).toEqual(['tula_at', 'tula_at_1'])
  for (const cookie of cookies) {
    expect(cookie.name.length + cookie.value.length).toBeLessThanOrEqual(4096)
  }
  const whole = cookies.reduce((sum, cookie) => sum + cookie.value.length, 0)
  expect(whole).toBeGreaterThan(4096 - 'tula_at='.length)

  await page.goto('/billing')
  await expect(page).toHaveURL(`${NEXT_URL}/billing`)
  await expect(page.getByTestId('billing-role')).toHaveText(role)
  // The session survives a reload, which reads both parts.
  await page.reload()
  await expect(page.getByTestId('billing-org')).toHaveText(org.id)
})
