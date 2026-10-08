import { expect, type Page, type Request, test } from '@playwright/test'
import {
  EMAIL_METHODS,
  emailCount,
  expectAccessible,
  latestCode,
  latestLink,
  resetLimits,
  signOut,
  signUp,
  uniqueEmail,
  useSettings,
} from './support'

// Signing in by email: a code, and a link that only works in the browser that asked for it
// (ADR 0024). Every scenario switches the methods on for the fixture's one environment and
// puts the defaults back afterwards, so the other spec files see the settings they expect.

test.beforeEach(async ({ request }) => {
  await resetLimits(request)
})

test.afterEach(async ({ request }) => {
  await useSettings(request)
})

/** Every request a page makes, to check afterwards what did (not) travel in a URL. */
function recordRequests(page: Page): Request[] {
  const requests: Request[] = []
  page.on('request', (request) => requests.push(request))
  return requests
}

/**
 * Console errors and warnings, uncaught errors and failed requests of a page. A visitor with
 * no session gets a 401 for the first refresh by design, and the browser logs that one line:
 * it is left out.
 */
function recordProblems(page: Page): string[] {
  const problems: string[] = []
  page.on('console', (message) => {
    const text = message.text()
    if ((message.type() === 'error' || message.type() === 'warning') && !text.includes('401')) {
      problems.push(text)
    }
  })
  page.on('pageerror', (error) => problems.push(String(error)))
  page.on('requestfailed', (sent) => {
    problems.push(`${sent.method()} ${new URL(sent.url()).pathname}: ${sent.failure()?.errorText}`)
  })
  return problems
}

/** Create an account (with a password) and come back signed out, on the sign-in page. */
async function account(page: Page, request: Parameters<typeof signUp>[1], tag: string) {
  const email = uniqueEmail(tag)
  await signUp(page, request, { email, firstName: 'Maya' })
  await signOut(page)
  // The sign-up emailed this address a moment ago; the per-address cooldown would refuse the
  // next email.
  await resetLimits(request)
  return email
}

/** What the page has in web storage: only an emailed link's binding may ever be there. */
async function storageKeys(page: Page): Promise<{ local: string[]; session: number }> {
  return page.evaluate(() => ({
    local: Object.keys(window.localStorage),
    session: window.sessionStorage.length,
  }))
}

async function toFirstFactor(page: Page, email: string): Promise<void> {
  await page.goto('/sign-in')
  await page.getByLabel('Email address').fill(email)
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('heading', { name: 'Enter your password' })).toBeVisible()
}

test('email code: choose it beside the password, a wrong code, the right one signs in', async ({
  page,
  request,
}) => {
  const email = await account(page, request, 'code')
  await useSettings(request, EMAIL_METHODS)
  const requests = recordRequests(page)
  const problems = recordProblems(page)
  const before = await emailCount(request, email)

  await toFirstFactor(page, email)
  const others = page.getByRole('list', { name: 'Other ways to sign in' })
  await expect(others.getByRole('button')).toHaveText(['Email me a code', 'Email me a link'])

  // Nothing was emailed for looking at the choices; choosing one asks for its email.
  expect(await emailCount(request, email)).toBe(before)
  await others.getByRole('button', { name: 'Email me a code' }).click()
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeFocused()
  await expect(page.getByText(/Enter the 6-digit code we sent to c\*\*\*@/)).toBeVisible()

  const code = await latestCode(request, email, before)
  await page.getByLabel('Verification code').fill(code === '000000' ? '000001' : '000000')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('alert')).toContainText('That code is incorrect. 4 attempts left.')
  await expect(page.getByLabel('Verification code')).toBeFocused()
  await expect(page.getByLabel('Verification code')).toHaveValue('')

  await page.getByLabel('Verification code').fill(code)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Hello, Maya' })).toBeVisible()
  await expect(page).toHaveURL('/')

  for (const sent of requests) {
    expect(sent.url()).not.toContain(code)
  }
  expect(await storageKeys(page)).toEqual({ local: [], session: 0 })
  // The wrong code's 422 is the one expected console entry.
  expect(problems.filter((problem) => !problem.includes('422'))).toEqual([])
})

test('email code is the only method: the address leads straight to the code', async ({
  page,
  request,
}) => {
  const email = await account(page, request, 'only')
  await useSettings(request, {
    signIn: {
      methods: {
        password: { enabled: false },
        emailCode: { enabled: true },
        emailLink: { enabled: false },
      },
    },
  })
  const before = await emailCount(request, email)
  await page.goto('/sign-in')
  await page.getByLabel('Email address').fill(email)
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeFocused()
  await expect(page.getByRole('list', { name: 'Other ways to sign in' })).toHaveCount(0)
  await page.getByLabel('Verification code').fill(await latestCode(request, email, before))
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Hello, Maya' })).toBeVisible()
})

