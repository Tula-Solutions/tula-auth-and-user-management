import { expect, type Page, type Request, test } from '@playwright/test'
import {
  API_URL,
  consentAtProvider,
  EMAIL_METHODS,
  expectAccessible,
  latestLink,
  resetLimits,
  signUp,
  uniqueEmail,
  useProviders,
  useSettings,
} from '../support'

// The two round trips that leave the page and come back, under Next.js: an OAuth provider and
// an emailed link. Both end on a callback page of the app, which finishes the sign-in through
// the route handler (the browser never calls the API's host itself), and the server-rendered
// dashboard must then know the user from the app's own cookies.
//
// The fixture's API runs in the `local` tier, which allows any loopback redirect URL: the
// callback pages need no entry in `urls.allowedRedirectUrls` here. A deployed app lists both.

const NEXT_URL = 'http://localhost:4319'

test.beforeEach(async ({ request }) => {
  await resetLimits(request)
})

test.afterEach(async ({ request }) => {
  await useProviders(request)
  await useSettings(request)
})

function recordRequests(page: Page): Request[] {
  const requests: Request[] = []
  page.on('request', (sent) => requests.push(sent))
  return requests
}

/** Console errors, page errors and failed requests: a clean run has none. */
function recordProblems(page: Page): string[] {
  const problems: string[] = []
  page.on('console', (message) => {
    const text = message.text()
    if ((message.type() === 'error' || message.type() === 'warning') && !text.includes('401')) {
      problems.push(text)
    }
  })
  page.on('pageerror', (error) => problems.push(String(error)))
  return problems
}

/** Requests a page's script made (not navigations) to the API's own host. */
function scriptCallsToApi(requests: Request[]): string[] {
  return requests
    .filter((sent) => sent.url().startsWith(API_URL) && sent.resourceType() !== 'document')
    .map((sent) => `${sent.method()} ${new URL(sent.url()).pathname}`)
}

async function tulaCookieNames(page: Page): Promise<string[]> {
  const cookies = await page.context().cookies(NEXT_URL)
  return cookies
    .filter((cookie) => cookie.name.startsWith('tula_'))
    .map((cookie) => cookie.name)
    .sort()
}

async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Account menu for/ }).click()
  await page.getByRole('menuitem', { name: 'Sign out' }).click()
  await expect(page.getByRole('link', { name: 'Create an account' })).toBeVisible()
}

test('OAuth through the proxy: the provider returns to the API, the app’s callback page exchanges the ticket, and the server knows the user', async ({
  page,
  context,
}) => {
  await useProviders(page.request, ['google'])
  const email = uniqueEmail('next-oauth')
  const requests = recordRequests(page)
  const problems = recordProblems(page)

  // A protected page, signed out: the proxy sends the visitor to sign-in.
  await page.goto('/dashboard')
  await page.getByRole('button', { name: 'Continue with Google' }).click()
  await consentAtProvider(page, { email })

  // Back on the app, signed in, on the server-rendered page.
  await expect(page).toHaveURL(`${NEXT_URL}/dashboard`)
  await expect(page.getByTestId('server-email')).toHaveText(email)
  expect(page.url()).not.toContain('#')

  // The session's cookies are the app's own two, and the browser holds no other: the API's
  // host (which the browser visited on the way back from the provider) set none.
  expect(await tulaCookieNames(page)).toEqual(['tula_at', 'tula_rt'])
  expect((await context.cookies()).map((cookie) => cookie.name).sort()).toEqual([
    'tula_at',
    'tula_rt',
  ])

  // The browser went to the API's host only by navigation (the provider's redirect to the
  // API's callback); every call a script made went to the app's own origin.
  expect(scriptCallsToApi(requests)).toEqual([])
  const exchange = requests.filter((sent) => sent.url().includes('/v1/client/sign-ins/oauth/'))
  expect(exchange.length).toBeGreaterThan(0)
  for (const sent of exchange) {
    expect(new URL(sent.url()).origin).toBe(NEXT_URL)
  }
  // No ticket or binding in any URL the app requested.
  for (const sent of requests) {
    if (new URL(sent.url()).origin === NEXT_URL) {
      expect(sent.url()).not.toContain('tula_ot_')
      expect(sent.url()).not.toContain('tula_ob_')
    }
  }
  expect(
    await page.evaluate(() => [...Object.keys(sessionStorage), ...Object.keys(localStorage)])
  ).toEqual([])
  expect(problems).toEqual([])

  // A reload is a fresh request to the server: still the same user.
  await page.reload()
  await expect(page.getByTestId('server-email')).toHaveText(email)

  // And the provider signs the same account in again.
  await signOut(page)
  await page.goto('/sign-in')
  await page.getByRole('button', { name: 'Continue with Google' }).click()
  await consentAtProvider(page, { email })
  await expect(page).toHaveURL(`${NEXT_URL}/dashboard`)
  await expect(page.getByTestId('server-email')).toHaveText(email)
})

