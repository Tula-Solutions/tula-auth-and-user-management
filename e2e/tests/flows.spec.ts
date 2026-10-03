import { expect, type Page, type Request, test } from '@playwright/test'
import {
  emailCount,
  latestCode,
  NEW_PASSWORD,
  PASSWORD,
  resetLimits,
  signIn,
  signOut,
  signUp,
  uniqueEmail,
} from './support'

test.beforeEach(async ({ request }) => {
  await resetLimits(request)
})

/** Every request the page makes, to check afterwards what did (not) travel in a URL. */
function recordRequests(page: Page): Request[] {
  const requests: Request[] = []
  page.on('request', (request) => requests.push(request))
  return requests
}

test('sign up, verify the emailed code, signed in; sign out; sign in again', async ({
  page,
  request,
}) => {
  const requests = recordRequests(page)
  const problems: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      problems.push(message.text())
    }
  })
  page.on('pageerror', (error) => problems.push(String(error)))
  // A request that got its answer must not show as failed: the client reads a 204's empty
  // body, which is what keeps Chromium from recording sign-out as `net::ERR_ABORTED`.
  const failed: string[] = []
  page.on('requestfailed', (sent) => {
    failed.push(`${sent.method()} ${new URL(sent.url()).pathname}: ${sent.failure()?.errorText}`)
  })

  const email = uniqueEmail('maya')
  await signUp(page, request, { email, firstName: 'Maya' })
  await expect(page.getByRole('heading', { name: 'Hello, Maya' })).toBeVisible()
  await expect(page).toHaveURL('/')

  // The session survives a reload: it is restored from the httpOnly cookie.
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Hello, Maya' })).toBeVisible()

  await signOut(page)
  await expect(page).toHaveURL('/sign-in')
  await signIn(page, email)
  await expect(page.getByRole('heading', { name: 'Hello, Maya' })).toBeVisible()

  // Nothing secret in a URL, and nothing at all in web storage.
  for (const sent of requests) {
    expect(sent.url()).not.toContain(PASSWORD)
    expect(sent.url()).not.toMatch(/eyJ|tula_rt_|tula_at_/)
  }
  expect(await page.evaluate(() => window.localStorage.length + window.sessionStorage.length)).toBe(
    0
  )
  // The refresh cookie exists and JavaScript cannot read it.
  const cookies = await page.context().cookies('http://localhost:4318/v1/client/sessions')
  expect(cookies.filter((cookie) => cookie.name.startsWith('tula_rt_'))).toMatchObject([
    { httpOnly: true, sameSite: 'Lax' },
  ])
  expect(await page.evaluate(() => document.cookie)).toBe('')
  expect(failed).toEqual([])
  // A fresh visitor's first refresh answers 401 by design; the browser logs that one line.
  expect(problems.filter((line) => !line.includes('401'))).toEqual([])
})

test('a wrong password is refused with the generic message, on the password field', async ({
  page,
  request,
}) => {
  const email = uniqueEmail('wrong')
  await signUp(page, request, { email })
  await signOut(page)
  await signIn(page, email, 'not-the-password-at-all')
  const field = page.getByLabel('Password', { exact: true })
  await expect(page.getByRole('alert')).toHaveText('The email or password is incorrect.')
  await expect(field).toHaveAttribute('aria-invalid', 'true')
  await expect(field).toBeFocused()
  await expect(field).toHaveValue('')
  // An address with no account gets exactly the same answer.
  await signIn(page, uniqueEmail('nobody'), 'not-the-password-at-all')
  await expect(page.getByRole('alert')).toHaveText('The email or password is incorrect.')
})

test('forgot password: reset with the emailed code, signed in, and the old password is refused', async ({
  page,
  request,
}) => {
  const email = uniqueEmail('reset')
  await signUp(page, request, { email })
  await signOut(page)
  await resetLimits(request)
  const before = await emailCount(request, email)

  await page.getByLabel('Email address').fill(email)
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Forgot password?' }).click()
  await expect(page.getByRole('heading', { name: 'Reset your password' })).toBeFocused()
  await expect(page.getByLabel('Email address')).toHaveValue(email)
  await page.getByRole('button', { name: 'Send code' }).click()
  await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeFocused()

  // A wrong code first: it is reported on the code field and the attempt goes on.
  const code = await latestCode(request, email, before)
  const wrong = code === '000000' ? '000001' : '000000'
  await page.getByLabel('Verification code').fill(wrong)
  await page.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD)
  await page.getByRole('button', { name: 'Reset password' }).click()
  await expect(page.getByRole('alert')).toContainText('That code is incorrect.')
  await expect(page.getByLabel('Verification code')).toBeFocused()

  await page.getByLabel('Verification code').fill(code)
  await page.getByRole('button', { name: 'Reset password' }).click()
  await expect(page.getByRole('heading', { name: /^Hello/ })).toBeVisible()

  await signOut(page)
  await signIn(page, email, PASSWORD)
  await expect(page.getByRole('alert')).toHaveText('The email or password is incorrect.')
  await signIn(page, email, NEW_PASSWORD)
  await expect(page.getByRole('heading', { name: /^Hello/ })).toBeVisible()
})