test('an address with no account sees the same screens and gets a notice, not a code', async ({
  page,
  request,
}) => {
  await useSettings(request, EMAIL_METHODS)
  const stranger = uniqueEmail('nobody')
  await toFirstFactor(page, stranger)
  await page.getByRole('button', { name: 'Email me a code' }).click()
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
  await expect(page.getByText(/Enter the 6-digit code we sent to n\*\*\*@/)).toBeVisible()
  await expect.poll(() => emailCount(request, stranger)).toBe(1)

  const outbox = await request.get(
    `http://localhost:4318/__test/outbox?to=${encodeURIComponent(stranger)}`
  )
  const { data } = (await outbox.json()) as { data: { subject: string; text: string }[] }
  expect(data[0]?.subject).toBe('Tula sign-in requested')
  expect(data[0]?.text).not.toMatch(/\d{6}/)
  expect(data[0]?.text).not.toContain('tula_link')

  await page.getByLabel('Verification code').fill('000000')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('alert')).toContainText('That code is incorrect.')
})

test('magic link, same browser: a new tab accepts the link and the tab that started is signed in', async ({
  page,
  context,
  request,
}) => {
  const email = await account(page, request, 'link')
  await useSettings(request, EMAIL_METHODS)
  const requests = recordRequests(page)
  const problems = recordProblems(page)

  await toFirstFactor(page, email)
  await page.getByRole('button', { name: 'Email me a link' }).click()
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeFocused()
  await expect(page.getByText('Waiting for you to open the link…')).toBeVisible()
  await expect(page.getByText(/Open it in this browser/)).toBeVisible()
  // The email's code can be typed on this very screen.
  await expect(page.getByLabel('Verification code')).toBeVisible()

  // The one thing in web storage: the link's binding, under the attempt's id. No token, no
  // attempt secret.
  const kept = await page.evaluate(() => Object.entries(window.localStorage))
  expect(kept).toHaveLength(1)
  expect(kept[0]?.[0]).toMatch(/^tula\.link\.[0-9a-f-]{36}$/)
  expect(kept[0]?.[1]).toContain('tula_lb_')
  expect(kept[0]?.[1]).not.toContain('tula_at_')
  expect(kept[0]?.[1]).not.toContain('eyJ')

  const link = await latestLink(request, email)
  const url = new URL(link)
  expect(`${url.origin}${url.pathname}`).toBe('http://localhost:4317/auth/link')
  expect(url.search).toBe('')
  const token = new URLSearchParams(url.hash.slice(1)).get('tula_link') ?? ''
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)

  // The user clicks the link in their mail: a new tab of the same browser. The tab happens to
  // show the link page already, so following the link changes only the fragment and loads
  // nothing: the page must still notice it.
  const landing = await context.newPage()
  const landingRequests = recordRequests(landing)
  const landingProblems = recordProblems(landing)
  await landing.goto('/auth/link')
  await expect(landing.getByRole('heading', { name: 'No sign-in link here' })).toBeVisible()
  await landing.goto(link)
  // The landing tab is signed in too, and sent on to the app.
  await expect(landing.getByRole('heading', { name: 'Hello, Maya' })).toBeVisible()
  await expect(landing).toHaveURL('/')

  // The tab that started the sign-in finished it, without the user touching it.
  await expect(page.getByRole('heading', { name: 'Hello, Maya' })).toBeVisible()
  await expect(page).toHaveURL('/')

  // The token went to the API in one request body and never in a URL: the fragment is not
  // sent, and it was removed from the address before the request.
  for (const sent of [...requests, ...landingRequests]) {
    expect(sent.url()).not.toContain(token)
    expect(sent.url()).not.toContain('tula_link')
  }
  const carried = landingRequests.filter((sent) => sent.postData()?.includes(token))
  expect(carried.map((sent) => new URL(sent.url()).pathname)).toEqual(['/v1/client/sign-ins/link'])
  expect(carried[0]?.headers().referer ?? '').not.toContain(token)

  // Nothing is left in web storage in either tab.
  expect(await storageKeys(page)).toEqual({ local: [], session: 0 })
  expect(await storageKeys(landing)).toEqual({ local: [], session: 0 })
  expect(problems).toEqual([])
  expect(landingProblems).toEqual([])

  // The link is spent: opening it again says so.
  await signOut(landing)
  await landing.goto(link)
  await expect(landing.getByRole('heading', { name: 'This link has expired' })).toBeVisible()
  await expect(landing).toHaveURL('/auth/link')
})

