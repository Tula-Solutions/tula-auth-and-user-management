import { expect, type Page, test } from '@playwright/test'
import { resolveBase } from '../../../apps/docs/src/lib/paths'
import { expectAccessible } from '../support'

// The language tabs (`<!-- tabs -->`) of the audit export page: the cURL, TypeScript and Python
// versions of one call, driven in a browser.

const BASE = resolveBase()
const PAGE = `${BASE}audit-export/`

/** The first language group of the page. */
function group(page: Page) {
  return page.locator('[data-docs-tabs][data-sync="language"]').first()
}

test('the tabs are named cURL, TypeScript and Python, and cURL is shown first', async ({
  page,
}) => {
  await page.goto(PAGE)
  const tabs = group(page).getByRole('tab')
  await expect(tabs).toHaveText(['cURL', 'TypeScript', 'Python'])
  await expect(tabs.first()).toHaveAttribute('aria-selected', 'true')
  await expect(group(page).getByRole('tabpanel')).toContainText('curl -sN')
})

test('the arrow keys, Home and End move between the tabs', async ({ page }) => {
  await page.goto(PAGE)
  await group(page).getByRole('tab', { name: 'cURL' }).focus()
  await page.keyboard.press('ArrowRight')
  await expect(group(page).getByRole('tab', { name: 'TypeScript' })).toBeFocused()
  await expect(group(page).getByRole('tabpanel')).toContainText('admin.stream')
  await page.keyboard.press('End')
  await expect(group(page).getByRole('tab', { name: 'Python' })).toBeFocused()
  await expect(group(page).getByRole('tabpanel')).toContainText('urllib.request')
  await page.keyboard.press('ArrowRight')
  await expect(group(page).getByRole('tab', { name: 'cURL' })).toBeFocused()
  await page.keyboard.press('Home')
  await expect(group(page).getByRole('tab', { name: 'cURL' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
})

test('the language is carried to every group of the page and across a navigation', async ({
  page,
}) => {
  await page.goto(PAGE)
  await group(page).getByRole('tab', { name: 'Python' }).click()
  const selected = page.locator('[data-sync="language"] [role="tab"][aria-selected="true"]')
  await expect(selected).toHaveText(['Python', 'Python'])
  await page.goto(`${BASE}quickstart/`)
  await page.goto(PAGE)
  await expect(selected).toHaveText(['Python', 'Python'])
  await expect(group(page).getByRole('tabpanel')).toContainText('urllib.request')
})

for (const scheme of ['light', 'dark'] as const) {
  test(`the page is accessible in ${scheme} with the Python tab chosen`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await page.goto(PAGE)
    await group(page).getByRole('tab', { name: 'Python' }).click()
    await expectAccessible(page, `audit-export (${scheme})`)
  })
}
