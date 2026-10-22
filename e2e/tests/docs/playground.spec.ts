import { expect, type Locator, type Page, test } from '@playwright/test'
import { resolveBase } from '../../../apps/docs/src/lib/paths'
import { expectAccessible } from '../support'

// The live component playground (apps/docs/src/playground): the sign-in, sign-up and account
// components of @tula-tech/react running against a sandbox in the page. Each method page has
// one with its preset; /playground/ has the full one. These tests drive the journeys a reader
// is invited to try (including the ways they fail), the configuration panel and the copied
// code, and hold what the page costs a reader who never opens a playground.

const BASE = resolveBase()
const PASSWORD = 'Sandbox-pass-42!'

/** A route of the site as the address it is served at. */
function at(route: string): string {
  return `${BASE.slice(0, -1)}${route}`
}

/** What a playground page must never do: log an error, throw or fail a request. */
function watch(page: Page): string[] {
  const problems: string[] = []
  page.on('pageerror', (error) => problems.push(`uncaught: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') {
      problems.push(`console: ${message.text()}`)
    }
  })
  page.on('requestfailed', (request) =>
    problems.push(`request failed: ${request.url()} ${request.failure()?.errorText}`)
  )
  page.on('response', (response) => {
    if (response.status() >= 400) {
      problems.push(`${response.status()}: ${response.url()}`)
    }
  })
  return problems
}

/** Open a page with a playground and wait until the island has drawn it. */
async function open(page: Page, route: string): Promise<{ frame: Locator; problems: string[] }> {
  const problems = watch(page)
  await page.goto(at(route))
  const host = page.locator('[data-playground]').first()
  await host.scrollIntoViewIfNeeded()
  await expect(host).toHaveAttribute('data-state', 'ready')
  const frame = page.locator('.pg-frame')
  await expect(frame.getByRole('heading').first()).toBeVisible()
  return { frame, problems }
}

/** The first text field of the component (the identifier, the code, the password). */
function field(frame: Locator, name: string | RegExp): Locator {
  return frame.getByRole('textbox', { name })
}

/** Type an address into the sign-in screen and go on. */
async function startSignIn(frame: Locator, email: string): Promise<void> {
  await field(frame, 'Email address').fill(email)
  await frame.getByRole('button', { name: 'Continue' }).click()
}

/** Open a tab of the sandbox tools under the frame. */
async function tool(page: Page, name: RegExp | string): Promise<void> {
  await page.getByRole('tab', { name }).click()
}

/** The newest code in the sandbox inbox. */
async function inboxCode(page: Page): Promise<string> {
  await tool(page, /^Inbox/)
  const code = page.locator('.pg-mails .pg-mail-code code').first()
  await expect(code).toBeVisible()
  return (await code.textContent()) ?? ''
}

/** The account screen shows the signed-in address. */
async function expectSignedIn(frame: Locator, email: string): Promise<void> {
  await expect(frame.getByText(email).first()).toBeVisible()
  await expect(frame.getByRole('button', { name: /sign out/i }).first()).toBeVisible()
}

test.describe('the playground: journeys', () => {
  test('password: a wrong password is refused the same way, the right one signs in', async ({
    page,
  }) => {
    const { frame, problems } = await open(page, '/methods/password/')
    await startSignIn(frame, 'ada@example.test')
    await field(frame, 'Password').fill('not-the-password-1')
    await frame.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(frame.getByRole('alert')).toBeVisible()
    await field(frame, 'Password').fill(PASSWORD)
    await frame.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expectSignedIn(frame, 'ada@example.test')
    expect(problems).toEqual([])
  })

  test('password: an address with no account gets the same refusal', async ({ page }) => {
    const { frame } = await open(page, '/methods/password/')
    await startSignIn(frame, 'nobody@example.test')
    await field(frame, 'Password').fill('whatever-password-1')
    await frame.getByRole('button', { name: 'Sign in', exact: true }).click()
    const known = await frame.getByRole('alert').innerText()
    await page.getByRole('button', { name: 'Reset sandbox' }).click()
    await startSignIn(frame, 'ada@example.test')
    await field(frame, 'Password').fill('whatever-password-1')
    await frame.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(frame.getByRole('alert')).toHaveText(known)
  })

  test('password: five wrong passwords lock the address for a while', async ({ page }) => {
    const { frame } = await open(page, '/methods/password/')
    await startSignIn(frame, 'ada@example.test')
    const submit = frame.getByRole('button', { name: 'Sign in', exact: true })
    await field(frame, 'Password').fill('wrong-password-1')
    await submit.click()
    await expect(frame.getByRole('alert')).toHaveText(/incorrect/i)
    for (let attempt = 0; attempt < 4; attempt++) {
      await field(frame, 'Password').fill('wrong-password-1')
      await submit.click()
      await expect(frame.getByRole('alert')).toHaveText(/incorrect/i)
    }
    // The sixth try is not judged: the address has to wait, and the screen says for how long.
    await field(frame, 'Password').fill(PASSWORD)
    await submit.click()
    await expect(frame.getByRole('alert')).toHaveText(/too many requests.*\d+s/i)
    await expect(frame.getByRole('button', { name: /sign out/i })).toHaveCount(0)
  })

  test('password: forgot password sends a code to the inbox and sets a new password', async ({
    page,
  }) => {
    const { frame } = await open(page, '/methods/password/')
    await startSignIn(frame, 'ada@example.test')
    await frame.getByRole('button', { name: 'Forgot password?' }).click()
    await field(frame, 'Email address').fill('ada@example.test')
    await frame.getByRole('button', { name: 'Send code' }).click()
    const code = await inboxCode(page)
    expect(code).toMatch(/^\d{6}$/)
    await field(frame, 'Verification code').fill(code)
    await frame.getByLabel('New password', { exact: true }).fill('A-brand-new-pass-77!')
    await frame.getByRole('button', { name: 'Reset password' }).click()
    // A reset signs in. After signing out the old password no longer works, the new one does.
    await expectSignedIn(frame, 'ada@example.test')
    await frame
      .getByRole('button', { name: /sign out/i })
      .first()
      .click()
    await startSignIn(frame, 'ada@example.test')
    await field(frame, 'Password').fill(PASSWORD)
    await frame.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(frame.getByRole('alert')).toBeVisible()
    await field(frame, 'Password').fill('A-brand-new-pass-77!')
    await frame.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expectSignedIn(frame, 'ada@example.test')
  })

  test('email code: a wrong code, an expired code, then the right one', async ({ page }) => {
    const { frame } = await open(page, '/methods/email-code/')
    await startSignIn(frame, 'ada@example.test')
    const code = await inboxCode(page)
    const input = field(frame, 'Verification code')
    const submit = frame.getByRole('button', { name: 'Sign in', exact: true })
    await input.fill(code === '000000' ? '111111' : '000000')
    await submit.click()
    await expect(frame.getByRole('alert')).toBeVisible()
    const alert = await frame.getByRole('alert').innerText()
    await page.getByLabel('Treat this message as expired').check()
    await input.fill(code)
    await submit.click()
    await expect(frame.getByRole('alert')).not.toHaveText(alert)
    await page.getByLabel('Treat this message as expired').uncheck()
    await input.fill(code)
    await submit.click()
    await expectSignedIn(frame, 'ada@example.test')
  })

  test('email link: opened in this browser it signs in; in another it only proves the link', async ({
    page,
  }) => {
    const { frame } = await open(page, '/methods/email-link/')
    await startSignIn(frame, 'ada@example.test')
    await frame.getByRole('button', { name: 'Email me a link' }).click()
    await tool(page, /^Inbox/)
    await page.getByRole('button', { name: 'Open in another browser' }).first().click()
    await expect(page.getByText('A different browser: it has no sign-in waiting')).toBeVisible()
    await expect(frame.getByRole('button', { name: /sign out/i })).toHaveCount(0)
    // A link is for one use: start over to open it in the browser that asked.
    await page.getByRole('button', { name: 'Reset sandbox' }).click()
    await startSignIn(frame, 'ada@example.test')
    await frame.getByRole('button', { name: 'Email me a link' }).click()
    await tool(page, /^Inbox/)
    await page.getByRole('button', { name: 'Open link in this browser' }).first().click()
    // The sign-in that is waiting in the component finishes by itself once the link is proven.
    await expectSignedIn(frame, 'ada@example.test')
  })

  test('OAuth: approving on the sandbox consent screen signs in; declining shows the error', async ({
    page,
  }) => {
    const { frame, problems } = await open(page, '/methods/oauth/')
    await frame.getByRole('button', { name: /google/i }).click()
    await expect(frame.getByText('Sandbox consent screen')).toBeVisible()
    await frame.getByRole('button', { name: 'Cancel' }).click()
    await expect(frame.getByText('Sign-in was cancelled').first()).toBeVisible()
    await page.getByRole('button', { name: 'Back to the app' }).click()
    await frame.getByRole('button', { name: /github/i }).click()
    await frame.getByRole('button', { name: 'Approve' }).click()
    await expectSignedIn(frame, 'ada@example.test')
    expect(problems).toEqual([])
  })

  test('passkeys: the sheet says it is simulated and the browser API is never called', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const calls: string[] = []
      Object.defineProperty(window, '__credentialCalls', { value: calls })
      const credentials = navigator.credentials
      for (const name of ['get', 'create'] as const) {
        const original = credentials[name].bind(credentials)
        credentials[name] = (...args: unknown[]) => {
          calls.push(name)
          return (original as (...rest: unknown[]) => Promise<Credential | null>)(...args)
        }
      }
    })
    const { frame } = await open(page, '/methods/passkeys/')
    await startSignIn(frame, 'ada@example.test')
    await field(frame, 'Password').fill(PASSWORD)
    await frame.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expectSignedIn(frame, 'ada@example.test')
    await frame.getByRole('button', { name: /add a passkey|add passkey/i }).click()
    await expect(page.getByText('Simulated authenticator')).toBeVisible()
    await page.locator('.pg-sheet').getByRole('button').first().click()
    await expect(page.locator('.pg-sheet')).toHaveCount(0)
    const calls = await page.evaluate(
      () => (window as unknown as { __credentialCalls: string[] }).__credentialCalls
    )
    expect(calls).toEqual([])
  })

  test('two-step verification: the authenticator code of Grace comes from the sandbox', async ({
    page,
  }) => {
    const { frame } = await open(page, '/methods/two-step-verification/')
    await startSignIn(frame, 'grace@example.test')
    await field(frame, 'Password').fill(PASSWORD)
    await frame.getByRole('button', { name: 'Sign in', exact: true }).click()
    const input = field(frame, 'Authentication code')
    await input.fill('000000')
    await frame.getByRole('button', { name: 'Verify' }).click()
    await expect(frame.getByRole('alert')).toBeVisible()
    await tool(page, 'Accounts and codes')
    const totp = (await page.locator('.pg-totp code').first().textContent()) ?? ''
    expect(totp).toMatch(/^\d{6}$/)
    await input.fill(totp)
    await frame.getByRole('button', { name: 'Verify' }).click()
    await expectSignedIn(frame, 'grace@example.test')
  })
})

test.describe('the playground: configuration and code', () => {
  test('a switch changes the component and the copied code and config', async ({ page }) => {
    const { frame } = await open(page, '/playground/')
    await expect(frame.getByRole('button', { name: /email me a code/i })).toHaveCount(0)
    await page.getByRole('switch', { name: /^Passkey/ }).click()
    await expect(frame.getByRole('button', { name: /passkey/i }).first()).toBeVisible()
    await page.getByRole('tab', { name: 'Config' }).click()
    await expect(page.locator('.pg-code')).toContainText('passkey')
    await page.getByRole('tab', { name: 'React' }).click()
    await expect(page.locator('.pg-code')).toContainText('<SignIn')
  })

  test('a brand colour reaches the component and the CSS block', async ({ page }) => {
    const { frame } = await open(page, '/playground/')
    await page.getByRole('radio', { name: 'Forest' }).click()
    await expect(frame.getByRole('button', { name: 'Continue' }).first()).not.toHaveCSS(
      'background-color',
      'rgb(26, 26, 24)'
    )
    await page.getByRole('tab', { name: 'CSS' }).click()
    await expect(page.locator('.pg-code')).toContainText('--tula-')
  })

  test('the screens: sign up and account are reachable', async ({ page }) => {
    const { frame } = await open(page, '/playground/')
    await page.getByRole('radio', { name: 'Sign up' }).click()
    await expect(frame.getByRole('heading', { name: /create|sign up/i }).first()).toBeVisible()
    await page.getByRole('radio', { name: 'Account' }).click()
    await frame.getByRole('button', { name: 'Sign in as the demo account' }).click()
    await expectSignedIn(frame, 'ada@example.test')
  })

  test('copy puts the whole file on the clipboard', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await open(page, '/playground/')
    await page.locator('.pg').getByRole('button', { name: /^Copy/ }).first().click()
    const text = await page.evaluate(() => navigator.clipboard.readText())
    expect(text).toContain('@tula-tech/react')
  })
})

test.describe('the playground: what a page costs', () => {
  /** The scripts and stylesheets a route loads, by name and size. */
  async function assetsOf(page: Page, route: string): Promise<{ name: string; bytes: number }[]> {
    const seen: { name: string; bytes: number }[] = []
    page.on('response', async (response) => {
      const type = response.request().resourceType()
      if (type === 'script' || type === 'stylesheet') {
        const body = await response.body().catch(() => Buffer.alloc(0))
        seen.push({ name: new URL(response.url()).pathname, bytes: body.length })
      }
    })
    await page.goto(at(route))
    await page.waitForLoadState('networkidle')
    return seen
  }

  test('a page with no playground loads no playground script, style or chunk', async ({ page }) => {
    const assets = await assetsOf(page, '/quickstart/')
    expect(assets.length).toBeGreaterThan(0)
    expect(assets.filter((one) => /playground|mount-/.test(one.name))).toEqual([])
    // The site script is the one every page loads (13.9 KB on develop at the merge, 6.8 KB before
    // the native gallery); the playground adds nothing to it, so the bound sits just above.
    const script = assets.find((one) => /\/main-[^/]*\.js$/.test(one.name))
    expect(script, 'the site script is loaded').toBeDefined()
    expect(script?.bytes).toBeLessThan(14500)
  })

  test('nothing of the sandbox is written to web storage', async ({ page }) => {
    const { frame } = await open(page, '/methods/oauth/')
    await startSignIn(frame, 'ada@example.test')
    await field(frame, 'Password').fill(PASSWORD)
    await frame.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expectSignedIn(frame, 'ada@example.test')
    await frame
      .getByRole('button', { name: /sign out/i })
      .first()
      .click()
    await frame.getByRole('button', { name: /google/i }).click()
    await frame.getByRole('button', { name: 'Approve' }).click()
    await expectSignedIn(frame, 'ada@example.test')
    const keys = await page.evaluate(() => [
      ...Object.keys(localStorage),
      ...Object.keys(sessionStorage),
    ])
    // The site's own choices (theme, tabs) may be there; the sandbox's tokens and bindings not.
    expect(
      keys.filter((key) => /tula\.|sbx|token|session/i.test(key) && !/^tula-docs-/.test(key))
    ).toEqual([])
  })

  test('a page with a playground loads the island only when it is near', async ({ page }) => {
    const assets = await assetsOf(page, '/methods/password/')
    expect(assets.some((one) => /playground/.test(one.name))).toBe(true)
    expect(assets.some((one) => /mount-/.test(one.name))).toBe(false)
    await page.locator('[data-playground]').first().scrollIntoViewIfNeeded()
    await expect(page.locator('[data-playground]').first()).toHaveAttribute('data-state', 'ready')
  })
})

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`the playground in ${scheme}`, () => {
    for (const width of [390, 1440]) {
      test(`has no sideways scroll and no violation at ${width} px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 })
        await page.emulateMedia({ colorScheme: scheme })
        const { problems } = await open(page, '/playground/')
        await expect(page.locator('html')).toHaveAttribute('data-theme', scheme)
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth
        )
        expect(overflow).toBe(0)
        await expectAccessible(page, `playground at ${width} (${scheme})`)
        expect(problems).toEqual([])
      })
    }

    test('is accessible with the consent screen, the inbox and the account open', async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme })
      const { frame } = await open(page, '/playground/')
      await page.getByRole('radio', { name: 'Account' }).click()
      await frame.getByRole('button', { name: 'Sign in as the demo account' }).click()
      await expectSignedIn(frame, 'ada@example.test')
      await tool(page, 'Accounts and codes')
      // The site's header is sticky: leave the account's buttons clear of it, as a reader would.
      await page.locator('.pg-stage').evaluate((node) => {
        node.scrollIntoView({ block: 'start' })
        window.scrollBy(0, -120)
      })
      await expectAccessible(page, `playground account (${scheme})`)
    })

    test('the OAuth consent screen is accessible', async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme })
      const { frame } = await open(page, '/methods/oauth/')
      await frame.getByRole('button', { name: /google/i }).click()
      await expect(frame.getByText('Sandbox consent screen')).toBeVisible()
      await expectAccessible(page, `playground consent (${scheme})`)
    })
  })
}
