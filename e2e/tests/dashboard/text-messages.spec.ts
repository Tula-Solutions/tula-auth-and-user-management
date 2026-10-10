import type { APIRequestContext, Page } from '@playwright/test'
import { API_URL, useSettings } from '../support'
import {
  dialog,
  ENVIRONMENT_PATH,
  expect,
  expectScreenAccessible,
  open,
  signIn,
  test,
} from './support'

// The Text messages screen (ADR 0037, ADR 0025) against the real API: the settings are the
// one settings document's, what asks first is the contract's `settingsWeakenings` as the
// server would record it, the counts are the answer of `GET /v1/admin/sms/usage`, and what
// is said of the sender is the deployment's own diagnostics. The page runs under the real
// Content-Security-Policy; the fixture fails a test on any violation.

/** The fixture's secret key (e2e/server.ts): a test value that opens nothing else. */
const SECRET_KEY = 'tula_sk_dev_e2e000000000000000000000000000000'

interface UsageRow {
  prefix: string
  sent: number
  used: number
}

/** Replace the fixture environment's counts of texted codes for today. `[]` empties them. */
async function useUsage(request: APIRequestContext, rows: UsageRow[]): Promise<void> {
  const response = await request.post(`${API_URL}/__test/sms-usage`, { data: { rows } })
  expect(response.ok()).toBe(true)
}

/** Whether the fixture's deployment has an SMS sender. */
async function useSender(request: APIRequestContext, configured: boolean): Promise<void> {
  const response = await request.post(`${API_URL}/__test/sms-sender`, { data: { configured } })
  expect(response.ok()).toBe(true)
}

async function savedSettings(request: APIRequestContext) {
  const response = await request.get(`${API_URL}/v1/admin/settings`, {
    headers: { authorization: `Bearer ${SECRET_KEY}` },
  })
  expect(response.status()).toBe(200)
  return (await response.json()) as {
    revision: number
    settings: {
      sms: { enabled: boolean; allowedCountries: string[]; dailyMessageLimit: number }
      mfa: { policy: string; smsCode: { enabled: boolean } }
      signIn: { methods: { smsCode: { enabled: boolean } } }
    }
  }
}

function sender(page: Page) {
  return page.locator('[data-sender]')
}

function totals(page: Page) {
  return page.locator('[data-usage="totals"]')
}

async function addCountry(page: Page, code: string) {
  await page.getByLabel('Add a country').selectOption(code)
  await page.getByRole('button', { name: 'Add country' }).click()
}

async function openScreen(page: Page) {
  await open(page, `${ENVIRONMENT_PATH}/text-messages`, 'Text messages')
  await expect(sender(page)).toBeVisible()
  await expect(totals(page)).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await useSettings(page.request)
  await useSender(page.request, true)
  await useUsage(page.request, [])
  await signIn(page)
})

test.afterEach(async ({ page }) => {
  await useSettings(page.request)
  await useSender(page.request, true)
  await useUsage(page.request, [])
})

test('an untouched environment: nothing is sent, no code was texted, and the screen says both', async ({
  page,
}) => {
  await open(page, `${ENVIRONMENT_PATH}/users`, 'Users')
  await page
    .getByRole('navigation', { name: 'Environment' })
    .getByRole('link', { name: 'Text messages' })
    .click()
  const heading = page.getByRole('heading', { level: 1, name: 'Text messages' })
  await expect(heading).toBeVisible()
  // A keyboard user starts at the new content.
  await expect(heading).toBeFocused()

  await expect(page.getByRole('switch', { name: 'Send text messages' })).not.toBeChecked()
  await expect(page.locator('[data-countries="none"]')).toContainText(
    'No country is listed: no text message is sent'
  )
  await expect(page.locator('[data-limits="hourly"]')).toContainText(
    'With 500 messages a day: at most 125 in one hour in all, and at most 50 in one hour to one destination prefix.'
  )
  // The fixture's deployment has a sender, and the server's own sentence says so.
  await expect(sender(page)).toHaveAttribute('data-sender', 'ok')
  await expect(sender(page)).toContainText('Status of the sms_sender check: OK')
  await expect(totals(page)).toContainText('0 codes sent, 0 used, 0 never used.')
  await expect(page.getByText('No code was texted in these days')).toBeVisible()
  await expect(page.getByRole('table')).toHaveCount(0)
  await expectScreenAccessible(page, 'text messages, nothing sent and no usage')
})

