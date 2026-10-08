import { type BrowserContext, expect, type Page, test } from '@playwright/test'
import {
  API_URL,
  expectAccessible,
  PASSWORD,
  resetLimits,
  serverNow,
  signIn,
  signUp,
  uniqueEmail,
  useSettings,
} from '../support'

// The Next.js example (examples/nextjs-app-router, built and served by `next start`) against
// the real API in process. What is under test is @tula/nextjs: the route handler the browser
// talks to, the proxy that verifies and refreshes sessions, and the server helpers.

const NEXT_URL = 'http://localhost:4319'
/** The fixture's fake secret key (e2e/server.ts): an administrator's key for these tests. */
const SECRET_KEY = 'tula_sk_dev_e2e000000000000000000000000000000'

test.beforeEach(async ({ request }) => {
  await resetLimits(request)
})

test.afterEach(async ({ request }) => {
  // Every scenario shares the one in-memory environment: put its settings back.
  await useSettings(request)
})

/** The app's Tula cookies, by name. */
async function tulaCookies(context: BrowserContext) {
  const cookies = await context.cookies(NEXT_URL)
  return new Map(
    cookies
      .filter((cookie) => cookie.name.startsWith('tula_'))
      .map((cookie) => [cookie.name, cookie])
  )
}

async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Account menu for/ }).click()
  await page.getByRole('menuitem', { name: 'Sign out' }).click()
  await expect(page.getByRole('heading', { name: 'Northline' })).toBeVisible()
  // The server-rendered half of the home page: shown once the server, too, sees nobody.
  await expect(page.getByRole('link', { name: 'Create an account' })).toBeVisible()
}

test.describe('protected routes', () => {
  test('a signed-out visitor is sent to sign-in and comes back to the page they asked for', async ({
    page,
    request,
  }) => {
    const email = uniqueEmail('next-return')
    await signUp(page, request, { email, firstName: 'Maya' })
    await signOut(page)

    await page.goto('/profile')
    await expect(page).toHaveURL(`${NEXT_URL}/sign-in?redirect_url=%2Fprofile`)
    await page.getByLabel('Email address').fill(email)
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page).toHaveURL(`${NEXT_URL}/profile`)
    await expect(page.getByText(email).first()).toBeVisible()
  })

  test('a protected route handler answers 401 without a session, and the public page is served', async ({
    page,
  }) => {
    const whoami = await page.request.get('/api/whoami')
    expect(whoami.status()).toBe(401)
    expect(await whoami.json()).toMatchObject({ code: 'auth.unauthenticated' })
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Northline' })).toBeVisible()
  })

  test('a redirect_url that leaves the site is ignored', async ({ page, request }) => {
    const email = uniqueEmail('next-open-redirect')
    await signUp(page, request, { email })
    await signOut(page)

    for (const target of ['https://evil.example/', '//evil.example', '/\\evil.example']) {
      await page.goto(`/sign-in?redirect_url=${encodeURIComponent(target)}`)
      await page.getByLabel('Email address').fill(email)
      await page.getByRole('button', { name: 'Continue', exact: true }).click()
      await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
      await page.getByRole('button', { name: 'Sign in', exact: true }).click()
      await expect(page).toHaveURL(`${NEXT_URL}/dashboard`)
      await signOut(page)
    }
  })
})

