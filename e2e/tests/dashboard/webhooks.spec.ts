import type { Page } from '@playwright/test'
import { API_URL } from '../support'
import {
  dialog,
  ENVIRONMENT_PATH,
  expect,
  expectNoSecretKept,
  expectScreenAccessible,
  open,
  signIn,
  test,
} from './support'

// Webhooks: an endpoint from registration to deletion, against the real API and its real
// outbound guard. The receiver is the fixture's own (`e2e/server.ts`), on the loopback
// address: the one place the guard of a `local` deployment lets a delivery go without a name
// to resolve. It answers with the status its path names.

const RECEIVER = 'http://127.0.0.1:4320/receive'

/** One round of the webhook worker, which the fixture runs only when asked. */
async function runWorker(page: Page): Promise<void> {
  const response = await page.request.post(`${API_URL}/__test/webhook-round`)
  expect(response.ok()).toBe(true)
}

const DESKTOP = { width: 1280, height: 720 }
const PHONE = { width: 375, height: 812 }

/** How far the page can be scrolled sideways, in pixels. */
function sidewaysScroll(page: Page): Promise<number> {
  return page.evaluate(() =>
    Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth)
  )
}

function card(page: Page, address: string) {
  return page.getByRole('region', { name: address, exact: true })
}

test.beforeEach(async ({ page }) => {
  await signIn(page)
})