test('countries are chosen from the list and saved as a set; a wider reach of a required texted second step asks first', async ({
  page,
}) => {
  await openScreen(page)
  // Nothing typed becomes a country: the control is the platform's select.
  await expect(page.getByLabel('Add a country')).toHaveJSProperty('tagName', 'SELECT')
  await page.getByRole('button', { name: 'Add country' }).click()
  await expect(page.getByText('Choose the country to add.')).toBeVisible()
  await addCountry(page, 'US')
  await addCountry(page, 'DE')
  const list = page.getByRole('list', { name: 'Countries text messages may go to' })
  await expect(list.getByRole('listitem')).toHaveCount(2)
  await expect(list).toContainText('United States')
  await expect(list).toContainText('Also allows Canada')
  await expect(list).toContainText('+49')
  await page.getByRole('switch', { name: 'Send text messages' }).click()
  await expectScreenAccessible(page, 'text messages, two countries drafted')

  // No texted code signs anyone in or is a required step: saved with no question.
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Settings saved')).toBeVisible()
  await expect(dialog(page)).toHaveCount(0)
  expect((await savedSettings(page.request)).settings.sms).toMatchObject({
    enabled: true,
    allowedCountries: ['US', 'DE'],
    dailyMessageLimit: 500,
  })

  // A second step is required and may be a texted code: the same change now asks first.
  await useSettings(page.request, {
    sms: { enabled: true, allowedCountries: ['US'] },
    mfa: { policy: 'required', smsCode: { enabled: true } },
  })
  await page.reload()
  await openScreen(page)
  await expect(page.getByRole('switch', { name: 'Texted code as the second step' })).toBeChecked()
  await addCountry(page, 'FR')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(dialog(page)).toContainText('This weakens security. Save anyway?')
  await expect(dialog(page)).toContainText('Text messages go to the countries added')
  await expect(dialog(page)).toContainText('a message that was sent cannot be un-sent')
  await expectScreenAccessible(page, 'text messages, the question before a wider country list')
  expect((await savedSettings(page.request)).settings.sms.allowedCountries).toEqual(['US'])
  await dialog(page).getByRole('button', { name: 'Save anyway' }).click()
  await expect(page.getByText('Settings saved')).toBeVisible()
  expect((await savedSettings(page.request)).settings.sms.allowedCountries).toEqual(['US', 'FR'])

  // Taking one out asks nothing, and is kept after a reload.
  await page.getByRole('button', { name: 'Take out United States (US)' }).click()
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'No unsaved changes.' })).toBeVisible()
  await page.reload()
  await openScreen(page)
  await expect(
    page.getByRole('list', { name: 'Countries text messages may go to' }).getByRole('listitem')
  ).toHaveCount(1)
  expect((await savedSettings(page.request)).settings.sms.allowedCountries).toEqual(['FR'])
})

test('a raised daily limit and the two uses of a texted code each ask first; a lowered limit does not', async ({
  page,
}) => {
  await useSettings(page.request, {
    sms: { enabled: true, allowedCountries: ['US'] },
    mfa: { policy: 'required' },
  })
  await openScreen(page)
  const limit = page.getByLabel('Most text messages in a day')
  await limit.fill('100')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Settings saved')).toBeVisible()
  await expect(dialog(page)).toHaveCount(0)

  await limit.fill('2000')
  await expect(page.locator('[data-limits="hourly"]')).toContainText(
    'at most 500 in one hour in all, and at most 200 in one hour'
  )
  await page.getByRole('switch', { name: 'Sign in with a texted code' }).click()
  await page.getByRole('switch', { name: 'Texted code as the second step' }).click()
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(dialog(page)).toContainText('More text messages may be sent in a day')
  await expect(dialog(page)).toContainText('what a day can cost at most')
  await expect(dialog(page)).toContainText('A texted code can sign people in')
  await expect(dialog(page)).toContainText(
    'The second step this environment requires may be a texted code'
  )
  await expectScreenAccessible(page, 'text messages, the question before three weakenings')
  // Nothing was saved by asking.
  const before = await savedSettings(page.request)
  expect(before.settings.sms.dailyMessageLimit).toBe(100)
  expect(before.settings.signIn.methods.smsCode.enabled).toBe(false)

  // Confirmed, it is sent once: one more revision, and no second one.
  await dialog(page).getByRole('button', { name: 'Save anyway' }).click()
  // Not the "Settings saved" toast: the first save's may still be on the page, and then
  // there are two. The draft is dirty until this save lands, so this status is this save's.
  await expect(page.getByRole('status').filter({ hasText: 'No unsaved changes.' })).toBeVisible()
  const after = await savedSettings(page.request)
  expect(after.revision).toBe(before.revision + 1)
  expect(after.settings.sms.dailyMessageLimit).toBe(2000)
  expect(after.settings.signIn.methods.smsCode.enabled).toBe(true)
  expect(after.settings.mfa).toEqual({ policy: 'required', smsCode: { enabled: true } })

  // The sign-in methods screen says how they stand, and has no switch for them.
  await open(page, `${ENVIRONMENT_PATH}/sign-in-methods`, 'Sign-in methods')
  await expect(page.getByRole('switch', { name: /texted code/i })).toHaveCount(0)
  await expect(page.locator('[data-elsewhere]')).toHaveText(['On', 'On'])
  await expectScreenAccessible(page, 'sign-in methods, the texted code settings said and linked')
  await page.getByRole('link', { name: 'Text messages' }).last().click()
  await expect(page.getByRole('heading', { level: 1, name: 'Text messages' })).toBeVisible()
})

