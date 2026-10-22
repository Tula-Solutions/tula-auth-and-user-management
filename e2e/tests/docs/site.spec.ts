import { readFileSync } from 'node:fs'
import { expect, type Page, test } from '@playwright/test'
import { BEYOND_INTRODUCTION, CHUNK_THRESHOLD, chunksOf, selectorsOf } from '../../chunks'
import { expectAccessible } from '../support'

// The documentation site (apps/docs), built from docs/** and served as static files. Every page
// is opened, checked with axe in both themes (no rule disabled) and measured at a phone's width.
// The list of pages is the one the build wrote (`pages.json`), so a page cannot be left out.

const pages = JSON.parse(
  readFileSync(`${import.meta.dirname}/../../../apps/docs/dist/pages.json`, 'utf8')
) as string[]

// The size of each page and of its content sections, as the build measured them.
const pageStats = JSON.parse(
  readFileSync(`${import.meta.dirname}/../../../apps/docs/dist/page-stats.json`, 'utf8')
) as Record<string, { bytes: number; sections: number[] }>

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

  // A small page is checked whole, one test a theme. A page above CHUNK_THRESHOLD (the generated
  // reference pages, up to a megabyte and a half, on which axe alone takes minutes) is checked in
  // pieces that together cover it, none of it skipped and no rule disabled: the frame (the page
  // without the content past its introduction, so the outline and the page-level rules still
  // see it) and each run of sections, a test of its own per theme, spread over the workers.
  for (const route of pages) {
    const stats = pageStats[route]
    const chunks =
      stats !== undefined && stats.bytes > CHUNK_THRESHOLD ? chunksOf(stats.sections) : []
    for (const scheme of ['light', 'dark'] as const) {
      async function open(page: Page): Promise<string[]> {
        const problems = watch(page)
        await page.emulateMedia({ colorScheme: scheme })
        await page.goto(route)
        // With no choice made the site follows the system, and says so on the root.
        await expect(page.locator('html')).toHaveAttribute('data-theme', scheme)
        await expect(page.locator('main h1').first()).toBeVisible()
        return problems
      }

      if (chunks.length === 0) {
        test(`${route} renders and is accessible in ${scheme}`, async ({ page }) => {
          const problems = await open(page)
          await expectAccessible(page, `${route} (${scheme})`)
          expect(problems).toEqual([])
        })
        continue
      }

      test(`${route} renders and its frame is accessible in ${scheme}`, async ({ page }) => {
        const problems = await open(page)
        await expectAccessible(page, `${route} frame (${scheme})`, {
          exclude: [BEYOND_INTRODUCTION],
        })
        expect(problems).toEqual([])
      })
      for (const chunk of chunks) {
        test(`${route} sections ${chunk.from} to ${chunk.to} are accessible in ${scheme}`, async ({
          page,
        }) => {
          await open(page)
          await expectAccessible(page, `${route} sections ${chunk.from}-${chunk.to} (${scheme})`, {
            include: selectorsOf(chunk),
          })
        })
      }
    }

    test(`${route} is cut into sections that hold all its content`, async ({ page }) => {
      await page.goto(route)
      const children = await page
        .locator('article.doc > *')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-docs-section')))
      // Every child of the content is a section, numbered in order, and the build measured the
      // same number: nothing sits outside a section, so nothing escapes the pieces.
      expect(children).toEqual(children.map((_, index) => String(index)))
      expect(children.length, `${route} sections in the page and in page-stats.json`).toBe(
        stats?.sections.length
      )
      // And the pieces of a chunked page are exactly the sections after the introduction.
      if (chunks.length > 0) {
        expect(chunks.flatMap((chunk) => selectorsOf(chunk))).toEqual(
          children.slice(1).map((_, index) => `[data-docs-section="${index + 1}"]`)
        )
      }
    })

    test(`${route} fits a phone`, async ({ page }) => {
      const problems = watch(page)
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

  test('search results are reached and left with the arrow keys, and Enter follows the first', async ({
    page,
  }) => {
    await page.goto('/')
    const box = page.getByRole('searchbox', { name: 'Search the documentation' })
    await box.fill('password')
    const links = page.getByRole('list', { name: 'Search results' }).getByRole('link')
    await expect(links.nth(1)).toBeVisible()
    await page.keyboard.press('ArrowDown')
    await expect(links.nth(0)).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(links.nth(1)).toBeFocused()
    await page.keyboard.press('ArrowUp')
    await expect(links.nth(0)).toBeFocused()
    await page.keyboard.press('ArrowUp')
    await expect(box).toBeFocused()
    const target = (await links.nth(0).getAttribute('href')) as string
    await page.keyboard.press('Enter')
    await expect.poll(() => new URL(page.url()).pathname + new URL(page.url()).hash).toBe(target)
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
