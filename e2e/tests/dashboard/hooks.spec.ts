import type { Page } from '@playwright/test'
import { API_URL, uniqueEmail } from '../support'
import {
  dialog,
  ENVIRONMENT_ID,
  ENVIRONMENT_PATH,
  expect,
  expectNoSecretKept,
  expectScreenAccessible,
  open,
  signIn,
  signUpInExampleApp,
  test,
} from './support'

// Hooks: one point's hook from registration to removal, against the real API and its real
// outbound guard. The endpoint is the fixture's receiver (`e2e/receiver.ts`), on the loopback
// address: the one place the guard of a `local` deployment lets a call go. It answers with
// the status its path names and no body, so every call of it fails: a 500 is not a 2xx.

const RECEIVER = 'http://127.0.0.1:4320/receive'
const DASHBOARD = {
  'x-tula-dashboard': '1',
  'x-tula-environment': ENVIRONMENT_ID,
  origin: API_URL,
}

function card(page: Page, point: string) {
  return page.locator(`[data-testid="hook-point"][data-point="${point}"]`)
}

/** The environment's hooks, read as the dashboard reads them. */
async function hooks(page: Page): Promise<{ id: string; point: string; enabled: boolean }[]> {
  const response = await page.request.get(`${API_URL}/v1/admin/hooks`, { headers: DASHBOARD })
  expect(response.ok()).toBe(true)
  return ((await response.json()) as { data: { id: string; point: string; enabled: boolean }[] })
    .data
}

test.beforeEach(async ({ page }) => {
  await signIn(page)
})

// The fixture's environment is every later spec's too: a hook left behind by a test that
// failed half-way would be asked at their sign-ups.
test.afterEach(async ({ page }) => {
  for (const hook of await hooks(page)) {
    await page.request.delete(`${API_URL}/v1/admin/hooks/${hook.id}`, { headers: DASHBOARD })
  }
  expect(await hooks(page)).toEqual([])
})

