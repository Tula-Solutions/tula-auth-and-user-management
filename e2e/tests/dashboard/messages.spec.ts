import type { Page } from '@playwright/test'
import { API_URL, uniqueEmail, useSettings } from '../support'
import {
  ENVIRONMENT_PATH,
  expect,
  expectScreenAccessible,
  open,
  signIn,
  signUpInExampleApp,
  test,
} from './support'

// The messages screen (ADR 0039, ADR 0042) against the real API: the preview is the server's
// own rendering, the save is the settings document's, and the page runs under the real
// Content-Security-Policy (the fixture fails the test on any violation, so text an operator
// typed that ran as markup would be caught twice).

test.beforeEach(async ({ page }) => {
  await useSettings(page.request)
  await signIn(page)
})

test.afterEach(async ({ page }) => {
  await useSettings(page.request)
})

function field(page: Page, label: 'Subject' | 'Body' | 'Text') {
  return page.getByLabel(label, { exact: true })
}

function previewSubject(page: Page) {
  return page.locator('[data-preview="subject"]')
}

function previewText(page: Page) {
  return page.locator('[data-preview="text"]')
}

function kind(page: Page, name: RegExp) {
  return page.getByRole('navigation', { name: 'Messages' }).getByRole('button', { name })
}

test('an email and a text message are worded, previewed, saved and kept; the email is then sent in those words', async ({
  page,
  browser,
}) => {
  await open(page, `${ENVIRONMENT_PATH}/messages`, 'Messages')
  // The built-in wording, rendered by the server with its sample code.
  await expect(previewSubject(page)).toContainText('123456 is your')
  await expect(previewText(page)).toContainText('123456')
  await expect(kind(page, /^Email verification code/)).toContainText('Built-in')
  await expectScreenAccessible(page, 'messages, built-in wording')

  // An email: placeholders from the buttons, by pointer and by keyboard.
  await page.getByRole('button', { name: 'Insert {{code}} into the subject' }).click()
  await expect(field(page, 'Subject')).toBeFocused()
  await field(page, 'Subject').pressSequentially(' opens ')
  await page.getByRole('button', { name: 'Insert {{appName}} into the subject' }).click()
  await expect(field(page, 'Subject')).toHaveValue('{{code}} opens {{appName}}')

  await field(page, 'Body').fill('Welcome <b>aboard</b>.\n\nYour code: ')
  await page.getByRole('button', { name: 'Insert {{code}} into the body (required)' }).focus()
  await page.keyboard.press('Enter')
  await expect(field(page, 'Body')).toHaveValue('Welcome <b>aboard</b>.\n\nYour code: {{code}}')

  await expect(previewSubject(page)).toHaveText(/^123456 opens \S/)
  await expect(previewText(page)).toContainText('Welcome <b>aboard</b>.')
  await expect(previewText(page)).toContainText('Your code: 123456')
  // Text, and only text: the markup an operator typed made no element.
  await expect(previewText(page).locator('*')).toHaveCount(0)
  await expect(page.getByText('The preview shows the wording above.')).toBeVisible()
  await expectScreenAccessible(page, 'messages, an email in its own wording')

  // A text message: refused wording says why and is not previewed.
  await kind(page, /^Phone number code/).click()
  await expect(previewText(page)).toContainText('verification code is 123456')
  await field(page, 'Text').fill('No code here')
  await expect(page.getByText('Would be refused: the text must contain {{code}}.')).toBeVisible()
  await expect(field(page, 'Text')).toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByText(/^No preview: this wording would be refused/)).toBeVisible()
  await expectScreenAccessible(page, 'messages, a text message that would be refused')

  await field(page, 'Text').fill('Welcome to the club. Use ')
  await page.getByRole('button', { name: 'Insert {{code}} into the text (required)' }).click()
  await expect(previewText(page)).toContainText('Welcome to the club. Use 123456')
  await expect(
    page.getByText(/^Sent as 1 text message: \d+ characters of the GSM alphabet\.$/)
  ).toBeVisible()
  await expectScreenAccessible(page, 'messages, a text message in its own wording')

  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Settings saved')).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: 'No unsaved changes.' })).toBeVisible()

  // Still there after a reload, for both messages.
  await page.reload()
  await expect(page.getByRole('heading', { level: 1, name: 'Messages' })).toBeVisible()
  await expect(field(page, 'Subject')).toHaveValue('{{code}} opens {{appName}}')
  await expect(kind(page, /^Email verification code/)).toContainText('Own wording')
  await expect(kind(page, /^Phone number code/)).toContainText('Own wording')
  await expect(kind(page, /^Texted sign-in code/)).toContainText('Built-in')
  await kind(page, /^Phone number code/).click()
  await expect(field(page, 'Text')).toHaveValue('Welcome to the club. Use {{code}}')

  // And the email a sign-up sends is in those words, with the markup as text.
  const email = uniqueEmail('wording')
  const visitor = await browser.newContext()
  await signUpInExampleApp(await visitor.newPage(), email)
  await visitor.close()
  const outbox = await page.request.get(`${API_URL}/__test/outbox?to=${encodeURIComponent(email)}`)
  const { data } = (await outbox.json()) as { data: { subject: string; text: string }[] }
  const sent = data.find((message) => /^\d{6} opens /.test(message.subject))
  expect(sent?.text).toContain('Welcome <b>aboard</b>.')
  expect(sent?.text).toMatch(/Your code: \d{6}/)
})

test('wording is reset to the built-in text, and a refused save names the field', async ({
  page,
}) => {
  await open(page, `${ENVIRONMENT_PATH}/messages`, 'Messages')
  await kind(page, /^Password changed/).click()
  await field(page, 'Subject').fill('Your password changed')
  await field(page, 'Body').fill('Enter {{code}} to keep your account.')
  // A notice can never carry a code: said at once, and by the server when saved anyway.
  await expect(page.getByText(/^Would be refused: .*\{\{code\}\}/)).toBeVisible()
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('These settings were not saved.')).toBeVisible()
  await expect(page.getByText('emails.templates.password_changed.body')).toBeVisible()
  await expect(kind(page, /^Password changed/)).toContainText('Refused')
  await expectScreenAccessible(page, 'messages, a save the server refused')

  await page.getByRole('button', { name: 'Reset to built-in' }).click()
  await expect(field(page, 'Subject')).toHaveValue('')
  await expect(field(page, 'Body')).toHaveValue('')
  await expect(page.getByText('This message is sent in the built-in wording.')).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: 'No unsaved changes.' })).toBeVisible()
  await expect(previewText(page)).not.toContainText('Enter')
})
