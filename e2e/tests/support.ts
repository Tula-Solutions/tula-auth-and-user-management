import { createHmac } from 'node:crypto'
import AxeBuilder from '@axe-core/playwright'
import { type APIRequestContext, expect, type Page } from '@playwright/test'

/** The fixture's API (e2e/server.ts). */
export const API_URL = 'http://localhost:4318'

export const PASSWORD = 'sturdy-Otter-plays-42-chess'
export const NEW_PASSWORD = 'quiet-Heron-wades-17-rivers'

let counter = 0

/** A fresh address per scenario: the fixture's memory is shared by the whole run. */
export function uniqueEmail(tag: string): string {
  counter += 1
  return `${tag}.${Date.now().toString(36)}${counter}@northline.test`
}

/**
 * The newest 6-digit code emailed to an address, read from the fixture's outbox.
 *
 * @param request - Playwright's API client (the test process, not the page).
 * @param email - The recipient.
 * @param after - Ignore the first `after` messages to this address (to wait for a new one).
 */
export async function latestCode(
  request: APIRequestContext,
  email: string,
  after = 0
): Promise<string> {
  let code: string | undefined
  await expect
    .poll(
      async () => {
        const response = await request.get(
          `${API_URL}/__test/outbox?to=${encodeURIComponent(email)}`
        )
        const { data } = (await response.json()) as { data: { subject: string }[] }
        // The newest email with a code: a security notice ("your password was changed") can
        // arrive after it, and has none.
        code = data
          .slice(after)
          .map(({ subject }) => /^(\d{6})\b/.exec(subject)?.[1])
          .findLast((found) => found !== undefined)
        return code
      },
      { message: `an email with a code for ${email}` }
    )
    .toBeTruthy()
  return code as string
}

/**
 * The sign-in link in the newest email to an address, read from the fixture's outbox.
 *
 * @param request - Playwright's API client (the test process, not the page).
 * @param email - The recipient.
 * @returns The whole link, with the token in its fragment.
 */