test('settings saved elsewhere meanwhile are “changed elsewhere”, and nothing is overwritten', async ({
  page,
}) => {
  await openScreen(page)
  await addCountry(page, 'DE')
  // Another writer replaces the settings after this screen read them.
  const current = await savedSettings(page.request)
  const elsewhere = await page.request.put(`${API_URL}/v1/admin/settings`, {
    headers: { authorization: `Bearer ${SECRET_KEY}`, 'if-match': `"${current.revision}"` },
    data: { ...current.settings, sms: { ...current.settings.sms, dailyMessageLimit: 40 } },
  })
  expect(elsewhere.status()).toBe(200)

  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'Changed elsewhere.' })).toBeVisible()
  await expectScreenAccessible(page, 'text messages, changed elsewhere')
  expect((await savedSettings(page.request)).settings.sms.allowedCountries).toEqual([])
  await page.getByRole('button', { name: 'Reload settings' }).click()
  await expect(page.getByLabel('Most text messages in a day')).toHaveValue('40')
  await expect(page.locator('[data-countries="none"]')).toBeVisible()
})

test('codes sent and never used by destination prefix, as the server counts and orders them', async ({
  page,
}) => {
  await useUsage(page.request, [
    { prefix: '+49', sent: 6, used: 5 },
    { prefix: '+1', sent: 20, used: 1 },
    { prefix: '+1242', sent: 3, used: 0 },
  ])
  await openScreen(page)
  await expect(totals(page)).toContainText('The last 7 days, in UTC:')
  await expect(totals(page)).toContainText('29 codes sent, 6 used, 23 never used.')
  const rows = page.getByRole('table').getByRole('row')
  // The heading row, then most never used first.
  await expect(rows).toHaveCount(4)
  await expect(rows.nth(1)).toContainText('+1')
  await expect(rows.nth(1)).toContainText(
    'Canada, United States (2 countries share this prefix and are counted together)'
  )
  await expect(rows.nth(1).getByRole('cell')).toHaveText([/^\+1Canada/, '20', '1', '19'])
  await expect(rows.nth(2).getByRole('cell')).toHaveText([/^\+1242Bahamas$/, '3', '0', '3'])
  await expect(rows.nth(3).getByRole('cell')).toHaveText([/^\+49Germany$/, '6', '5', '1'])
  await expect(page.getByText(/It is not a delivery/)).toBeVisible()
  await expect(page.getByText(/works out a rate or a trend/)).toBeVisible()
  await expectScreenAccessible(page, 'text messages, usage by destination prefix')

  // Another span is the server's answer for it; today's counts are in every span.
  await page.getByLabel('Days').selectOption('1')
  await expect(totals(page)).toContainText('Today, in UTC (')
  await expect(totals(page)).toContainText('29 codes sent')
  await page.getByLabel('Days').selectOption('30')
  await expect(totals(page)).toContainText('The last 30 days, in UTC:')

  // At a phone's width the table is stacked and nothing scrolls sideways.
  await page.setViewportSize({ width: 375, height: 812 })
  // A stacked cell is named by its column: the label is drawn from this attribute.
  await expect(rows.nth(1).getByRole('cell')).toHaveCount(4)
  await expect(rows.nth(1).getByRole('cell').nth(3)).toHaveAttribute('data-label', 'Never used')
  const stacked = await rows
    .nth(1)
    .getByRole('cell')
    .evaluateAll((cells) => cells.map((cell) => Math.round(cell.getBoundingClientRect().top)))
  expect(new Set(stacked).size, 'cells of a row are one under another').toBe(4)
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  )
  expect(overflow, 'sideways scroll on Text messages').toBeLessThanOrEqual(0)
  await expectScreenAccessible(page, 'text messages at 375px, usage stacked')
})

test('a deployment with no SMS sender: said first, in the server’s words, and the settings stay editable', async ({
  page,
}) => {
  await useSender(page.request, false)
  await openScreen(page)
  // No environment has text messages on: the diagnostics skip the check, and say why.
  await expect(sender(page)).toHaveAttribute('data-sender', 'skipped')
  await expect(sender(page)).toContainText('Status of the sms_sender check: Skipped')
  await expect(sender(page)).toContainText('The deployment has no sender for text messages')
  await expect(sender(page)).toContainText('These settings can be edited either way.')
  await expectScreenAccessible(page, 'text messages, no sender and nothing switched on')

  await addCountry(page, 'US')
  await page.getByRole('switch', { name: 'Send text messages' }).click()
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Settings saved')).toBeVisible()
  expect((await savedSettings(page.request)).settings.sms).toMatchObject({
    enabled: true,
    allowedCountries: ['US'],
  })

  // Now an environment is told to send what the deployment cannot: a warning with its fix.
  // (The diagnostics read settings through the cache: asked again until they have seen it.)
  await expect(async () => {
    await page.reload()
    await expect(sender(page)).toHaveAttribute('data-sender', 'warn', { timeout: 2000 })
  }).toPass({ timeout: 45_000 })
  await expect(sender(page)).toContainText('Status of the sms_sender check: Warning')
  await expect(sender(page)).toContainText('SMS_PROVIDER is `none`')
  await expect(sender(page)).toContainText('Fix: ')
  await expect(page.getByRole('switch', { name: 'Send text messages' })).toBeChecked()
  await expectScreenAccessible(page, 'text messages, no sender and text messages switched on')
})
