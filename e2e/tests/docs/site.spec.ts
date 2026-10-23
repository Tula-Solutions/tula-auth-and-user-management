import { readFileSync } from 'node:fs'
import { expect, type Page, test } from '@playwright/test'
import { resolveBase } from '../../../apps/docs/src/lib/paths'
import {
  BEYOND_INTRODUCTION,
  CHUNK_BUDGET,
  CHUNK_THRESHOLD,
  chunksOf,
  lineRangesOf,
  lineSelector,
  linesOf,
  selectorsOf,
} from '../../chunks'
import { expectAccessible } from '../support'

// The documentation site (apps/docs), built from docs/** and served as static files. Every page
// is opened, checked with axe in both themes (no rule disabled) and measured at a phone's width.
// The list of pages is the one the build wrote (`pages.json`), so a page cannot be left out.
//
// With DOCS_BASE set (`/tula-auth-and-user-management/`, as GitHub Pages serves it) the site is
// built and served under that path, and every address below is taken under it.

const BASE = resolveBase()

/** A route of the site (`/quickstart/`) as the address it is served at, under the base. */
function at(route: string): string {
  return `${BASE.slice(0, -1)}${route}`
}

const pages = JSON.parse(
  readFileSync(`${import.meta.dirname}/../../../apps/docs/dist/pages.json`, 'utf8')
) as string[]

// The size of each page and of its content sections, as the build measured them.
const pageStats = JSON.parse(
  readFileSync(`${import.meta.dirname}/../../../apps/docs/dist/page-stats.json`, 'utf8')
) as Record<string, { bytes: number; sections: number[]; lines: number[] }>