test.describe('the server knows the user', () => {
  test('a server component, a route handler and a server action all see the session', async ({
    page,
    request,
    context,
  }) => {
    const email = uniqueEmail('next-server')
    await signUp(page, request, { email, firstName: 'Maya' })
    await expect(page).toHaveURL(`${NEXT_URL}/dashboard`)
    await expect(page.getByRole('heading', { name: 'Hello, Maya' })).toBeVisible()
    await expect(page.getByTestId('server-email')).toHaveText(email)

    // Rendered on the server: the HTML itself has the user, and the signed-in header.
    const html = await (await page.request.get('/dashboard')).text()
    expect(html).toContain(email)
    expect(html).toContain('href="/dashboard"')

    const whoami = await page.request.get('/api/whoami')
    expect(whoami.status()).toBe(200)
    const { userId, sessionId } = (await whoami.json()) as { userId: string; sessionId: string }
    await expect(page.getByTestId('server-user-id')).toHaveText(userId)
    await expect(page.getByTestId('server-session-id')).toHaveText(sessionId)

    await page.getByRole('button', { name: 'Ask the server who I am' }).click()
    await expect(page.getByTestId('action-result')).toHaveText(`The server action ran as ${email}.`)

    // No script can read a token: the cookies are HttpOnly and nothing is in storage.
    const cookies = await tulaCookies(context)
    expect([...cookies.keys()].sort()).toEqual(['tula_at', 'tula_rt'])
    for (const cookie of cookies.values()) {
      expect(cookie.httpOnly).toBe(true)
      expect(cookie.sameSite).toBe('Lax')
      expect(cookie.path).toBe('/')
      expect(cookie.domain).toBe('localhost')
    }
    const visible = await page.evaluate(() => ({
      cookie: document.cookie,
      local: JSON.stringify({ ...localStorage }),
      session: JSON.stringify({ ...sessionStorage }),
    }))
    expect(visible.cookie).not.toContain('tula_')
    const access = cookies.get('tula_at')?.value as string
    const refresh = cookies.get('tula_rt')?.value as string
    for (const place of Object.values(visible)) {
      expect(place).not.toContain(access)
      expect(place).not.toContain(refresh)
    }

    // The browser never called the API's own host: everything went through this origin.
    const reload = page.waitForLoadState('networkidle')
    const hosts = new Set<string>()
    page.on('request', (sent) => hosts.add(new URL(sent.url()).host))
    await page.reload()
    await reload
    await page.goto('/profile')
    await expect(page.getByText(email).first()).toBeVisible()
    expect([...hosts]).toEqual(['localhost:4319'])
  })

  test('the first paint after a reload is already signed in: no flash of signed-out', async ({
    page,
    request,
  }) => {
    await signUp(page, request, { email: uniqueEmail('next-first-paint') })
    // Hold the browser's own session check: what is on screen is what the server rendered.
    await page.route('**/api/tula/**', (route) => route.abort())
    await page.reload()
    await expect(
      page.getByRole('navigation', { name: 'Account' }).getByRole('link', { name: 'Dashboard' })
    ).toBeVisible()
    await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toHaveCount(0)
  })
})

