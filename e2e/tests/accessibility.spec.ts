import { expect, type Page, test } from '@playwright/test'
import {
  advanceClock,
  emailCount,
  expectAccessible,
  latestCode,
  PASSWORD,
  resetLimits,
  signUp,
  uniqueEmail,
  useProviders,
} from './support'

// axe on every screen and state the components can show against the real API, in both colour
// schemes. No rule is disabled (see `expectAccessible`).

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme })

    test.beforeEach(async ({ request }) => {
      await resetLimits(request)
    })

    test('sign-up: empty, checklist in progress, field errors, the emailed code and a wrong code', async ({
      page,
      request,
    }) => {
      const email = uniqueEmail('axe.up')
      await page.goto('/sign-up')
      await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible()
      await expect(page.getByText('10 or more characters')).toBeVisible()
      await expectAccessible(page, 'sign-up, empty')

      await page.getByRole('button', { name: 'Continue' }).click()
      await expect(page.getByRole('alert')).toHaveCount(2)
      await expectAccessible(page, 'sign-up, required fields missing')

      await page.getByLabel('Email address').fill(email)
      await page.getByLabel('Password', { exact: true }).fill('password1')
      await expectAccessible(page, 'sign-up, checklist partly met')
      await page.getByRole('button', { name: 'Show password' }).click()
      await page.getByRole('button', { name: 'Continue' }).click()
      await expect(page.getByRole('alert')).toBeVisible()
      await expectAccessible(page, 'sign-up, password refused by the server')

      await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
      await page.getByRole('button', { name: 'Continue' }).click()
      await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
      await expectAccessible(page, 'verification, empty')

      const code = await latestCode(request, email)
      await page.getByLabel('Verification code').fill(code === '000000' ? '000001' : '000000')
      await page.getByRole('button', { name: 'Verify' }).click()
      await expect(page.getByRole('alert')).toContainText('attempts left')
      await page.getByRole('button', { name: 'Resend code' }).click()
      await expect(page.getByRole('button', { name: /Resend code in/ })).toBeVisible()
      await expectAccessible(page, 'verification, wrong code and resend cooldown')
    })

    test('sign-in: email, password, a wrong password, forgotten password and its new-password screen', async ({
      page,
      request,
    }) => {
      const email = uniqueEmail('axe.in')
      await signUp(page, request, { email, firstName: 'Axel' })
      await page.getByRole('button', { name: /^Account menu for/ }).click()
      await page.getByRole('menuitem', { name: 'Sign out' }).click()
      await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
      await expect(page.getByText(/^to continue to/)).toBeVisible()
      await expectAccessible(page, 'sign-in, email')

      await page.getByLabel('Email address').fill(email)
      await page.getByRole('button', { name: 'Continue' }).click()
      await expect(page.getByRole('heading', { name: 'Enter your password' })).toBeVisible()
      await expectAccessible(page, 'sign-in, password')

      await page.getByLabel('Password', { exact: true }).fill('not-the-password-at-all')
      await page.getByRole('button', { name: 'Sign in' }).click()
      await expect(page.getByRole('alert')).toBeVisible()
      await expectAccessible(page, 'sign-in, wrong password')

      await resetLimits(request)
      const before = await emailCount(request, email)
      await page.getByRole('button', { name: 'Forgot password?' }).click()
      await expect(page.getByRole('heading', { name: 'Reset your password' })).toBeVisible()
      await expectAccessible(page, 'reset, email')
      await page.getByRole('button', { name: 'Send code' }).click()
      await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible()
      await latestCode(request, email, before)
      await page.getByLabel('New password', { exact: true }).fill('short')
      await expectAccessible(page, 'reset, code and new password')
      await page.getByRole('button', { name: 'Reset password' }).click()
      await expect(page.getByRole('alert')).toHaveCount(1)
      await expectAccessible(page, 'reset, code missing')
    })

    test('signed in: home, the user menu, the account dialog and the account page', async ({
      page,
      request,
      browser,
    }) => {
      const email = uniqueEmail('axe.me')
      await signUp(page, request, { email, firstName: 'Axel' })
      await expectAccessible(page, 'home, signed in')

      await page.getByRole('button', { name: /^Account menu for/ }).click()
      await expect(page.getByRole('menu')).toBeVisible()
      await expectAccessible(page, 'user menu open')

      await page.getByRole('menuitem', { name: 'Manage account' }).click()
      await expect(page.getByRole('dialog', { name: 'Account' })).toBeVisible()
      await expect(page.locator('[data-tula-element="sessionItem"]')).toHaveCount(1)
      await expectAccessible(page, 'account dialog')
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(page.getByRole('button', { name: /^Account menu for/ })).toBeFocused()

      // A second device, so the list has a row with a sign-out button.
      const other = await browser.newContext()
      const second = await other.newPage()
      await second.goto('/sign-in')
      await second.getByLabel('Email address').fill(email)
      await second.getByRole('button', { name: 'Continue' }).click()
      await second.getByLabel('Password', { exact: true }).fill(PASSWORD)
      await second.getByRole('button', { name: 'Sign in' }).click()
      await expect(second.getByRole('heading', { name: /^Hello/ })).toBeVisible()

      await page.getByRole('link', { name: 'Manage your account' }).click()
      await expect(page.locator('[data-tula-element="sessionItem"]')).toHaveCount(2)
      await expectAccessible(page, 'account page, two devices')

      await page.getByLabel('Current password', { exact: true }).fill('not-the-password-at-all')
      await page.getByLabel('New password', { exact: true }).fill('short')
      await page.getByRole('button', { name: 'Update password' }).click()
      await expect(page.getByRole('alert')).toBeVisible()
      await expectAccessible(page, 'account page, password change refused')
      await other.close()
    })

    test('signed out: the landing page', async ({ page }) => {
      await page.goto('/')
      await expect(page.getByRole('heading', { name: 'Northline' })).toBeVisible()
      await expectAccessible(page, 'landing')
    })
  })
}