test('change the password in the profile, then sign in with the new one', async ({
  page,
  request,
}) => {
  const email = uniqueEmail('change')
  await signUp(page, request, { email })
  await page.getByRole('link', { name: 'Manage your account' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible()
  await expect(page.getByText(email)).toBeVisible()

  // A wrong current password is reported on that field.
  await page.getByLabel('Current password', { exact: true }).fill('not-the-password-at-all')
  await page.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD)
  await page.getByRole('button', { name: 'Update password' }).click()
  await expect(page.getByRole('alert')).toHaveText('That is not your current password.')
  await expect(page.getByLabel('Current password', { exact: true })).toBeFocused()
  await expect(page.getByLabel('Current password', { exact: true })).toHaveValue('')

  await page.getByLabel('Current password', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: 'Update password' }).click()
  await expect(page.getByText('Your password was changed.')).toBeVisible()
  await expect(page.getByLabel('New password', { exact: true })).toHaveValue('')

  await page.getByRole('button', { name: 'Sign out', exact: true }).last().click()
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  await signIn(page, email, PASSWORD)
  await expect(page.getByRole('alert')).toHaveText('The email or password is incorrect.')
  await signIn(page, email, NEW_PASSWORD)
  await expect(page.getByRole('heading', { name: /^Hello/ })).toBeVisible()
})

test('two browsers: the first sees both sessions and signs the other out; the other is signed out at its next action', async ({
  page,
  request,
  browser,
}) => {
  const email = uniqueEmail('devices')
  await signUp(page, request, { email })

  const other = await browser.newContext()
  const second = await other.newPage()
  await signIn(second, email)
  await expect(second.getByRole('heading', { name: /^Hello/ })).toBeVisible()

  await page.getByRole('link', { name: 'Manage your account' }).click()
  const devices = page.locator('[data-tula-element="sessionItem"]')
  await expect(devices).toHaveCount(2)
  await expect(devices.filter({ hasText: 'This device' })).toHaveCount(1)
  await expect(devices.filter({ hasText: 'Active now' })).toHaveCount(1)

  await page.getByRole('button', { name: /^Sign out Chrome on/ }).click()
  await expect(page.getByText('That device was signed out.')).toBeVisible()
  await expect(devices).toHaveCount(1)
  // This browser is still signed in.
  await expect(page.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible()

  // The other browser finds out at its next call to the API: opening its account dialog.
  await second.getByRole('button', { name: /^Account menu for/ }).click()
  await second.getByRole('menuitem', { name: 'Manage account' }).click()
  await expect(second.getByRole('link', { name: 'Sign in' })).toBeVisible()
  await expect(second.getByRole('button', { name: /^Account menu for/ })).toHaveCount(0)
  await second.reload()
  await expect(second.getByRole('link', { name: 'Sign in' })).toBeVisible()
  await other.close()
})

test('sign out of all other devices', async ({ page, request, browser }) => {
  const email = uniqueEmail('others')
  await signUp(page, request, { email })
  const contexts = [await browser.newContext(), await browser.newContext()]
  for (const context of contexts) {
    const tab = await context.newPage()
    await signIn(tab, email)
    await expect(tab.getByRole('heading', { name: /^Hello/ })).toBeVisible()
  }
  await page.goto('/account')
  const devices = page.locator('[data-tula-element="sessionItem"]')
  await expect(devices).toHaveCount(3)
  await page.getByRole('button', { name: 'Sign out of all other devices' }).click()
  await expect(page.getByText('Signed out of 2 other devices.')).toBeVisible()
  await expect(devices).toHaveCount(1)
  for (const context of contexts) {
    await context.close()
  }
})

test('sign-up with the keyboard only, then the user menu and sign-out with the keyboard only', async ({
  page,
  request,
}) => {
  const email = uniqueEmail('keys')
  await page.goto('/sign-up')
  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible()

  /** Press Tab until the element with this accessible name has focus. */
  const tabTo = async (name: string | RegExp) => {
    for (let presses = 0; presses < 30; presses++) {
      await page.keyboard.press('Tab')
      const label = await page.evaluate(() => {
        const element = document.activeElement
        if (!element || element === document.body) {
          return ''
        }
        const labelled = (element as HTMLInputElement).labels?.[0]?.textContent
        return (element.getAttribute('aria-label') ?? labelled ?? element.textContent ?? '').trim()
      })
      if (typeof name === 'string' ? label === name : name.test(label)) {
        return
      }
    }
    throw new Error(`never reached "${name}" with Tab`)
  }

  await tabTo('First name')
  await page.keyboard.type('Kay')
  await tabTo('Email address')
  await page.keyboard.type(email)
  await tabTo('Password')
  // A weak password first: the checklist follows each keystroke.
  await page.keyboard.type('short')
  await expect(page.getByText('Not met: 10 or more characters')).toBeAttached()
  await page.keyboard.type('-but-now-long-enough-42')
  await expect(page.getByText('Met: 10 or more characters')).toBeAttached()
  // The show/hide button is reachable and works from the keyboard.
  await tabTo('Show password')
  await page.keyboard.press('Space')
  await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('type', 'text')
  await page.keyboard.press('Space')
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('Enter')

  // The new step's title has focus; the code field is the next stop.
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByLabel('Verification code')).toBeFocused()
  await page.keyboard.type(await latestCode(request, email))
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: 'Hello, Kay' })).toBeVisible()

  await tabTo(/^Account menu for/)
  await page.keyboard.press('Enter')
  await expect(page.getByRole('menuitem', { name: 'Manage account' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: /^Account menu for/ })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('menuitem', { name: 'Sign out' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
})