test.describe('sessions', () => {
  test('an access token near its expiry is refreshed by the proxy, and the cookies rotate', async ({
    page,
    request,
    context,
  }) => {
    test.slow()
    // The Next.js server judges expiry by the real time, so the fixture's clock must not have
    // been moved forward yet (`advanceClock` in the other project; this project runs first).
    expect(
      Math.abs((await serverNow(request)) - Date.now()),
      'the fixture clock is ahead: run this project before scenarios that advance it'
    ).toBeLessThan(2_000)
    // The shortest lifetime a profile allows.
    await useSettings(request, { sessions: { profiles: { web: { accessTokenTtl: '30s' } } } })
    await signUp(page, request, { email: uniqueEmail('next-expiry') })
    const before = await tulaCookies(context)
    const firstExpiry = await page.getByTestId('server-token-expiry').innerText()

    // Past the point where the proxy treats the token as expired (ten seconds before `exp`).
    await page.waitForTimeout(22_000)
    // Only the proxy may refresh: the browser's own client is kept off the API.
    await page.route('**/api/tula/**', (route) => route.abort())
    await page.reload()
    await expect(page.getByRole('heading', { name: /^Hello/ })).toBeVisible()

    const after = await tulaCookies(context)
    expect(after.get('tula_rt')?.value).not.toBe(before.get('tula_rt')?.value)
    expect(after.get('tula_at')?.value).not.toBe(before.get('tula_at')?.value)
    // The same request's server component already saw the new token.
    const secondExpiry = await page.getByTestId('server-token-expiry').innerText()
    expect(Date.parse(secondExpiry)).toBeGreaterThan(Date.parse(firstExpiry))
  })

  test('a missing access-token cookie is replaced from the refresh cookie on any request', async ({
    page,
    request,
    context,
  }) => {
    await signUp(page, request, { email: uniqueEmail('next-missing') })
    await context.clearCookies({ name: 'tula_at' })
    const whoami = await page.request.get('/api/whoami')
    expect(whoami.status()).toBe(200)
    expect((await tulaCookies(context)).has('tula_at')).toBe(true)
  })

  test('signing out clears the server’s view at once', async ({ page, request, context }) => {
    await signUp(page, request, { email: uniqueEmail('next-sign-out') })
    await signOut(page)
    expect((await tulaCookies(context)).size).toBe(0)
    expect((await page.request.get('/api/whoami')).status()).toBe(401)
    await page.goto('/dashboard')
    await expect(page).toHaveURL(`${NEXT_URL}/sign-in?redirect_url=%2Fdashboard`)
  })

  test('a session an administrator revoked is signed out at its next refresh', async ({
    page,
    request,
    context,
  }) => {
    await signUp(page, request, { email: uniqueEmail('next-revoked') })
    const { userId } = (await (await page.request.get('/api/whoami')).json()) as { userId: string }
    const revoked = await request.delete(`${API_URL}/v1/admin/users/${userId}/sessions`, {
      headers: { authorization: `Bearer ${SECRET_KEY}` },
    })
    expect(revoked.ok()).toBe(true)

    // The access token is verified offline, so it still works until it expires…
    expect((await page.request.get('/api/whoami')).status()).toBe(200)
    // …and when it is gone, the refresh is refused: signed out, cookies cleared.
    await context.clearCookies({ name: 'tula_at' })
    await page.goto('/dashboard')
    await expect(page).toHaveURL(`${NEXT_URL}/sign-in?redirect_url=%2Fdashboard`)
    expect((await tulaCookies(context)).size).toBe(0)
  })

  test('a stateful profile works: one first-party session cookie, verified by the API', async ({
    page,
    request,
    context,
  }) => {
    await useSettings(request, { sessions: { profiles: { web: { type: 'stateful' } } } })
    const email = uniqueEmail('next-stateful')
    await signUp(page, request, { email, firstName: 'Maya' })
    await expect(page.getByTestId('server-email')).toHaveText(email)

    const cookies = await tulaCookies(context)
    expect([...cookies.keys()]).toEqual(['tula_session'])
    expect(cookies.get('tula_session')?.httpOnly).toBe(true)
    expect((await page.request.get('/api/whoami')).status()).toBe(200)

    await page.reload()
    await expect(page.getByRole('heading', { name: 'Hello, Maya' })).toBeVisible()
    await page.getByRole('button', { name: 'Ask the server who I am' }).click()
    await expect(page.getByTestId('action-result')).toHaveText(`The server action ran as ${email}.`)

    await signOut(page)
    expect((await tulaCookies(context)).size).toBe(0)
    expect((await page.request.get('/api/whoami')).status()).toBe(401)
  })
})

