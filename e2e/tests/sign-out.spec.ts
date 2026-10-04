import { type BrowserContext, expect, type Page, type Route, test } from '@playwright/test'
import { API_URL, expectAccessible, resetLimits, signUp, uniqueEmail } from './support'

// A sign-out the server was not told about (ADR 0022): `@tula/core` signs the client out
// locally and throws, the components navigate nowhere, and the provider says in a dialog that
// the session may still be active. The failure is made in the browser (`page.route`), so the
// fixture's API behaves as it always does and still holds the session.

const APP_URL = 'http://localhost:4317'
const SIGN_OUT = `${API_URL}/v1/client/sessions/sign-out`

test.beforeEach(async ({ request }) => {
  await resetLimits(request)
})

/** How the sign-out request fails: no answer at all, or an answer that is not a sign-out. */
const FAILURES: [string, (route: Route) => Promise<void>][] = [
  ['the request gets no answer', (route) => route.abort('connectionfailed')],
  [
    'the server answers 503',
    (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        // The API is another origin here: without these the browser hides the answer and the
        // case would be the first one again.
        headers: {
          'access-control-allow-origin': APP_URL,
          'access-control-allow-credentials': 'true',
        },
        body: JSON.stringify({
          status: 503,
          code: 'service.unavailable',
          detail: 'The service is unavailable.',
        }),
      }),
  ],
]

/** The API's refresh cookie, which only a sign-out that reached the server removes. */
async function refreshCookies(context: BrowserContext) {
  // Every cookie of the context: this one is scoped to a path, which a URL filter would miss.
  const cookies = await context.cookies()
  return cookies.filter((cookie) => cookie.name.includes('tula_rt'))
}

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Sign-out did not finish' })

async function pressSignOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Account menu for/ }).click()
  await page.getByRole('menuitem', { name: 'Sign out' }).click()
}

for (const [name, fail] of FAILURES) {
  test(`sign out when ${name}: no navigation, a dialog, still signed in after a reload, and trying again finishes it`, async ({
    page,
    request,
    context,
  }) => {
    const email = uniqueEmail('sign-out-failed')
    await signUp(page, request, { email, firstName: 'Maya' })
    expect(await refreshCookies(context)).toHaveLength(1)

    let attempts = 0
    await page.route(SIGN_OUT, async (route) => {
      // The preflight of a cross-origin request is not the sign-out.
      if (route.request().method() === 'POST') {
        attempts += 1
      }
      await fail(route)
    })
    await pressSignOut(page)

    // The dialog, announced as an alert, with the focus on its title. Nothing navigated: the
    // app's after-sign-out page is /sign-in.
    await expect(dialog(page)).toBeVisible()
    await expect(dialog(page).getByRole('alert')).toContainText('may still be signed in')
    await expect(
      dialog(page).getByRole('heading', { name: 'Sign-out did not finish' })
    ).toBeFocused()
    await expect(page).toHaveURL(`${APP_URL}/`)
    expect(attempts).toBe(1)
    expect(await refreshCookies(context)).toHaveLength(1)

    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await expectAccessible(page, `sign-out failed dialog (${colorScheme})`)
    }
    await page.emulateMedia({ colorScheme: 'light' })

    // The page behind a modal dialog is inert: Tab stays among its two buttons.
    await page.keyboard.press('Tab')
    await expect(dialog(page).getByRole('button', { name: 'Try again' })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(dialog(page).getByRole('button', { name: 'Close' })).toBeFocused()

    // Trying again while it still fails: still here, still said, the button usable again.
    await dialog(page).getByRole('button', { name: 'Try again' }).click()
    await expect.poll(() => attempts).toBe(2)
    await expect(dialog(page).getByRole('alert')).toContainText('may still be signed in')
    await expect(dialog(page).getByRole('button', { name: 'Try again' })).not.toHaveAttribute(
      'aria-disabled',
      'true'
    )
    await expect(page).toHaveURL(`${APP_URL}/`)

    // Escape closes it. The control that asked went with the signed-in header, so there is
    // nothing to hand the focus back to: it goes to the page's first control (left on the
    // document, Chromium's next Tab would not reach it), and the page behind is no longer
    // inert: one Tab moves on to the next control.
    await page.keyboard.press('Escape')
    await expect(dialog(page)).toBeHidden()
    await expect(page).toHaveURL(`${APP_URL}/`)
    await expect(page.getByRole('link', { name: 'Northline' })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(page.getByRole('combobox', { name: 'Theme' })).toBeFocused()

    // The claim the dialog made is true: the server still holds the session and the browser
    // its cookie, so a reload is signed in again.
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Hello, Maya' })).toBeVisible()

    // Once more, and this time the network comes back before "Try again".
    await pressSignOut(page)
    await expect(dialog(page)).toBeVisible()
    await page.unroute(SIGN_OUT)
    await dialog(page).getByRole('button', { name: 'Try again' }).click()
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
    await expect(page).toHaveURL(`${APP_URL}/sign-in`)
    await expect(dialog(page)).toBeHidden()
    expect(await refreshCookies(context)).toEqual([])

    await page.reload()
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  })
}

test('a failed sign-out from the account page: the dialog, and "Close" leaves the visitor where the app puts a signed-out one', async ({
  page,
  request,
  context,
}) => {
  const email = uniqueEmail('sign-out-failed-profile')
  await signUp(page, request, { email })
  await page.getByRole('link', { name: 'Manage your account' }).click()
  await expect(page.getByRole('heading', { name: 'Account', exact: true })).toBeVisible()

  await page.route(SIGN_OUT, (route) => route.abort('connectionfailed'))
  await page.getByRole('button', { name: 'Sign out', exact: true }).last().click()
  await expect(dialog(page)).toBeVisible()
  await expect(dialog(page).getByRole('alert')).toContainText('may still be signed in')
  expect(await refreshCookies(context)).toHaveLength(1)

  await dialog(page).getByRole('button', { name: 'Close' }).click()
  await expect(dialog(page)).toBeHidden()
  expect(await refreshCookies(context)).toHaveLength(1)
  // Here the dialog had an opener that is still on the page: the app sent the signed-out
  // visitor to its sign-in page and put the focus on the new content before the request
  // failed. "Close" gives the focus back to it, as a dialog does.
  await expect(page.getByRole('main')).toBeFocused()

  // Still signed in as far as the server goes: a reload of the account page shows it again.
  await page.unroute(SIGN_OUT)
  await page.goto('/account')
  await expect(page.getByRole('heading', { name: 'Account', exact: true })).toBeVisible()
  await expect(page.getByText(email).first()).toBeVisible()
})