test('an endpoint: its secret shown once, a delivery that fails and is sent again, a test event', async ({
  page,
}) => {
  const gone = `${RECEIVER}/410?run=${Date.now()}`
  const fine = `${RECEIVER}/204?run=${Date.now()}`
  await open(page, `${ENVIRONMENT_PATH}/webhooks`, 'Webhooks')
  await expectScreenAccessible(page, 'webhooks, the list')

  // Refusals of the form itself, then of the server's guard, in words.
  await page.getByRole('button', { name: 'Add endpoint' }).click()
  await dialog(page).getByRole('button', { name: 'Add endpoint' }).click()
  await expect(dialog(page).getByRole('alert')).toHaveText([
    'Enter the address of your endpoint, starting with https://.',
    'Choose at least one event type.',
  ])
  await expectScreenAccessible(page, 'add an endpoint, with errors')
  await dialog(page).getByLabel('Address').fill('http://10.0.0.8/in')
  await dialog(page).getByRole('checkbox', { name: 'webhook_endpoint.updated' }).check()
  await dialog(page).getByRole('button', { name: 'Add endpoint' }).click()
  await expect(dialog(page).getByRole('alert')).toHaveText(
    'The address leads to a private or local network address, which the server does not call. Use an address on the public internet.'
  )

  await dialog(page).getByLabel('Address').fill(gone)
  await dialog(page).getByRole('button', { name: 'Add endpoint' }).click()
  await expect(dialog(page)).toContainText('Copy the signing secret now')
  const secret = (await dialog(page).getByTestId('webhook-secret').textContent()) ?? ''
  expect(secret).toMatch(/^whsec_/)
  await expectScreenAccessible(page, 'the signing secret, shown once')
  await dialog(page).getByRole('button', { name: 'I have copied it' }).click()
  await expect(dialog(page)).toBeHidden()
  await expectNoSecretKept(page, [secret])
  await expect(card(page, gone).getByTestId('endpoint-state')).toContainText('Active')

  // The form opens empty again, and a reload brings nothing back.
  await page.getByRole('button', { name: 'Add endpoint' }).click()
  await expect(dialog(page).getByLabel('Address')).toHaveValue('')
  await page.keyboard.press('Escape')
  await page.reload()
  await expect(page.getByRole('heading', { level: 1, name: 'Webhooks' })).toBeVisible()
  await expectNoSecretKept(page, [secret])

  // An edit is an event the endpoint itself is owed. The receiver answers 410 to it: the
  // delivery is given up at once and the server switches the endpoint off.
  await card(page, gone)
    .getByRole('button', { name: `Edit ${gone}` })
    .click()
  await expectScreenAccessible(page, 'edit an endpoint')
  await dialog(page).getByRole('checkbox', { name: 'user.created' }).check()
  await dialog(page).getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Endpoint saved')).toBeVisible()
  await runWorker(page)
  await page.reload()
  const state = card(page, gone).getByTestId('endpoint-state')
  await expect(state).toHaveAttribute('data-state', 'off-by-server')
  await expect(state).toContainText('Switched off by the server')
  await expect(state).toContainText('It answered “410 Gone”')
  await expectScreenAccessible(page, 'an endpoint the server switched off')

  await card(page, gone).getByRole('link', { name: 'Deliveries' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Webhook endpoint' })).toBeVisible()
  const deliveries = page.getByRole('table', { name: 'Deliveries' })
  const row = deliveries.getByRole('row').filter({ hasText: 'webhook_endpoint.updated' })
  await expect(row).toContainText('Failed')
  await expect(row).toContainText('HTTP 410')
  await expectScreenAccessible(page, 'an endpoint and its deliveries')

  // At a phone's width the table is stacked and the long address wraps: nothing scrolls
  // sideways.
  await page.setViewportSize(PHONE)
  await expect(row).toContainText('HTTP 410')
  expect(await sidewaysScroll(page), 'sideways scroll on an endpoint’s screen').toBe(0)
  await expectScreenAccessible(page, 'an endpoint and its deliveries at 375px')
  await page.setViewportSize(DESKTOP)

  // The filters and the page are the address.
  await page.getByLabel('State').selectOption('delivered')
  await expect(page).toHaveURL(/\?state=delivered$/)
  await expect(page.getByText('No delivery matches these filters')).toBeVisible()
  await page.getByRole('button', { name: 'Clear filters' }).click()
  await expect(page).not.toHaveURL(/state=/)

  await row
    .getByRole('link', { name: /^Attempts of the webhook_endpoint\.updated delivery/ })
    .click()
  await expect(page.getByRole('heading', { level: 1, name: 'Delivery' })).toBeVisible()
  const attempts = page.getByRole('table', { name: 'Requests made for this delivery' })
  await expect(attempts.getByRole('row')).toHaveCount(2)
  await expect(attempts.getByRole('row').nth(1)).toContainText('HTTP 410')
  await expect(page.getByTestId('delivery-facts')).toContainText(gone)
  await expectScreenAccessible(page, 'a delivery and its attempts')
  await page.setViewportSize(PHONE)
  await expect(attempts.getByRole('row').nth(1)).toContainText('HTTP 410')
  expect(await sidewaysScroll(page), 'sideways scroll on a delivery’s screen').toBe(0)
  await page.setViewportSize(DESKTOP)

  // Sent again while the endpoint is off: refused, in words.
  await page.getByRole('button', { name: 'Send again' }).click()
  await expect(page.getByRole('alert')).toHaveText(
    'The endpoint is switched off, and nothing is sent to one that is. Switch it on first.'
  )
  await expectScreenAccessible(page, 'a delivery that cannot be sent again')

  // Point the endpoint at a receiver that takes deliveries, and switch it on.
  await page.getByRole('link', { name: '← Deliveries of this endpoint' }).click()
  await card(page, gone)
    .getByRole('button', { name: `Edit ${gone}` })
    .click()
  await dialog(page).getByLabel('Address').fill(fine)
  await dialog(page).getByRole('button', { name: 'Save changes' }).click()
  await expect(dialog(page)).toBeHidden()
  await card(page, fine)
    .getByRole('button', { name: `Switch on ${fine}` })
    .click()
  await expect(dialog(page)).toContainText(`Switch on ${fine}?`)
  await expectScreenAccessible(page, 'confirm switching an endpoint on')
  await dialog(page).getByRole('button', { name: 'Switch on' }).click()
  await expect(card(page, fine).getByTestId('endpoint-state')).toHaveAttribute(
    'data-state',
    'active'
  )

  await row.getByRole('link', { name: /^Attempts of/ }).click()
  await page.getByRole('button', { name: 'Send again' }).click()
  await expect(page.getByTestId('send-result')).toHaveText(
    /^Delivered: the endpoint answered 204 in \d+ ms\.$/
  )
  await expect(attempts.getByRole('row')).toHaveCount(3)
  await expect(attempts.getByRole('row').nth(2)).toContainText('HTTP 204')
  await expectScreenAccessible(page, 'a delivery sent again')

  // A test event: the type and nothing else is chosen; the result is the receiver's answer.
  await page.getByRole('link', { name: '← Deliveries of this endpoint' }).click()
  await card(page, fine)
    .getByRole('button', { name: `Send a test event to ${fine}` })
    .click()
  await expect(dialog(page)).toContainText('"test": true')
  await dialog(page).getByLabel('Event type').selectOption('session.revoked')
  await dialog(page).getByRole('button', { name: 'Send test event' }).click()
  await expect(dialog(page).getByTestId('send-result')).toHaveText(
    /^Delivered: the endpoint answered 204 in \d+ ms\.$/
  )
  await expectScreenAccessible(page, 'a test event and its result')
  await dialog(page).getByRole('button', { name: 'Close' }).click()
  await expect(deliveries.getByRole('row').filter({ hasText: 'session.revoked' })).toContainText(
    'Test event'
  )
  await expectNoSecretKept(page, [secret])
})

test('a secret is rotated with an overlap, the overlap is ended, and the endpoint is deleted', async ({
  page,
}) => {
  const address = `${RECEIVER}/204?rotate=${Date.now()}`
  await open(page, `${ENVIRONMENT_PATH}/webhooks`, 'Webhooks')
  await page.getByRole('button', { name: 'Add endpoint' }).click()
  await dialog(page).getByLabel('Address').fill(address)
  await dialog(page).getByRole('checkbox', { name: 'user.created' }).check()
  await dialog(page).getByRole('button', { name: 'Add endpoint' }).click()
  const first = (await dialog(page).getByTestId('webhook-secret').textContent()) ?? ''
  // The form became the secret under the reader: the focus is on what the dialog now says.
  await expect(
    dialog(page).getByRole('heading', { name: 'Copy the signing secret now' })
  ).toBeFocused()
  // Escape closes the dialog as the button does, and takes the secret with it.
  await page.keyboard.press('Escape')
  await expect(dialog(page)).toBeHidden()
  // Checked at once, with no wait: the secret has left the document before the dialog is
  // seen to be closed.
  await expectNoSecretKept(page, [first])

  await card(page, address)
    .getByRole('button', { name: `Rotate the secret of ${address}` })
    .click()
  await expect(dialog(page)).toContainText('Rotate the signing secret?')
  await expectScreenAccessible(page, 'confirm rotating a secret')
  await dialog(page).getByRole('button', { name: 'Rotate secret' }).click()
  await expect(dialog(page)).toContainText('Copy the new secret now')
  const second = (await dialog(page).getByTestId('webhook-secret').textContent()) ?? ''
  expect(second).toMatch(/^whsec_/)
  expect(second).not.toBe(first)
  await expect(dialog(page).getByTestId('overlap-ends')).toContainText(
    'The previous secret keeps signing beside it until'
  )
  await expectScreenAccessible(page, 'the rotated secret, shown once')
  await dialog(page).getByRole('button', { name: 'I have copied it' }).click()
  await expect(dialog(page)).toBeHidden()
  await expectNoSecretKept(page, [first, second])

  const overlap = card(page, address).getByTestId('rotation-overlap')
  await expect(overlap).toContainText('Two secrets are signing')
  await expectScreenAccessible(page, 'an endpoint with two secrets signing')

  // A second rotation during the overlap is refused, in words.
  await card(page, address)
    .getByRole('button', { name: `Rotate the secret of ${address}` })
    .click()
  await dialog(page).getByRole('button', { name: 'Rotate secret' }).click()
  await expect(dialog(page).getByRole('alert')).toHaveText(
    'A rotation is already under way: two secrets are signing, and an endpoint never has three. End the overlap first, or wait for it to end.'
  )
  await dialog(page).getByRole('button', { name: 'Cancel' }).click()

  await overlap.getByRole('button', { name: `End the secret overlap of ${address} now` }).click()
  await expect(dialog(page)).toContainText('The previous secret stops signing at once')
  await expectScreenAccessible(page, 'confirm ending the overlap')
  // The dialog names the endpoint it acts on.
  await expect(dialog(page).getByRole('heading')).toHaveText(
    `End the secret overlap of ${address} now?`
  )
  await dialog(page).getByRole('button', { name: 'End the overlap' }).click()
  await expect(page.getByText('Overlap ended: one secret signs')).toBeVisible()
  await expect(overlap).toBeHidden()
  // The button that had the focus went with the overlap: the endpoint's name has it now.
  await expect(card(page, address).getByRole('heading', { level: 2 })).toBeFocused()

  await card(page, address)
    .getByRole('button', { name: `Switch off ${address}` })
    .click()
  await dialog(page).getByRole('button', { name: 'Switch off' }).click()
  await expect(card(page, address).getByTestId('endpoint-state')).toHaveAttribute(
    'data-state',
    'off'
  )
  await expectScreenAccessible(page, 'an endpoint an operator switched off')

  await card(page, address)
    .getByRole('button', { name: `Delete ${address}` })
    .click()
  await expect(dialog(page)).toContainText(`Delete ${address}?`)
  await expect(dialog(page)).toContainText(
    'its pending deliveries and the log of everything delivered to it are deleted with it'
  )
  await expectScreenAccessible(page, 'confirm deleting an endpoint')
  await dialog(page).getByRole('button', { name: 'Delete endpoint' }).click()
  await expect(page.getByText('Endpoint deleted')).toBeVisible()
  await expect(card(page, address)).toHaveCount(0)
  // The card and its dialog are gone, and the focus with them: the page's heading has it.
  await expect(page.getByRole('heading', { level: 1, name: 'Webhooks' })).toBeFocused()
  await page.reload()
  await expect(page.getByRole('heading', { level: 1, name: 'Webhooks' })).toBeVisible()
  await expectNoSecretKept(page, [first, second])

  // Every change is in the audit log, and neither secret nor the address is.
  await open(page, `${ENVIRONMENT_PATH}/audit-log`, 'Audit log')
  const entries = page.getByRole('table', { name: 'Audit entries' })
  await expect(entries).toContainText('webhook_endpoint.secret_rotated')
  await expect(entries).toContainText('webhook_endpoint.previous_secret_revoked')
  await expect(entries).toContainText('webhook_endpoint.deleted')
  const log = await entries.innerHTML()
  expect(log).not.toContain(first)
  expect(log).not.toContain(second)
  expect(log).not.toContain('/receive/')
})

test('a long address with nowhere to break wraps at a phone’s width, wherever it is shown', async ({
  page,
}) => {
  // 600 characters with no space, hyphen or slash to break at.
  const long = `${RECEIVER}/204?long=${Date.now()}&q=${'a'.repeat(600)}`
  await open(page, `${ENVIRONMENT_PATH}/webhooks`, 'Webhooks')
  await page.getByRole('button', { name: 'Add endpoint' }).click()
  await dialog(page).getByLabel('Address').fill(long)
  await dialog(page).getByRole('checkbox', { name: 'user.created' }).check()
  await dialog(page).getByRole('button', { name: 'Add endpoint' }).click()
  await expect(dialog(page)).toContainText('Copy the signing secret now')
  await dialog(page).getByRole('button', { name: 'I have copied it' }).click()
  await expect(dialog(page)).toBeHidden()
  await expect(card(page, long)).toBeVisible()

  /** Whether the open dialog lies inside the window and nothing in it scrolls sideways. */
  async function dialogFits(): Promise<{ inside: boolean; overflow: number }> {
    return dialog(page).evaluate((element) => {
      const box = element.getBoundingClientRect()
      return {
        inside: box.left >= 0 && box.right <= window.innerWidth,
        overflow: Math.max(0, element.scrollWidth - element.clientWidth),
      }
    })
  }

  await page.setViewportSize(PHONE)
  expect(await sidewaysScroll(page), 'sideways scroll on the list').toBe(0)
  await expectScreenAccessible(page, 'the list with a long address at 375px')

  // Every dialog that names the endpoint: in its title (delete, switch off) or its text.
  for (const [control, close] of [
    [`Delete ${long}`, 'Cancel'],
    [`Switch off ${long}`, 'Cancel'],
    [`Rotate the secret of ${long}`, 'Cancel'],
    [`Send a test event to ${long}`, 'Close'],
  ] as const) {
    await card(page, long).getByRole('button', { name: control }).click()
    await expect(dialog(page)).toContainText('a'.repeat(600))
    expect(await dialogFits(), `the dialog of “${control.slice(0, 20)}…”`).toEqual({
      inside: true,
      overflow: 0,
    })
    expect(await sidewaysScroll(page), `sideways scroll under “${control.slice(0, 20)}…”`).toBe(0)
    if (control.startsWith('Delete')) {
      await expectScreenAccessible(page, 'deleting an endpoint with a long address at 375px')
    }
    await dialog(page).getByRole('button', { name: close }).click()
    await expect(dialog(page)).toBeHidden()
  }

  await card(page, long).getByRole('link', { name: 'Deliveries' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Webhook endpoint' })).toBeVisible()
  await expect(card(page, long)).toBeVisible()
  expect(await sidewaysScroll(page), 'sideways scroll on the endpoint’s screen').toBe(0)
  await expectScreenAccessible(page, 'an endpoint with a long address at 375px')

  // Deleted from its own screen: back at the list, which no longer has it.
  await card(page, long)
    .getByRole('button', { name: `Delete ${long}` })
    .click()
  await dialog(page).getByRole('button', { name: 'Delete endpoint' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Webhooks' })).toBeVisible()
  await expect(card(page, long)).toHaveCount(0)
  await page.setViewportSize(DESKTOP)
})