test('a hook: asked about before it lets through, its secret shown once, a failed call, then edited, switched off and removed', async ({
  page,
}) => {
  const failing = `${RECEIVER}/500?run=${Date.now()}`
  await open(page, `${ENVIRONMENT_PATH}/hooks`, 'Hooks')
  await expect(page.getByTestId('hook-point')).toHaveCount(3)
  await expect(page.getByTestId('hook-none')).toHaveCount(3)
  await expectScreenAccessible(page, 'hooks, no point has one')

  // Refusals of the form itself, then of the server's guard, in words.
  await page.getByRole('button', { name: 'Add a hook for before_sign_up' }).click()
  await dialog(page).getByLabel('Deadline (milliseconds)').fill('9000')
  await dialog(page).getByRole('button', { name: 'Add hook' }).click()
  await expect(dialog(page).getByRole('alert')).toHaveText([
    'Enter the address of your endpoint, starting with https://.',
    'Enter a whole number of milliseconds from 100 to 5000.',
  ])
  await expectScreenAccessible(page, 'add a hook, with errors')
  await dialog(page).getByLabel('Deadline (milliseconds)').fill('1500')
  await dialog(page).getByLabel('Address').fill('http://10.0.0.8/in')
  await dialog(page).getByRole('button', { name: 'Add hook' }).click()
  await expect(dialog(page).getByRole('alert')).toHaveText(
    'The address leads to a private or local network address, which the server does not call. Use an address on the public internet.'
  )

  // "Let it through" is asked about before anything is sent.
  await dialog(page).getByLabel('Address').fill(failing)
  await dialog(page).getByLabel('When a call fails').selectOption('allow')
  await dialog(page).getByRole('button', { name: 'Add hook' }).click()
  await expect(dialog(page).getByRole('heading')).toHaveText('Let it through when a call fails?')
  await expect(dialog(page).getByTestId('weakening')).toContainText(
    'When a call of this hook fails, the sign-up goes ahead and the account is created, as if there were no hook.'
  )
  expect(await hooks(page)).toEqual([])
  await expectScreenAccessible(page, 'the question before a hook lets through')

  await dialog(page).getByRole('button', { name: 'Add hook' }).click()
  await expect(dialog(page)).toContainText('Copy the signing secret now')
  const secret = (await dialog(page).getByTestId('hook-secret').textContent()) ?? ''
  expect(secret).toMatch(/^whsec_/)
  await expectScreenAccessible(page, 'a hook’s signing secret, shown once')
  await dialog(page).getByRole('button', { name: 'I have copied it' }).click()
  await expect(dialog(page)).toBeHidden()
  await expectNoSecretKept(page, [secret])
  const signUp = card(page, 'before_sign_up')
  await expect(signUp.getByTestId('hook-state')).toHaveAttribute('data-state', 'on-allowing')
  await expect(signUp.getByTestId('hook-last-failure')).toHaveAttribute('data-outcome', 'none')
  await expect(signUp).toContainText('1500 ms')
  await page.reload()
  await expect(card(page, 'before_sign_up')).toContainText(failing)
  await expectNoSecretKept(page, [secret])
  await expectScreenAccessible(page, 'hooks, one that lets through on failure')

  // A real sign-up asks it. The receiver answers 500, the hook lets the sign-up through,
  // and the screen says what the server recorded: the failed call, and nothing of a body.
  await signUpInExampleApp(page, uniqueEmail('hook'))
  await open(page, `${ENVIRONMENT_PATH}/hooks`, 'Hooks')
  const failed = card(page, 'before_sign_up').getByTestId('hook-last-failure')
  await expect(failed).toHaveAttribute('data-outcome', 'failed')
  await expect(failed).toContainText('The endpoint answered with a status that is not 2xx.')
  await expect(failed).toContainText(
    'A call that was answered, with an allow or a denial, leaves no record here.'
  )
  await expectScreenAccessible(page, 'a hook whose last call failed')
  await page.setViewportSize({ width: 375, height: 812 })
  expect(
    await page.evaluate(() =>
      Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth)
    )
  ).toBe(0)
  await expectScreenAccessible(page, 'a hook whose last call failed, at 375px')
  await page.setViewportSize({ width: 1280, height: 720 })

  // Back to refusing on failure: no weakening, so nothing is asked.
  await page.getByRole('button', { name: 'Edit the hook for before_sign_up' }).click()
  await expect(dialog(page).getByLabel('Address')).toHaveValue(failing)
  await expectScreenAccessible(page, 'edit a hook')
  await dialog(page).getByLabel('When a call fails').selectOption('deny')
  await dialog(page).getByRole('button', { name: 'Save changes' }).click()
  await expect(dialog(page)).toBeHidden()
  await expect(card(page, 'before_sign_up').getByTestId('hook-state')).toHaveAttribute(
    'data-state',
    'on'
  )

  // And to "let it through" again by an edit: asked about, and here cancelled.
  await page.getByRole('button', { name: 'Edit the hook for before_sign_up' }).click()
  await dialog(page).getByLabel('When a call fails').selectOption('allow')
  await dialog(page).getByRole('button', { name: 'Save changes' }).click()
  await expect(dialog(page).getByRole('heading')).toHaveText('Let it through when a call fails?')
  await expectScreenAccessible(page, 'the question before an edit lets through')
  await dialog(page).getByRole('button', { name: 'Cancel' }).click()
  await dialog(page).getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog(page)).toBeHidden()

  // Switching off says what is lost.
  await page.getByRole('button', { name: 'Switch off the hook for before_sign_up' }).click()
  await expect(dialog(page)).toContainText(
    'It is no longer asked: every sign-up goes ahead, as if there were no hook.'
  )
  await expectScreenAccessible(page, 'confirm switching a hook off')
  await dialog(page).getByRole('button', { name: 'Switch off' }).click()
  await expect(dialog(page)).toBeHidden()
  await expect(card(page, 'before_sign_up').getByTestId('hook-state')).toHaveAttribute(
    'data-state',
    'off'
  )
  expect((await hooks(page)).map((hook) => [hook.point, hook.enabled])).toEqual([
    ['before_sign_up', false],
  ])
  await expectScreenAccessible(page, 'a hook that is switched off')

  await page.getByRole('button', { name: 'Remove the hook for before_sign_up' }).click()
  await expect(dialog(page)).toContainText(
    'Its signing secret is deleted with it and cannot be brought back.'
  )
  await expectScreenAccessible(page, 'confirm removing a hook')
  await dialog(page).getByRole('button', { name: 'Remove hook' }).click()
  await expect(dialog(page)).toBeHidden()
  await expect(page.getByTestId('hook-none')).toHaveCount(3)
  // The button that was used is gone with the hook: the point's name has the focus.
  await expect(card(page, 'before_sign_up').getByRole('heading', { level: 2 })).toBeFocused()
  expect(await hooks(page)).toEqual([])
})