export async function latestLink(request: APIRequestContext, email: string): Promise<string> {
  let link: string | undefined
  await expect
    .poll(
      async () => {
        const response = await request.get(
          `${API_URL}/__test/outbox?to=${encodeURIComponent(email)}`
        )
        const { data } = (await response.json()) as { data: { text: string }[] }
        link = data
          .map(({ text }) => /https?:\/\/\S+#\S*tula_link=\S+/.exec(text)?.[0])
          .findLast((found) => found !== undefined)
        return link
      },
      { message: `an email with a sign-in link for ${email}` }
    )
    .toBeTruthy()
  return link as string
}

/** What a scenario may change about the environment (the rest stays at the defaults). */
export interface TestSettings {
  signIn?: {
    methods: {
      password: { enabled: boolean }
      emailCode: { enabled: boolean }
      emailLink: { enabled: boolean }
      /** Passkeys; the fixture's relying party is `localhost`. Off when left out. */
      passkey?: { enabled: boolean }
      /** The texted sign-in code (ADR 0037); it also needs `sms`. Off when left out. */
      smsCode?: { enabled: boolean }
    }
  }
  signUp?: { password: 'required' | 'optional' }
  mfa?: { policy: 'off' | 'optional' | 'required' }
  /** Text messages (ADR 0037). Off, with no country allowed, when left out. */
  sms?: { enabled: boolean; allowedCountries: string[]; dailyMessageLimit?: number }
  /** Session profiles and the concurrent-session rule (ADR 0028). */
  sessions?: {
    profiles?: Record<
      string,
      { type?: 'hybrid' | 'stateful'; stepUpAfter?: string; accessTokenTtl?: string }
    >
    maxPerUser?: number | null
    onLimit?: 'end_oldest' | 'refuse_newest'
  }
}

/**
 * Replace the fixture environment's settings: the defaults plus `settings`. Call it with no
 * argument to put the defaults back; a scenario that changes them must, since every scenario
 * shares the one in-memory environment.
 */
export async function useSettings(
  request: APIRequestContext,
  settings: TestSettings = {}
): Promise<void> {
  const response = await request.post(`${API_URL}/__test/settings`, { data: settings })
  expect(response.ok()).toBe(true)
}

/** Text messages on, to United States numbers only. */
export const SMS_ON: TestSettings = { sms: { enabled: true, allowedCountries: ['US'] } }

let phoneNumbers = 0
/**
 * A United States number nobody has (`555-01XX` is kept for fiction), different on every
 * call so that one test's per-number limits are not another's.
 */
export function uniquePhoneNumber(): string {
  phoneNumbers += 1
  const picked = 201 + (Math.floor(Date.now() / 1000) % 700)
  // Never an N11 service code (211, 311, …): no number has one as its area code.
  const area = picked % 100 === 11 ? picked + 1 : picked
  return `+1${area}55501${String(phoneNumbers % 100).padStart(2, '0')}`
}

/**
 * The 6-digit code in the newest text message to a number, read from the fixture's SMS
 * outbox.
 *
 * @param request - Playwright's API client (the test process, not the page).
 * @param to - The number in E.164 form.
 */
export async function latestSmsCode(request: APIRequestContext, to: string): Promise<string> {
  let code: string | undefined
  await expect
    .poll(
      async () => {
        const response = await request.get(`${API_URL}/__test/sms?to=${encodeURIComponent(to)}`)
        const { data } = (await response.json()) as { data: { text: string }[] }
        // The last run of exactly six digits: the origin-bound line repeats the code last.
        code = data
          .at(-1)
          ?.text.match(/(?<![0-9])[0-9]{6}(?![0-9])/g)
          ?.at(-1)
        return code
      },
      { message: 'a text message with a code' }
    )
    .toBeTruthy()
  return code as string
}

/** Every email method on, beside the password. */
export const EMAIL_METHODS: TestSettings = {
  signIn: {
    methods: {
      password: { enabled: true },
      emailCode: { enabled: true },
      emailLink: { enabled: true },
    },
  },
}

/** The password and passkeys, and no email method. */
export const PASSKEY_METHODS: TestSettings = {
  signIn: {
    methods: {
      password: { enabled: true },
      emailCode: { enabled: false },
      emailLink: { enabled: false },
      passkey: { enabled: true },
    },
  },
}

/** Where a page keeps the number of autofill (conditional) WebAuthn requests it has pending. */
interface AutofillCount {
  __autofillRequests?: number
}

/**
 * Runs in the page before its own scripts: counts the conditional `navigator.credentials.get`
 * requests that are pending. The request itself is passed to the browser untouched; this only
 * lets a scenario see that one has been made (`VirtualAuthenticator.autofillWaiting`), which
 * the DevTools protocol does not report.
 */
function countAutofillRequests(): void {
  const container = navigator.credentials as CredentialsContainer | undefined
  if (!container) {
    return
  }
  const state = window as unknown as AutofillCount
  const get = container.get.bind(container)
  state.__autofillRequests = 0
  container.get = (options) => {
    const request = get(options)
    if (options?.mediation === 'conditional') {
      const settled = () => {
        state.__autofillRequests = (state.__autofillRequests ?? 1) - 1
      }
      state.__autofillRequests = (state.__autofillRequests ?? 0) + 1
      request.then(settled, settled)
    }
    return request
  }
}

/** A software authenticator attached to a page through the DevTools protocol. */
export interface VirtualAuthenticator {
  /** Whether it verifies the user when asked. Unverified, every passkey ceremony is refused. */
  setUserVerified(verified: boolean): Promise<void>
  /**
   * Whether it answers a request by itself. It does to begin with, and that includes the
   * request waiting in a field's autofill (conditional mediation), which a person would have to
   * pick a passkey for: with `false` a request waits, as it does in front of a person who has
   * not chosen yet.
   */
  setAnswering(answering: boolean): Promise<void>
  /**
   * Wait until the page's autofill request is with the browser. A request made while the
   * authenticator answers by itself is answered at once, so a scenario that switches answering
   * back on to press a button first waits here: otherwise, on a slow machine, the switch can
   * land before the sign-in screen has asked, the autofill request then signs in by itself, and
   * the button the scenario is about to press is gone.
   */
  autofillWaiting(): Promise<void>
  /** How many passkeys it holds. */
  credentialCount(): Promise<number>
  /** Take it away: the browser is left with no authenticator. */
  remove(): Promise<void>
}

/**
 * Give the page's browser an authenticator of its own: a platform one (like Touch ID) that
 * keeps discoverable credentials, verifies the user and answers without anyone touching it.
 * The ceremonies are the browser's real ones (`navigator.credentials`); only the device is
 * simulated. It lasts as long as the page's context.
 *
 * @param page - The page whose browser gets the authenticator.
 * @returns A handle on it.
 */
export async function addVirtualAuthenticator(page: Page): Promise<VirtualAuthenticator> {
  await page.addInitScript(countAutofillRequests)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
  return {
    async setUserVerified(verified) {
      await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: verified })
    },
    async setAnswering(answering) {
      await cdp.send('WebAuthn.setAutomaticPresenceSimulation', {
        authenticatorId,
        enabled: answering,
      })
    },
    async autofillWaiting() {
      await page.waitForFunction(
        () => ((window as unknown as AutofillCount).__autofillRequests ?? 0) > 0
      )
    },
    async credentialCount() {
      const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId })
      return credentials.length
    },
    async remove() {
      await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId })
    },
  }
}