test.describe('requests from elsewhere', () => {
  test('a cross-origin POST to the route handler is refused and changes nothing', async ({
    page,
    request,
    context,
  }) => {
    await signUp(page, request, { email: uniqueEmail('next-csrf') })

    // A page on another origin (the API's own host, here) makes the visitor's browser post to
    // the app with its cookies: a sign-out the visitor did not ask for.
    const foreign = await context.newPage()
    await foreign.goto(`${API_URL}/v1/status`)
    const seen: number[] = []
    context.on('response', (response) => {
      if (response.url().endsWith('/api/tula/v1/client/sessions/sign-out')) {
        seen.push(response.status())
      }
    })
    await foreign.evaluate(async (target) => {
      await fetch(`${target}/api/tula/v1/client/sessions/sign-out`, {
        method: 'POST',
        mode: 'no-cors',
        credentials: 'include',
        headers: { 'content-type': 'text/plain' },
        body: '{}',
      }).catch(() => undefined)
    }, NEXT_URL)
    await expect.poll(() => seen).toEqual([403])
    await foreign.close()

    // Still signed in, on the server and in the browser.
    expect((await page.request.get('/api/whoami')).status()).toBe(200)
    expect((await tulaCookies(context)).has('tula_rt')).toBe(true)

    // The same from a tool that can write any header: a foreign Origin, or none.
    const forged: Array<Record<string, string>> = [{ origin: 'https://evil.example' }, {}]
    for (const headers of forged) {
      const response = await page.request.post('/api/tula/v1/client/sessions/sign-out', {
        headers: { 'content-type': 'application/json', ...headers },
        data: {},
      })
      expect(response.status()).toBe(403)
      expect(await response.json()).toMatchObject({ code: 'request.origin_not_allowed' })
    }
    expect((await page.request.get('/api/whoami')).status()).toBe(200)
  })

  test('the route handler forwards client routes only', async ({ page }) => {
    expect((await page.request.get('/api/tula/v1/client/config')).status()).toBe(200)
    for (const path of [
      '/api/tula/v1/admin/users',
      '/api/tula/v1/status',
      '/api/tula/v1/client/..%2fadmin/users',
    ]) {
      expect((await page.request.get(path)).status(), path).toBe(404)
    }
  })

  test('a header claiming a session is not a session', async ({ page }) => {
    const forged = Buffer.from(
      JSON.stringify({ claims: { sub: 'admin', sid: 's', exp: 9_999_999_999 } })
    ).toString('base64url')
    const response = await page.request.get('/api/whoami', {
      headers: { 'x-tula-auth': `${forged}.AAAA` },
    })
    expect(response.status()).toBe(401)
  })
})

test.describe('accessibility', () => {
  for (const scheme of ['light', 'dark'] as const) {
    test(`every page passes axe in ${scheme}`, async ({ page, request }) => {
      await page.emulateMedia({ colorScheme: scheme })
      await page.goto('/')
      await expect(page.getByRole('heading', { name: 'Northline' })).toBeVisible()
      await expectAccessible(page, `next home, signed out (${scheme})`)

      await page.goto('/dashboard')
      await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
      await expectAccessible(page, `next sign-in (${scheme})`)

      await page.goto('/sign-up')
      await expect(page.getByLabel('Email address')).toBeVisible()
      await expectAccessible(page, `next sign-up (${scheme})`)

      const email = uniqueEmail(`next-axe-${scheme}`)
      await signUp(page, request, { email, firstName: 'Maya' })
      await page.getByRole('button', { name: 'Ask the server who I am' }).click()
      await expect(page.getByTestId('action-result')).toContainText(email)
      await expectAccessible(page, `next dashboard (${scheme})`)

      await page.goto('/profile')
      await expect(page.getByText(email).first()).toBeVisible()
      await expectAccessible(page, `next profile (${scheme})`)

      await page.goto('/')
      await expect(page.getByRole('link', { name: 'Open the dashboard' })).toBeVisible()
      await expectAccessible(page, `next home, signed in (${scheme})`)
    })
  }

  test('signing in from the sign-in page lands on the dashboard', async ({ page, request }) => {
    const email = uniqueEmail('next-sign-in')
    await signUp(page, request, { email })
    await signOut(page)
    await signIn(page, email)
    await expect(page).toHaveURL(`${NEXT_URL}/dashboard`)
    await expect(page.getByTestId('server-email')).toHaveText(email)
  })
})