/** Whether a run is one section bigger than a piece that holds lines of code to cut it by. */
function isOversize(
  stats: { sections: number[]; lines: number[] } | undefined,
  chunk: { from: number; to: number }
): boolean {
  return (
    stats !== undefined &&
    chunk.from === chunk.to &&
    (stats.sections[chunk.from] as number) > CHUNK_BUDGET &&
    (stats.lines[chunk.from] as number) > 0
  )
}

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
        await page.goto(at(route))
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
        const section = chunk.from
        if (isOversize(stats, chunk)) {
          // One code block bigger than a piece: the block without its lines, then its lines in
          // ranges. A block cannot be split in the page, but axe can be pointed at its parts.
          test(`${route} section ${section} (the block itself) is accessible in ${scheme}`, async ({
            page,
          }) => {
            await open(page)
            await expectAccessible(page, `${route} section ${section} block (${scheme})`, {
              include: selectorsOf(chunk),
              exclude: [linesOf(section)],
            })
          })
          for (const range of lineRangesOf(
            stats?.sections[section] as number,
            stats?.lines[section] as number
          )) {
            test(`${route} section ${section} lines ${range.from} to ${range.to} are accessible in ${scheme}`, async ({
              page,
            }) => {
              await open(page)
              await expectAccessible(
                page,
                `${route} section ${section} lines ${range.from}-${range.to} (${scheme})`,
                { include: [lineSelector(section, range)] }
              )
            })
          }
          continue
        }
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

    test(`${route} has no piece of axe's work bigger than a piece's budget`, () => {
      for (const chunk of chunks) {
        const total = (stats?.sections ?? [])
          .slice(chunk.from, chunk.to + 1)
          .reduce((sum, size) => sum + size, 0)
        // A run is within the budget, or it is one section that can be cut into lines.
        expect(
          total <= CHUNK_BUDGET || isOversize(stats, chunk),
          `${route} sections ${chunk.from}-${chunk.to} are ${total} characters and cannot be cut`
        ).toBe(true)
      }
    })

    // The landing page is not a page of the docs: it has no article.
    const sectioned = route !== '/'
    test(`${route} is cut into sections that hold all its content`, async ({ page }) => {
      test.skip(!sectioned, 'the landing page has no article')
      await page.goto(at(route))
      await expect(page.locator('article.doc'), `${route} has its article`).toHaveCount(1)
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
      await page.goto(at(route))
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      )
      expect(overflow, `${route} scrolls sideways at 375px`).toBeLessThanOrEqual(0)
      expect(problems).toEqual([])
    })
  }

  test('an unknown address answers 404 with the site’s own page', async ({ page }) => {
    const response = await page.goto(at('/no/such/page/'))
    expect(response?.status()).toBe(404)
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible()
  })

  test('the theme toggle switches the page and the choice is kept', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await page.goto(at('/quickstart/'))
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

  test('the current page is marked with the Tula mark, in ink on paper and paper on ink', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.emulateMedia({ colorScheme: 'light' })
    await page.goto(at('/quickstart/'))
    const marker = () =>
      page.locator('.nav-link[aria-current="page"]').evaluate((link) => {
        const style = getComputedStyle(link, '::before')
        return {
          mask: style.maskImage || style.getPropertyValue('-webkit-mask-image'),
          color: style.backgroundColor,
        }
      })
    const light = await marker()
    expect(light.mask).toContain('data:image/svg+xml')
    expect(light.color).toBe('rgb(26, 26, 24)')
    await page.getByRole('button', { name: 'Dark theme' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    expect((await marker()).color).toBe('rgb(241, 239, 232)')
  })

  test('searching an error code finds its anchor, and following it lands on the code', async ({
    page,
  }) => {
    await page.goto(at('/'))
    await page
      .getByRole('searchbox', { name: 'Search the documentation' })
      .fill('password.too_short')
    const first = page.getByRole('list', { name: 'Search results' }).getByRole('link').first()
    await expect(first).toHaveAttribute('href', at('/reference/error-codes/#password.too_short'))
    await first.click()
    await expect(page).toHaveURL(/\/reference\/error-codes\/#password\.too_short$/)
    await expect(page.locator('[id="password.too_short"]')).toBeInViewport()
  })

  test('search finds prose, and Escape closes the results', async ({ page }) => {
    await page.goto(at('/'))
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
    await page.goto(at('/'))
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
    await page.goto(at('/quickstart/'))
    const sidebar = page.getByRole('navigation', { name: 'Documentation' })
    await expect(sidebar).toBeHidden()
    await page.getByRole('button', { name: 'Menu' }).click()
    await expect(sidebar).toBeVisible()
    await expectAccessible(page, 'quickstart with the menu open')
  })

  test('the drawer traps focus, closes on Escape and locks the page behind it', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(at('/methods/password/'))
    const menu = page.getByRole('button', { name: 'Menu' })
    const sidebar = page.locator('#sidebar')
    await menu.click()
    await expect(sidebar).toHaveAttribute('data-open', 'true')
    await expect(menu).toHaveAttribute('aria-expanded', 'true')
    await expect(page.locator('html')).toHaveClass(/drawer-open/)
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).toBe(
      'hidden'
    )
    await expect(page.locator('main')).toHaveAttribute('inert', '')
    // Tab (and Shift+Tab) cycles through the button and the drawer's links and wraps round: a
    // full turn visits both, never leaves them, and ends where it began.
    for (const key of ['Tab', 'Shift+Tab']) {
      const visited = new Set<string>()
      const start = await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80))
      let returned = false
      for (let step = 0; step < 200 && !returned; step += 1) {
        await page.keyboard.press(key)
        const where = await page.evaluate(() => ({
          button: document.activeElement?.id === 'menu-toggle',
          link:
            document.activeElement?.tagName === 'A' &&
            document.getElementById('sidebar')?.contains(document.activeElement) === true,
          html: document.activeElement?.outerHTML.slice(0, 80),
        }))
        expect(where.button || where.link, `${key} left the drawer at step ${step}`).toBe(true)
        visited.add(where.button ? 'button' : 'link')
        returned = where.html === start
      }
      expect(returned, `${key} wraps round`).toBe(true)
      expect([...visited].sort()).toEqual(['button', 'link'])
    }
    // Everything else on the page is inert, the header's controls included.
    for (const selector of ['main', '.header-end', '.tabs']) {
      await expect(page.locator(selector).first()).toHaveAttribute('inert', '')
    }
    await page.keyboard.press('Escape')
    await expect(sidebar).toHaveAttribute('data-open', 'false')
    await expect(menu).toBeFocused()
    await expect(page.locator('main')).not.toHaveAttribute('inert', '')
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).toBe(
      'visible'
    )
  })

  test('the search shortcuts leave the drawer, and keep the search button in step', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(at('/quickstart/'))
    await page.getByRole('button', { name: 'Menu' }).click()
    await expect(page.locator('#sidebar')).toHaveAttribute('data-open', 'true')
    await page.keyboard.press('ControlOrMeta+k')
    await expect(page.locator('#sidebar')).toHaveAttribute('data-open', 'false')
    await expect(page.getByRole('searchbox', { name: 'Search the documentation' })).toBeFocused()
    await expect(page.locator('#search-toggle')).toHaveAttribute('aria-expanded', 'true')
  })

  test.describe('without a script', () => {
    test.use({ javaScriptEnabled: false })

    test('a phone still has the navigation, in the page', async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 })
      await page.goto(at('/quickstart/'))
      const nav = page.getByRole('navigation', { name: 'Documentation' })
      await expect(nav).toBeVisible()
      await expect(nav.getByRole('link', { name: 'Guides' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Menu' })).toBeHidden()
    })
  })

  test('the drawer closes from its scrim and when the window becomes a desktop', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(at('/quickstart/'))
    await page.getByRole('button', { name: 'Menu' }).click()
    await expect(page.locator('#sidebar')).toHaveAttribute('data-open', 'true')
    await page.mouse.click(385, 600)
    await expect(page.locator('#sidebar')).toHaveAttribute('data-open', 'false')
    await expect(page.locator('main')).not.toHaveAttribute('inert', '')
    await expect(page.locator('html')).not.toHaveClass(/drawer-open/)
    await page.getByRole('button', { name: 'Menu' }).click()
    await page.setViewportSize({ width: 1280, height: 800 })
    await expect(page.locator('#sidebar')).toHaveAttribute('data-open', 'false')
    await expect(page.locator('main')).not.toHaveAttribute('inert', '')
    await expect(page.locator('.header-end')).not.toHaveAttribute('inert', '')
    await expect(page.locator('html')).not.toHaveClass(/drawer-open/)
    await expect(page.getByRole('navigation', { name: 'Documentation' })).toBeVisible()
  })

  for (const scheme of ['light', 'dark'] as const) {
    test(`the open drawer is accessible in ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme })
      await page.setViewportSize({ width: 390, height: 844 })
      await page.goto(at('/methods/password/'))
      await page.getByRole('button', { name: 'Menu' }).click()
      await expectAccessible(page, `the drawer (${scheme})`)
    })
  }

  test('the table of contents is a disclosure on a phone and a column on a desktop', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(at('/methods/password/'))
    const disclosure = page.locator('details.toc-mobile')
    await expect(disclosure).toBeVisible()
    await expect(page.getByRole('navigation', { name: 'Page contents' })).toBeHidden()
    await disclosure.locator('summary').click()
    await expect(page.getByRole('navigation', { name: 'Page contents' })).toBeVisible()
    await expectAccessible(page, 'the open table of contents')
    await page.setViewportSize({ width: 1440, height: 900 })
    await expect(disclosure).toBeHidden()
    await expect(page.getByRole('navigation', { name: 'On this page' })).toBeVisible()
  })

  test('the theme follows the system until a choice is made, and the choice wins after', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.goto(at('/quickstart/'))
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await page.getByRole('button', { name: 'Dark theme' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await expectAccessible(page, 'quickstart, light chosen on a dark system')
  })

  // The layout at the six widths the design is held to. Nothing scrolls sideways, the shell
  // never passes 1480 px, the prose never passes 720 px, and the columns are the ones the
  // design names: a drawer and a disclosure below 1024, a sidebar from 1024, a table of
  // contents from 1280.
  const WIDTHS = [
    { width: 390, height: 844, sidebar: false, toc: false },
    { width: 768, height: 1024, sidebar: false, toc: false },
    { width: 1280, height: 800, sidebar: true, toc: true },
    { width: 1440, height: 900, sidebar: true, toc: true },
    { width: 1920, height: 1080, sidebar: true, toc: true },
    { width: 2560, height: 1080, sidebar: true, toc: true },
  ]
  for (const size of WIDTHS) {
    test(`the layout holds at ${size.width} by ${size.height}`, async ({ page }) => {
      const problems = watch(page)
      await page.setViewportSize({ width: size.width, height: size.height })
      await page.goto(at('/methods/password/'))
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      )
      expect(overflow).toBeLessThanOrEqual(0)
      const shell = await page.locator('.shell.layout').boundingBox()
      expect(shell?.width ?? 0).toBeLessThanOrEqual(1480)
      const doc = await page.locator('article.doc').boundingBox()
      expect(doc?.width ?? 0).toBeLessThanOrEqual(720)
      expect(await page.evaluate(() => getComputedStyle(document.body).fontSize)).toBe('16px')
      await expect(page.locator('.sidebar nav')).toBeVisible({ visible: size.sidebar })
      await expect(page.locator('aside.toc')).toBeVisible({ visible: size.toc })
      await expect(page.locator('.tabs')).toBeVisible({ visible: size.width >= 1024 })
      // Centred in the shell, never stretched, on an ultrawide.
      if (size.width >= 1920) {
        expect(shell?.x ?? 0).toBeGreaterThan(200)
      }
      expect(problems).toEqual([])
    })
  }

  test('the header names the sections and the page’s own is current', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(at('/methods/password/'))
    const tabs = page.getByRole('navigation', { name: 'Sections' })
    await expect(tabs.getByRole('link')).toHaveText([
      'Get started',
      'Guides',
      'Self-hosting',
      'CLI & MCP',
      'Reference',
    ])
    await expect(tabs.getByRole('link', { name: 'Guides' })).toHaveAttribute('aria-current', 'true')
    await expect(page.getByRole('link', { name: 'Tula Auth on GitHub' })).toBeVisible()
  })

  test('Control or Command K focuses the search', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(at('/quickstart/'))
    await page.keyboard.press('ControlOrMeta+k')
    await expect(page.getByRole('searchbox', { name: 'Search the documentation' })).toBeFocused()
  })

  test('the identity files are served under the base', async ({ request, baseURL }) => {
    for (const file of [
      'favicon.ico',
      'favicon.svg',
      'favicon-32.png',
      'apple-touch-icon.png',
      'site.webmanifest',
      'og.png',
    ]) {
      const response = await request.get(`${baseURL}${at(`/${file}`)}`)
      expect(response.status(), file).toBe(200)
    }
  })

  test('relative links between pages lead to the site’s routes, with their anchors', async ({
    page,
  }) => {
    await page.goto(at('/methods/password/'))
    const link = page.locator(`main a[href^="${BASE}"]`).first()
    await expect(link).toBeVisible()
    const href = (await link.getAttribute('href')) as string
    expect(pages).toContain(href.slice(BASE.length - 1).split('#')[0])
  })

  // GitHub Pages serves the site under the repository's name (DOCS_BASE): an address that
  // leaves the base is another site's, and answers its 404.
  test('nothing of the site is served outside its base', async ({ page }) => {
    test.skip(BASE === '/', 'the site is served at the root')
    const response = await page.goto('/quickstart/')
    expect(response?.status()).toBe(404)
    await page.goto(at('/quickstart/'))
    const outside = await page
      .locator('a[href], link[href], script[src], img[src]')
      .evaluateAll(
        (nodes, base) =>
          nodes
            .map((node) => node.getAttribute('href') ?? node.getAttribute('src') ?? '')
            .filter((value) => value.startsWith('/') && !value.startsWith(base)),
        BASE
      )
    expect(outside).toEqual([])
  })
})