/** What the fixture's API takes the time to be, in milliseconds. */
export async function serverNow(request: APIRequestContext): Promise<number> {
  const response = await request.get(`${API_URL}/__test/now`)
  return ((await response.json()) as { now: number }).now
}

/**
 * Move the fixture's clock forward, e.g. past the ten minutes a sign-in counts as recent.
 * It stays ahead until `resetClock`; nothing in the suite depends on it standing still.
 */
export async function advanceClock(request: APIRequestContext, ms: number): Promise<void> {
  const response = await request.post(`${API_URL}/__test/advance-clock`, { data: { ms } })
  expect(response.ok()).toBe(true)
}

/**
 * Put the fixture's clock back to the real time, after scenarios that moved it forward.
 * Sessions and codes made while it was ahead are dated in the future afterwards: call it
 * once a spec is done with them (`afterAll`), not between the steps of a scenario.
 */
export async function resetClock(request: APIRequestContext): Promise<void> {
  const response = await request.post(`${API_URL}/__test/reset-clock`)
  expect(response.ok()).toBe(true)
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const TOTP_PERIOD_MS = 30_000

/** The RFC 6238 code (SHA-1, 6 digits, 30 seconds) for a Base32 secret at a time step. */
function totpAt(secret: string, step: number): string {
  let bits = ''
  for (const character of secret.replace(/[\s=-]/g, '').toUpperCase()) {
    bits += BASE32.indexOf(character).toString(2).padStart(5, '0')
  }
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => Number.parseInt(byte, 2)))
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const digest = createHmac('sha1', key).update(counter).digest()
  const offset = (digest.at(-1) ?? 0) & 15
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0')
}

// The last time step a code was made for, per secret: the API accepts a step once.
const usedSteps = new Map<string, number>()

/**
 * What an authenticator app holding `secret` would show, as the fixture's API tells the time:
 * the code a test types where a person would read their phone.
 *
 * The API accepts each 30-second step once, and the step after the current one too (clock
 * drift). So a second code for the same secret is made for the next step, and only a third
 * within one step has to wait for the clock.
 *
 * @param request - Playwright's API client.
 * @param secret - The setup key as the page shows it (spaces are ignored).
 */
export async function authenticatorCode(
  request: APIRequestContext,
  secret: string
): Promise<string> {
  const key = secret.replace(/\s/g, '')
  let current = Math.floor((await serverNow(request)) / TOTP_PERIOD_MS)
  const step = Math.max(current, (usedSteps.get(key) ?? -1) + 1)
  while (step > current + 1) {
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    current = Math.floor((await serverNow(request)) / TOTP_PERIOD_MS)
  }
  usedSteps.set(key, step)
  return totpAt(key, step)
}

/** How many emails an address has received. */
export async function emailCount(request: APIRequestContext, email: string): Promise<number> {
  const response = await request.get(`${API_URL}/__test/outbox?to=${encodeURIComponent(email)}`)
  return ((await response.json()) as { data: unknown[] }).data.length
}

/**
 * Empty the fixture's rate limiter. Every scenario comes from one address, and an inbox may be
 * emailed once a minute; a suite that ran into those limits would test nothing but them.
 */