test('OAuth cancelled at the provider: the callback page says so and nobody is signed in', async ({
  page,
}) => {
  await useProviders(page.request, ['google'])
  await page.goto('/sign-in')
  await page.getByRole('button', { name: 'Continue with Google' }).click()
  await consentAtProvider(page, { email: uniqueEmail('next-oauth-cancel'), cancel: true })

  await expect(page).toHaveURL(`${NEXT_URL}/oauth/callback`)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  expect(await tulaCookieNames(page)).toEqual([])
  expect((await page.request.get('/api/whoami')).status()).toBe(401)
})

test('an emailed link through the proxy: opened in the same browser, both tabs are signed in and the server knows the user', async ({
  page,
  context,
  request,
}) => {
  const email = uniqueEmail('next-link')
  await signUp(page, request, { email, firstName: 'Maya' })
  await signOut(page)
  // The sign-up emailed this address a moment ago.
  await resetLimits(request)
  await useSettings(request, EMAIL_METHODS)
  const requests = recordRequests(page)
  const problems = recordProblems(page)

  await page.goto('/sign-in')
  await page.getByLabel('Email address').fill(email)
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.getByRole('button', { name: 'Email me a link' }).click()
  await expect(page.getByText('Waiting for you to open the link…')).toBeVisible()

  // The link leads to this app's own page, with the token in the fragment only.
  const link = await latestLink(request, email)
  const url = new URL(link)
  expect(`${url.origin}${url.pathname}`).toBe(`${NEXT_URL}/auth/link`)
  expect(url.search).toBe('')
  const token = new URLSearchParams(url.hash.slice(1)).get('tula_link') ?? ''
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)

  // The user clicks it in their mail: a new tab of the same browser.
  const landing = await context.newPage()
  const landingRequests = recordRequests(landing)
  const landingProblems = recordProblems(landing)
  await landing.goto(link)
  await expect(landing).toHaveURL(`${NEXT_URL}/dashboard`)
  await expect(landing.getByTestId('server-email')).toHaveText(email)

  // The tab that asked finished the sign-in without being touched.
  await expect(page).toHaveURL(`${NEXT_URL}/dashboard`)
  await expect(page.getByTestId('server-email')).toHaveText(email)
  expect(await tulaCookieNames(page)).toEqual(['tula_at', 'tula_rt'])

  // The token went through the route handler in one request body, never in a URL, and no
  // script called the API's host.
  const all = [...requests, ...landingRequests]
  for (const sent of all) {
    expect(sent.url()).not.toContain(token)
    expect(sent.url()).not.toContain('tula_link')
  }
  const carried = landingRequests.filter((sent) => sent.postData()?.includes(token))
  expect(carried.map((sent) => sent.url())).toEqual([
    `${NEXT_URL}/api/tula/v1/client/sign-ins/link`,
  ])
  expect(scriptCallsToApi(all)).toEqual([])
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([])
  expect(problems).toEqual([])
  expect(landingProblems).toEqual([])

  // The link is spent: opening it again says so, on the callback page.
  await signOut(landing)
  await landing.goto(link)
  await expect(landing.getByRole('heading', { name: 'This link has expired' })).toBeVisible()
  await expect(landing).toHaveURL(`${NEXT_URL}/auth/link`)
})

test.describe('accessibility of the callback pages', () => {
  for (const scheme of ['light', 'dark'] as const) {
    test(`the callback pages pass axe in ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme })

      // Opened with nothing to do: what a visitor sees who lands here by hand.
      await page.goto('/auth/link')
      await expect(page.getByRole('heading', { name: 'No sign-in link here' })).toBeVisible()
      await expectAccessible(page, `next email-link callback, no link (${scheme})`)

      // A link nobody in this browser asked for: refused, and the page says what to do.
      await page.goto(
        `/auth/link#tula_link=${'A'.repeat(43)}&tula_attempt=00000000-0000-7000-8000-000000000000`
      )
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
      await expect(page.getByRole('heading', { name: 'No sign-in link here' })).toHaveCount(0)
      await expectAccessible(page, `next email-link callback, refused link (${scheme})`)

      await page.goto('/oauth/callback')
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
      await expectAccessible(page, `next oauth callback, nothing to finish (${scheme})`)

      // A sign-in the visitor cancelled at the provider.
      await useProviders(page.request, ['google'])
      await page.goto('/sign-in')
      await page.getByRole('button', { name: 'Continue with Google' }).click()
      await consentAtProvider(page, {
        email: uniqueEmail(`next-axe-oauth-${scheme}`),
        cancel: true,
      })
      await expect(page).toHaveURL(`${NEXT_URL}/oauth/callback`)
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
      await expectAccessible(page, `next oauth callback, cancelled (${scheme})`)
    })
  }
})
