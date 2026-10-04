import { type BrowserContext, expect, type Page, type Route, test } from '@playwright/test'
import { expectAccessible, resetLimits, signUp, uniqueEmail } from '../support'

// A sign-out that did not reach the server, in the Next.js example. Here it matters most: the
// session is three first-party cookies the server reads, so a client that said "signed out"
// and moved on would leave a browser whose next page load is signed in again. The failure is
// made in the browser (`page.route` on the request to the app's own route handler); the
// handler and the API behave as they always do.

const NEXT_URL = 'http://localhost:4319'
const SIGN_OUT = `${NEXT_URL}/api/tula/v1/client/sessions/sign-out`

test.beforeEach(async ({ request }) => {
  await resetLimits(request)
})

/** How the sign-out request fails: no answer at all, or an answer that is not a sign-out. */
const FAILURES: [string, (route: Route) => Promise<void>][] = [
  ['the request gets no answer', (route) => route.abort('connectionfailed')],
  [
    'the route handler answers 503',
    (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 503,
          code: 'service.unavailable',
          detail: 'The service is unavailable.',
        }),
      }),
  ],
]

/** The names of the app's Tula cookies. */
async function tulaCookieNames(context: BrowserContext): Promise<string[]> {
  const cookies = await context.cookies(NEXT_URL)
  return cookies
    .map((cookie) => cookie.name)
    .filter((name) => name.startsWith('tula_'))
    .sort()
}

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Sign-out did not finish' })

async function pressSignOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Account menu for/ }).click()
  await page.getByRole('menuitem', { name: 'Sign out' }).click()
}

for (const [name, fail] of FAILURES) {
  test(`sign out when ${name}: the cookies stay, a reload is still signed in, and trying again signs out`, async ({
    page,
    request,
    context,
  }) => {
    const email = uniqueEmail('next-sign-out-failed')
    await signUp(page, request, { email, firstName: 'Maya' })
    await expect(page).toHaveURL(`${NEXT_URL}/dashboard`)
    expect(await tulaCookieNames(context)).toEqual(['tula_at', 'tula_rt'])

    let attempts = 0
    await page.route(SIGN_OUT, async (route) => {
      attempts += 1
      await fail(route)
    })
    await pressSignOut(page)

    // The dialog, announced as an alert, with the focus on its title. Nothing navigated (the
    // app's after-sign-out page is /), and the cookies the server reads are all still there.
    await expect(dialog(page)).toBeVisible()
    await expect(dialog(page).getByRole('alert')).toContainText('may still be signed in')
    await expect(
      dialog(page).getByRole('heading', { name: 'Sign-out did not finish' })
    ).toBeFocused()
    await expect(page).toHaveURL(`${NEXT_URL}/dashboard`)
    expect(attempts).toBe(1)
    expect(await tulaCookieNames(context)).toEqual(['tula_at', 'tula_rt'])

    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await expectAccessible(page, `Next.js: sign-out failed dialog (${colorScheme})`)
    }
    await page.emulateMedia({ colorScheme: 'light' })

    // Trying again while it still fails: still here, still said, nothing navigated.
    await dialog(page).getByRole('button', { name: 'Try again' }).click()
    await expect.poll(() => attempts).toBe(2)
    await expect(dialog(page).getByRole('alert')).toContainText('may still be signed in')
    await expect(dialog(page).getByRole('button', { name: 'Try again' })).not.toHaveAttribute(
      'aria-disabled',
      'true'
    )
    await expect(page).toHaveURL(`${NEXT_URL}/dashboard`)
    expect(await tulaCookieNames(context)).toEqual(['tula_at', 'tula_rt'])

    // What the dialog says is true: the server still sees the user, and so does a reload.
    const whoami = await page.request.get('/api/whoami')
    expect(whoami.status()).toBe(200)
    await page.reload()
    await expect(page).toHaveURL(`${NEXT_URL}/dashboard`)
    await expect(page.getByRole('heading', { name: 'Hello, Maya' })).toBeVisible()
    await expect(page.getByTestId('server-email')).toHaveText(email)
    await expect(page.getByRole('button', { name: /^Account menu for/ })).toBeVisible()
    await expect(dialog(page)).toBeHidden()

    // Once more; this time the dialog is closed. The control that asked is gone, so the focus
    // goes to the page's first control, and one Tab moves on to the next one (the header now
    // shows its signed-out side).
    await pressSignOut(page)
    await expect(dialog(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog(page)).toBeHidden()
    await expect(page.getByRole('link', { name: 'Northline' })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(
      page.getByRole('navigation', { name: 'Account' }).getByRole('link', { name: 'Sign in' })
    ).toBeFocused()
    await expect(page).toHaveURL(`${NEXT_URL}/dashboard`)
    expect(await tulaCookieNames(context)).toEqual(['tula_at', 'tula_rt'])

    // And once more, with the network back before "Try again": signed out here and on the
    // server, on the after-sign-out page, with every cookie gone.
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Hello, Maya' })).toBeVisible()
    await pressSignOut(page)
    await expect(dialog(page)).toBeVisible()
    await page.unroute(SIGN_OUT)
    await dialog(page).getByRole('button', { name: 'Try again' }).click()
    await expect(page).toHaveURL(`${NEXT_URL}/`)
    await expect(page.getByRole('link', { name: 'Create an account' })).toBeVisible()
    await expect(dialog(page)).toBeHidden()
    expect(await tulaCookieNames(context)).toEqual([])

    expect((await page.request.get('/api/whoami')).status()).toBe(401)
    await page.reload()
    await expect(page.getByRole('link', { name: 'Create an account' })).toBeVisible()
    await page.goto('/dashboard')
    await expect(page).toHaveURL(`${NEXT_URL}/sign-in?redirect_url=%2Fdashboard`)
  })
}
