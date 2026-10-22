import { readFileSync } from 'node:fs'
import { expect, type Page, test } from '@playwright/test'
import { expectAccessible } from '../support'

// The documentation site (apps/docs), built from docs/** and served as static files. Every page
// is opened, checked with axe in both themes (no rule disabled) and measured at a phone's width.
// The list of pages is the one the build wrote (`pages.json`), so a page cannot be left out.

const pages = JSON.parse(
  readFileSync(`${import.meta.dirname}/../../../apps/docs/dist/pages.json`, 'utf8')
) as string[]

/** A page that fails to load, logs an error or throws fails the test that opened it. */
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

test.describe('the documentation site', () => {
  test('the build wrote pages, and they include the landing page and the error codes', () => {
    expect(pages.length).toBeGreaterThan(40)
    expect(pages).toContain('/')
    expect(pages).toContain('/quickstart/')
    expect(pages).toContain('/methods/password/')
    expect(pages).toContain('/reference/error-codes/')
  })

  for (const route of pages) {
    test(`${route} renders, is accessible in light and dark, and fits a phone`, async ({
      page,
    }) => {
      // axe on the largest reference pages (a megabyte of HTML) takes a minute a theme.
      test.setTimeout(300_000)
      const problems = watch(page)
      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme })
        await page.goto(route)
        // With no choice made the site follows the system, and says so on the root.
        await expect(page.locator('html')).toHaveAttribute('data-theme', scheme)
        await expect(page.locator('main h1').first()).toBeVisible()
        await expectAccessible(page, `${route} (${scheme})`)
      }

      await page.setViewportSize({ width: 375, height: 800 })
      await page.goto(route)
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      )
      expect(overflow, `${route} scrolls sideways at 375px`).toBeLessThanOrEqual(0)
      expect(problems).toEqual([])
    })
  }

  test('an unknown address answers 404 with the site’s own page', async ({ page }) => {
    const response = await page.goto('/no/such/page/')
    expect(response?.status()).toBe(404)
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible()
  })

  test('the theme toggle switches the page and the choice is kept', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await page.goto('/quickstart/')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.getByRole('button', { name: 'Dark theme' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(page.getByRole('button', { name: 'Dark theme' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expectAccessible(page, 'quickstart after choosing dark')
  })

  test('searching an error code finds its anchor, and following it lands on the code', async ({
    page,
  }) => {
    await page.goto('/')
    await page
      .getByRole('searchbox', { name: 'Search the documentation' })
      .fill('password.too_short')
    const first = page.getByRole('list', { name: 'Search results' }).getByRole('link').first()
    await expect(first).toHaveAttribute('href', '/reference/error-codes/#password.too_short')
    await first.click()
    await expect(page).toHaveURL(/\/reference\/error-codes\/#password\.too_short$/)
    await expect(page.locator('[id="password.too_short"]')).toBeInViewport()
  })

  test('search finds prose, and Escape closes the results', async ({ page }) => {
    await page.goto('/')
    const box = page.getByRole('searchbox', { name: 'Search the documentation' })
    await box.fill('quickstart')
    await expect(
      page.getByRole('list', { name: 'Search results' }).getByRole('link').first()
    ).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('list', { name: 'Search results' }).getByRole('link')).toHaveCount(
      0
    )
  })

  test('the menu button opens the sidebar on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 })
    await page.goto('/quickstart/')
    const sidebar = page.getByRole('navigation', { name: 'Documentation' })
    await expect(sidebar).toBeHidden()
    await page.getByRole('button', { name: 'Menu' }).click()
    await expect(sidebar).toBeVisible()
    await expectAccessible(page, 'quickstart with the menu open')
  })

  test('relative links between pages lead to the site’s routes, with their anchors', async ({
    page,
  }) => {
    await page.goto('/methods/password/')
    const link = page.locator('main a[href^="/"]').first()
    await expect(link).toBeVisible()
    const href = (await link.getAttribute('href')) as string
    expect(pages).toContain(href.split('#')[0])
  })
})