export async function resetLimits(request: APIRequestContext): Promise<void> {
  const response = await request.post(`${API_URL}/__test/reset-limits`)
  expect(response.ok()).toBe(true)
}

/** Sign up through the components and land on the signed-in home page. */
export async function signUp(
  page: Page,
  request: APIRequestContext,
  account: { email: string; password?: string; firstName?: string }
): Promise<void> {
  await page.goto('/sign-up')
  if (account.firstName) {
    await page.getByLabel('First name').fill(account.firstName)
  }
  await page.getByLabel('Email address').fill(account.email)
  await page.getByLabel('Password', { exact: true }).fill(account.password ?? PASSWORD)
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
  await page.getByLabel('Verification code').fill(await latestCode(request, account.email))
  await page.getByRole('button', { name: 'Verify' }).click()
  await expect(page.getByRole('heading', { name: /^Hello/ })).toBeVisible()
}

/** Sign in through the components and land on the signed-in home page. */
export async function signIn(page: Page, email: string, password = PASSWORD): Promise<void> {
  await page.goto('/sign-in')
  await page.getByLabel('Email address').fill(email)
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.getByLabel('Password', { exact: true }).fill(password)
  // Exactly: where passkeys are on, "Sign in with a passkey" is on the same screen.
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
}

/** Sign out through the user button's menu. */
export async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Account menu for/ }).click()
  await page.getByRole('menuitem', { name: 'Sign out' }).click()
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
}

/**
 * Run axe on the page as it is now and fail on any violation: WCAG 2.0, 2.1 and 2.2 at A and
 * AA, plus axe's best practices. No rule is disabled.
 *
 * @param page - The page.
 * @param state - Names the screen and state in the failure message.
 */
export async function expectAccessible(page: Page, state: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze()
  const problems = results.violations.map((violation) => ({
    rule: violation.id,
    impact: violation.impact,
    help: violation.help,
    nodes: violation.nodes.map((node) => `${node.target.join(' ')} — ${node.failureSummary}`),
  }))
  expect(problems, `axe violations on: ${state}`).toEqual([])
}

/**
 * Enable exactly these OAuth providers for the fixture environment (none by default). They are
 * served by the API's mock provider, whose consent page the test fills in. A scenario that
 * enables one must put it back (`useProviders(request)`).
 */
export async function useProviders(
  request: APIRequestContext,
  providers: (
    | 'google'
    | 'github'
    | 'apple'
    | 'microsoft'
    | 'discord'
    | 'linkedin'
    | 'x'
    | 'facebook'
  )[] = []
): Promise<void> {
  const response = await request.post(`${API_URL}/__test/oauth`, { data: { providers } })
  expect(response.ok()).toBe(true)
}

/**
 * Play the user at the mock provider's consent page, which the browser is on after
 * "Continue with …": say which address the provider reports, and continue (or cancel).
 * For X and Facebook, which are asked for no address, `email` is left out (what is typed
 * there is dropped) and the account is its `subject`, digits only.
 */
export async function consentAtProvider(
  page: Page,
  consent: {
    email?: string
    /** For Microsoft: leave the verified-domain claim out of the token. */
    unverified?: boolean
    subject?: string
    /** Microsoft only: the tenant id (`tid`) and object id (`oid`) of the account. */
    tenantId?: string
    objectId?: string
    cancel?: boolean
  }
): Promise<void> {
  await expect(page.getByRole('heading', { name: /^Mock .* sign-in$/ })).toBeVisible()
  if (consent.email !== undefined) {
    await page.getByLabel(/^Email address/).fill(consent.email)
  }
  if (consent.subject) {
    await page.getByLabel(/^Account id/).fill(consent.subject)
  }
  if (consent.tenantId) {
    await page.getByLabel('Tenant id (tid)').fill(consent.tenantId)
  }
  if (consent.objectId) {
    await page.getByLabel(/^Object id/).fill(consent.objectId)
  }
  if (consent.unverified) {
    // "Report the email as unverified", or for Microsoft the claim that is left out.
    await page.getByLabel(/unverified$/).check()
  }
  await page.getByRole('button', { name: consent.cancel ? 'Cancel' : 'Continue' }).click()
}