/**
 * Change the colour scheme under an open page, as the operating system does at dusk, and
 * measure every button's label against its background from the first frame until well after
 * any transition has ended.
 *
 * @returns The samples whose contrast is under 4.5:1 (WCAG AA for text).
 */
async function unreadableAfterFlip(page: Page, colorScheme: 'light' | 'dark') {
  await page.emulateMedia({ colorScheme })
  return page.evaluate(async (scheme) => {
    const channel = (value: number) => {
      const c = value / 255
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    }
    const luminance = (color: string) => {
      const parts = /^rgba?\(([\d.]+), ([\d.]+), ([\d.]+)(?:, ([\d.]+))?\)$/.exec(color)
      // Anything that is not an opaque rgb colour is reported as unreadable, not skipped.
      if (!parts || (parts[4] !== undefined && Number(parts[4]) < 1)) {
        return null
      }
      const [r, g, b] = [parts[1], parts[2], parts[3]].map((part) => channel(Number(part)))
      return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0)
    }
    const bad: { scheme: string; at: string; button: string; ratio: number }[] = []
    let measured = 0
    const measure = (at: string) => {
      const buttons = document.querySelectorAll<HTMLElement>(
        '.tula-primary-button, .tula-secondary-button'
      )
      for (const button of buttons) {
        if (button.getAttribute('aria-disabled') === 'true' || button.offsetParent === null) {
          continue
        }
        const label = button.querySelector<HTMLElement>('span') ?? button
        const text = luminance(getComputedStyle(label).color)
        const background = luminance(getComputedStyle(button).backgroundColor)
        const ratio =
          text === null || background === null
            ? 0
            : (Math.max(text, background) + 0.05) / (Math.min(text, background) + 0.05)
        measured += 1
        if (ratio < 4.5) {
          bad.push({
            scheme,
            at,
            button: (button.textContent ?? '').trim(),
            ratio: Math.round(ratio * 100) / 100,
          })
        }
      }
    }
    const started = performance.now()
    // Every frame for 300 ms (a transition would be caught part-way), then once settled.
    while (performance.now() - started < 300) {
      measure(`${Math.round(performance.now() - started)}ms`)
      await new Promise((resolve) => requestAnimationFrame(resolve))
    }
    await new Promise((resolve) => setTimeout(resolve, 400))
    measure('settled')
    return { bad, measured }
  }, colorScheme)
}

test.describe('a colour scheme that changes while the page is open', () => {
  test.beforeEach(async ({ request }) => {
    await resetLimits(request)
    await useProviders(request, ['google', 'github'])
  })
  test.afterEach(async ({ request }) => {
    await useProviders(request)
  })

  /** Light to dark to light to dark, without a reload: no button is unreadable at any sample. */
  async function expectReadableThroughFlips(page: Page, screen: string, atLeast: number) {
    await page.emulateMedia({ colorScheme: 'light' })
    for (const colorScheme of ['dark', 'light', 'dark'] as const) {
      const { bad, measured } = await unreadableAfterFlip(page, colorScheme)
      expect(bad, `${screen}: buttons under 4.5:1 after a live change to ${colorScheme}`).toEqual(
        []
      )
      // The check measured something: the buttons this screen is known to have, every frame.
      expect(measured).toBeGreaterThanOrEqual(atLeast)
    }
    await expectAccessible(page, `${screen}, after live scheme changes (dark)`)
    await page.emulateMedia({ colorScheme: 'light' })
  }

  test('sign-in with provider buttons, the profile and the step-up dialog stay readable', async ({
    page,
    request,
  }) => {
    await page.goto('/sign-in')
    await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible()
    // Two provider buttons (secondary) and Continue (primary).
    await expectReadableThroughFlips(page, 'sign-in', 3)
    // The same with the pointer resting on a button, as it does right after a click.
    await page.getByRole('button', { name: 'Continue', exact: true }).hover()
    await expectReadableThroughFlips(page, 'sign-in, Continue hovered', 3)
    await page.getByRole('button', { name: 'Continue with Google' }).hover()
    await expectReadableThroughFlips(page, 'sign-in, a provider button hovered', 3)

    const email = uniqueEmail('axe.flip')
    await signUp(page, request, { email })
    await page.goto('/account')
    await expect(page.getByRole('heading', { name: 'Connected accounts' })).toBeVisible()
    await expectReadableThroughFlips(page, 'profile', 3)

    await advanceClock(request, 11 * 60_000)
    await page
      .getByRole('region', { name: 'Account' })
      .locator('section', { has: page.getByRole('heading', { name: 'Two-step verification' }) })
      .getByRole('button', { name: 'Turn on' })
      .click()
    await expect(page.getByRole('dialog', { name: 'Confirm it is you' })).toBeVisible()
    // Continue (primary) and Cancel (secondary) in the dialog, above the profile's own.
    await expectReadableThroughFlips(page, 'step-up dialog', 5)
  })
})
