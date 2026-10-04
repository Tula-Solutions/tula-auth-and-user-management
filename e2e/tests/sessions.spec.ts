import { expect, type Page, type Request, test } from '@playwright/test'
import {
  expectAccessible,
  resetLimits,
  signIn,
  signOut,
  signUp,
  type TestSettings,
  uniqueEmail,
  useSettings,
} from './support'

// The example app on a `stateful` session profile (ADR 0028): the browser holds one httpOnly
// cookie and no token, and the app behaves exactly as it does on the default profile.

const STATEFUL: TestSettings = { sessions: { profiles: { web: { type: 'stateful' } } } }

test.beforeEach(async ({ request }) => {
  await resetLimits(request)
})

test.afterEach(async ({ request }) => {
  await useSettings(request)
})

function recordRequests(page: Page): Request[] {
  const requests: Request[] = []
  page.on('request', (request) => requests.push(request))
  return requests
}

/** Everything a script on the page can read: both web storages and `document.cookie`. */
async function readableByScript(page: Page): Promise<string> {
  return page.evaluate(() =>
    JSON.stringify({
      local: { ...window.localStorage },
      session: { ...window.sessionStorage },
      cookie: document.cookie,
    })
  )
}

test('stateful: sign up, only an httpOnly cookie, a reload keeps the session, sign out', async ({
  page,
  request,
  context,
}) => {
  await useSettings(request, STATEFUL)
  const requests = recordRequests(page)
  const bodies: string[] = []
  page.on('response', async (response) => {
    if (new URL(response.url()).pathname.startsWith('/v1/client')) {
      bodies.push(await response.text().catch(() => ''))
    }
  })
  const email = uniqueEmail('stateful')
  await signUp(page, request, { email, firstName: 'Maya' })
  await expect(page.getByRole('heading', { name: 'Hello, Maya' })).toBeVisible()

  // One cookie, the session's, which no script can read; no refresh cookie.
  const cookies = await context.cookies()
  const session = cookies.filter((cookie) => cookie.name.includes('tula_session_'))
  expect(session).toHaveLength(1)
  expect(session[0]).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' })
  expect(session[0]?.value).toMatch(/^tula_st_/)
  expect(cookies.filter((cookie) => cookie.name.includes('tula_rt_'))).toEqual([])

  // Nothing a script can reach holds a token, no response body carried one, and no request
  // an Authorization header: the cookie is all there is.
  const readable = await readableByScript(page)
  expect(readable).not.toContain('tula_st_')
  expect(readable).not.toContain('eyJ')
  expect(bodies.join('\n')).not.toMatch(/tula_st_|tula_rt_|accessToken/)
  for (const sent of requests) {
    expect(await sent.headerValue('authorization')).toBeNull()
  }

  // The session survives a reload: it is restored from the cookie.
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Hello, Maya' })).toBeVisible()

  // The account page works on the cookie alone.
  await page.getByRole('link', { name: 'Manage your account' }).click()
  await expect(page.locator('[data-tula-element="sessionItem"]')).toHaveCount(1)
  await expectAccessible(page, 'account page on a stateful session')

  await page.goto('/')
  await signOut(page)
  expect(
    (await context.cookies()).filter((cookie) => cookie.name.includes('tula_session_'))
  ).toEqual([])
  await page.goto('/')
  await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible()
})

test('stateful: signing out in one tab signs the other tab out', async ({
  page,
  request,
  context,
}) => {
  await useSettings(request, STATEFUL)
  const email = uniqueEmail('tabs')
  await signUp(page, request, { email, firstName: 'Maya' })
  const second = await context.newPage()
  await second.goto('/')
  await expect(second.getByRole('heading', { name: 'Hello, Maya' })).toBeVisible()

  await signOut(page)
  // The other tab is told at once; it makes no request to find out.
  await expect(second.getByRole('link', { name: 'Sign in' })).toBeVisible()
  await second.reload()
  await expect(second.getByRole('link', { name: 'Sign in' })).toBeVisible()
})

test('stateful: a device signed out from the list is signed out at its very next action', async ({
  page,
  request,
  browser,
}) => {
  await useSettings(request, STATEFUL)
  const email = uniqueEmail('revoke')
  await signUp(page, request, { email })

  const other = await browser.newContext()
  const second = await other.newPage()
  await signIn(second, email)
  await expect(second.getByRole('heading', { name: /^Hello/ })).toBeVisible()

  await page.getByRole('link', { name: 'Manage your account' }).click()
  const devices = page.locator('[data-tula-element="sessionItem"]')
  await expect(devices).toHaveCount(2)
  await page.getByRole('button', { name: /^Sign out Chrome on/ }).click()
  await expect(page.getByText('That device was signed out.')).toBeVisible()
  await expect(devices).toHaveCount(1)

  // No token has to expire first: the very next request of the other browser is refused.
  await second.getByRole('button', { name: /^Account menu for/ }).click()
  await second.getByRole('menuitem', { name: 'Manage account' }).click()
  await expect(second.getByRole('link', { name: 'Sign in' })).toBeVisible()
  await second.reload()
  await expect(second.getByRole('link', { name: 'Sign in' })).toBeVisible()
  await other.close()
})

test('the session limit: a refused sign-in says why, and signing out elsewhere frees a place', async ({
  page,
  request,
  browser,
}) => {
  await useSettings(request, { sessions: { maxPerUser: 1, onLimit: 'refuse_newest' } })
  const email = uniqueEmail('limit')
  await signUp(page, request, { email })

  const other = await browser.newContext()
  const second = await other.newPage()
  await signIn(second, email)
  const alert = second.getByRole('alert')
  await expect(alert).toContainText('You are signed in on too many devices')
  await expect(second.getByRole('heading', { name: /^Hello/ })).toHaveCount(0)
  expect(
    (await other.cookies()).filter((cookie) => /tula_(rt|session)_/.test(cookie.name))
  ).toEqual([])
  await expectAccessible(second, 'sign-in refused at the session limit')

  await signOut(page)
  await signIn(second, email)
  await expect(second.getByRole('heading', { name: /^Hello/ })).toBeVisible()
  await other.close()
})

test('the session limit: with end_oldest the new device gets in and the oldest is signed out', async ({
  page,
  request,
  browser,
}) => {
  await useSettings(request, { sessions: { maxPerUser: 1, onLimit: 'end_oldest' } })
  const email = uniqueEmail('oldest')
  await signUp(page, request, { email })

  const other = await browser.newContext()
  const second = await other.newPage()
  await signIn(second, email)
  await expect(second.getByRole('heading', { name: /^Hello/ })).toBeVisible()

  // The first browser finds out at its next call to the API: opening its account dialog.
  await page.getByRole('button', { name: /^Account menu for/ }).click()
  await page.getByRole('menuitem', { name: 'Manage account' }).click()
  await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Account menu for/ })).toHaveCount(0)
  await other.close()
})