test('magic link, another browser: nobody is signed in, the page says where to open it, and the link still works where it was asked for', async ({
  page,
  context,
  browser,
  request,
}) => {
  const email = await account(page, request, 'other')
  await useSettings(request, EMAIL_METHODS)
  await toFirstFactor(page, email)
  await page.getByRole('button', { name: 'Email me a link' }).click()
  await expect(page.getByText('Waiting for you to open the link…')).toBeVisible()
  const link = await latestLink(request, email)

  // Someone else's browser: the victim of an attacker's sign-in, or the user's own phone.
  const elsewhere = await browser.newContext()
  const stranger = await elsewhere.newPage()
  const strangerRequests = recordRequests(stranger)
  await stranger.goto(link)
  await expect(
    stranger.getByRole('heading', { name: 'Open this link where you started' })
  ).toBeFocused()
  await expect(stranger.getByText(/only works in the browser where you asked for it/)).toBeVisible()
  await expect(stranger.getByText(/enter the 6-digit code from the same email there/)).toBeVisible()
  // The token is gone from the address bar there too.
  await expect(stranger).toHaveURL('/auth/link')
  expect(await stranger.evaluate(() => window.location.hash)).toBe('')
  // Nobody was signed in: not there…
  await stranger.goto('/')
  await expect(stranger.getByRole('heading', { name: 'Northline' })).toBeVisible()
  expect(await elsewhere.cookies()).toEqual([])
  for (const sent of strangerRequests) {
    expect(sent.url()).not.toContain('tula_link')
  }
  await elsewhere.close()

  // …and not in the tab that is waiting, however long it polls.
  await page.waitForTimeout(4_000)
  await expect(page.getByText('Waiting for you to open the link…')).toBeVisible()
  expect((await context.cookies()).filter((cookie) => cookie.name.includes('refresh'))).toEqual([])

  // The link was not used up: in the browser that asked, it still signs in.
  const landing = await context.newPage()
  await landing.goto(link)
  await expect(landing.getByRole('heading', { name: 'Hello, Maya' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Hello, Maya' })).toBeVisible()
})

test('magic link: the code from the same email signs in on the waiting screen', async ({
  page,
  request,
}) => {
  const email = await account(page, request, 'both')
  await useSettings(request, EMAIL_METHODS)
  const before = await emailCount(request, email)
  await toFirstFactor(page, email)
  await page.getByRole('button', { name: 'Email me a link' }).click()
  await expect(page.getByText('Waiting for you to open the link…')).toBeVisible()
  await page.getByLabel('Verification code').fill(await latestCode(request, email, before))
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Hello, Maya' })).toBeVisible()
  expect(await storageKeys(page)).toEqual({ local: [], session: 0 })
})

test('magic link: going back to the address leaves nothing in storage and stops asking the server', async ({
  page,
  request,
}) => {
  const email = await account(page, request, 'leave')
  await useSettings(request, EMAIL_METHODS)
  await toFirstFactor(page, email)
  await page.getByRole('button', { name: 'Email me a link' }).click()
  await expect(page.getByText('Waiting for you to open the link…')).toBeVisible()
  expect((await storageKeys(page)).local).toHaveLength(1)

  await page.getByRole('button', { name: 'Change' }).click()
  await expect(page.getByLabel('Email address')).toBeVisible()
  expect(await storageKeys(page)).toEqual({ local: [], session: 0 })
  const requests = recordRequests(page)
  await page.waitForTimeout(4_000)
  expect(requests.filter((sent) => sent.url().includes('/first-factor/'))).toEqual([])
})

test('the link page opened with no link says so', async ({ page }) => {
  await page.goto('/auth/link')
  await expect(page.getByRole('heading', { name: 'No sign-in link here' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/sign-in')
})

test('sign-up without a password, then sign in with an emailed code', async ({ page, request }) => {
  await useSettings(request, {
    signIn: {
      methods: {
        password: { enabled: true },
        emailCode: { enabled: true },
        emailLink: { enabled: false },
      },
    },
    signUp: { password: 'optional' },
  })
  const problems = recordProblems(page)
  const email = uniqueEmail('nopw')
  await page.goto('/sign-up')
  const password = page.getByLabel('Password (optional)')
  await expect(password).toBeVisible()
  await expect(
    page.getByText('Leave it empty to sign in with a code we email you instead.')
  ).toBeVisible()
  await expect(page.getByRole('list', { name: 'Password requirements' })).toHaveCount(0)
  await page.getByLabel('First name').fill('Ines')
  await page.getByLabel('Email address').fill(email)
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
  await page.getByLabel('Verification code').fill(await latestCode(request, email))
  await page.getByRole('button', { name: 'Verify' }).click()
  await expect(page.getByRole('heading', { name: 'Hello, Ines' })).toBeVisible()

  await signOut(page)
  await resetLimits(request)
  const before = await emailCount(request, email)
  await page.getByLabel('Email address').fill(email)
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Email me a code' }).click()
  await page.getByLabel('Verification code').fill(await latestCode(request, email, before))
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Hello, Ines' })).toBeVisible()
  expect(problems).toEqual([])
})

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`axe, ${colorScheme} theme`, () => {
    test.use({ colorScheme })

    test('the email sign-in screens and the link page in each of its states', async ({
      page,
      browser,
      context,
      request,
    }) => {
      const email = await account(page, request, `axe.${colorScheme}`)
      await useSettings(request, EMAIL_METHODS)
      const before = await emailCount(request, email)

      await toFirstFactor(page, email)
      await expect(page.getByRole('list', { name: 'Other ways to sign in' })).toBeVisible()
      await expectAccessible(page, 'sign-in, password with other ways to sign in')

      await page.getByRole('button', { name: 'Email me a code' }).click()
      await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
      await expectAccessible(page, 'sign-in, emailed code')

      const code = await latestCode(request, email, before)
      await page.getByLabel('Verification code').fill(code === '000000' ? '000001' : '000000')
      await page.getByRole('button', { name: 'Sign in' }).click()
      await expect(page.getByRole('alert')).toContainText('attempts left')
      await page.getByRole('button', { name: 'Send a new email' }).click()
      await expect(page.getByRole('button', { name: /Send a new email in/ })).toBeVisible()
      await expectAccessible(page, 'sign-in, wrong code and the resend cooldown')

      // Too soon for another email: the link's own screen says so and offers to send it.
      await page.getByRole('button', { name: 'Email me a link' }).click()
      await expect(page.getByRole('heading', { name: 'Email me a link' })).toBeFocused()
      await expect(page.getByRole('alert')).toContainText('Try again in')
      await expectAccessible(page, 'sign-in, a link that cannot be sent yet')

      await resetLimits(request)
      await page.getByRole('button', { name: 'Change' }).click()
      await page.getByRole('button', { name: 'Continue' }).click()
      await page.getByRole('button', { name: 'Email me a link' }).click()
      await expect(page.getByText('Waiting for you to open the link…')).toBeVisible()
      await expectAccessible(page, 'sign-in, waiting for the link')

      const link = await latestLink(request, email)
      const elsewhere = await browser.newContext({ colorScheme })
      const stranger = await elsewhere.newPage()
      await stranger.goto(link)
      await expect(
        stranger.getByRole('heading', { name: 'Open this link where you started' })
      ).toBeVisible()
      await expectAccessible(stranger, 'link page, opened in another browser')
      await stranger.goto('/auth/link')
      await expect(stranger.getByRole('heading', { name: 'No sign-in link here' })).toBeVisible()
      await expectAccessible(stranger, 'link page, no link')
      await elsewhere.close()

      const landing = await context.newPage()
      await landing.goto(link)
      await expect(landing.getByRole('heading', { name: 'Hello, Maya' })).toBeVisible()
      await signOut(landing)
      await landing.goto(link)
      await expect(landing.getByRole('heading', { name: 'This link has expired' })).toBeVisible()
      await expectAccessible(landing, 'link page, expired link')
    })

    test('sign-up with an optional password', async ({ page, request }) => {
      await useSettings(request, {
        signIn: {
          methods: {
            password: { enabled: true },
            emailCode: { enabled: true },
            emailLink: { enabled: false },
          },
        },
        signUp: { password: 'optional' },
      })
      await page.goto('/sign-up')
      await expect(page.getByLabel('Password (optional)')).toBeVisible()
      await expectAccessible(page, 'sign-up, optional password, empty')
      await page.getByLabel('Password (optional)').fill('password1')
      await expect(page.getByText('10 or more characters')).toBeVisible()
      await expectAccessible(page, 'sign-up, optional password, being typed')
    })
  })
}
