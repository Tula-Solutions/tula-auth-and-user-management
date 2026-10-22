import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { resolveBase } from '../../../apps/docs/src/lib/paths'
import { expectAccessible } from '../support'

// The anatomy of a page: the breadcrumb, the page actions (copy, the menu, the deeplinks), the
// table of contents that follows the scroll, the footer (source, date, feedback) and the pages
// before and after. With DOCS_BASE set (`/tula-auth-and-user-management/`) the site is served
// under that path, as GitHub Pages serves it.

const BASE = resolveBase()
const ORIGIN = 'https://tula-solutions.github.io'
const ROOT = join(import.meta.dirname, '../../..')
const PASSWORD = `${BASE.slice(0, -1)}/methods/password/`

const pages = JSON.parse(readFileSync(join(ROOT, 'apps/docs/dist/pages.json'), 'utf8')) as string[]

/** The text of a page's Markdown twin, as the build wrote it. */
function twinText(route: string): string {
  const path = route === '/' ? 'index.md' : `${route.replace(/^\/|\/$/g, '')}.md`
  return readFileSync(join(ROOT, 'apps/docs/dist', path), 'utf8')
}

function menuButton(page: Page) {
  return page.getByRole('button', { name: 'More page actions' })
}

test.describe('the page actions', () => {
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] })

  test('Copy page writes the page’s Markdown to the clipboard and says it did', async ({
    page,
  }) => {
    await page.goto(PASSWORD)
    const copy = page.locator('[data-action="copy"]')
    await copy.click()
    await expect(copy).toHaveText('Copied')
    await expect(
      page.getByRole('status').filter({ hasText: 'Page copied as Markdown' })
    ).toHaveCount(1)
    const clipboard = await page.evaluate(() => navigator.clipboard.readText())
    expect(clipboard).toBe(twinText('/methods/password/'))
    expect(clipboard.startsWith('---\n')).toBe(true)
    // The label comes back by itself.
    await expect(copy).toHaveText('Copy page')
  })

  test('the deeplinks carry the encoded prompt naming the page’s Markdown address', async ({
    page,
  }) => {
    await page.goto(PASSWORD)
    await menuButton(page).click()
    const twin = `${ORIGIN}${BASE}methods/password.md`
    const prompt = encodeURIComponent(`Read ${twin} and help me with it`)
    const expected: Record<string, string> = {
      'Open in Claude': `https://claude.ai/new?q=${prompt}`,
      'Open in ChatGPT': `https://chatgpt.com/?q=${prompt}`,
      'Open in Cursor': `https://cursor.com/link/prompt?text=${prompt}`,
      'View as Markdown': `${BASE}methods/password.md`,
    }
    for (const [name, href] of Object.entries(expected)) {
      const item = page.getByRole('menuitem', { name })
      await expect(item, name).toHaveAttribute('href', href)
      await expect(item, name).toHaveAttribute('rel', 'noopener noreferrer')
    }
  })

  test('the menu works with the keyboard: open, move, wrap, Home and End, Escape, Tab', async ({
    page,
  }) => {
    await page.goto(PASSWORD)
    const trigger = menuButton(page)
    const items = page.getByRole('menuitem')
    await expect(trigger).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByRole('menu')).toBeHidden()
    await trigger.focus()
    await page.keyboard.press('Enter')
    await expect(trigger).toHaveAttribute('aria-expanded', 'true')
    await expect(items).toHaveCount(5)
    await expect(items.nth(0)).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(items.nth(1)).toBeFocused()
    await page.keyboard.press('End')
    await expect(items.nth(4)).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(items.nth(0)).toBeFocused()
    await page.keyboard.press('ArrowUp')
    await expect(items.nth(4)).toBeFocused()
    await page.keyboard.press('Home')
    await expect(items.nth(0)).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toBeHidden()
    await expect(trigger).toBeFocused()
    await expect(trigger).toHaveAttribute('aria-expanded', 'false')
    // ArrowUp on the button opens at the last entry; Tab leaves and closes.
    await page.keyboard.press('ArrowUp')
    await expect(items.nth(4)).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(page.getByRole('menu')).toBeHidden()
  })

  test('a click outside closes the menu', async ({ page }) => {
    await page.goto(PASSWORD)
    await menuButton(page).click()
    await expect(page.getByRole('menu')).toBeVisible()
    await page.locator('article.doc h1').click()
    await expect(page.getByRole('menu')).toBeHidden()
  })

  test('Copy MCP setup copies the configuration for tula mcp, with no key in it', async ({
    page,
  }) => {
    await page.goto(PASSWORD)
    await menuButton(page).click()
    await page.getByRole('menuitem', { name: 'Copy MCP setup' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'MCP setup copied' })).toHaveCount(1)
    const text = await page.evaluate(() => navigator.clipboard.readText())
    expect(JSON.parse(text).mcpServers.tula.args).toContain('mcp')
    expect(text).not.toMatch(/tula_(ak|sk)_/)
  })

  test('the menu is accessible open, in light and dark', async ({ page }) => {
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      await page.goto(PASSWORD)
      await menuButton(page).click()
      await expect(page.getByRole('menu')).toBeVisible()
      await expectAccessible(page, `password with the actions menu open (${scheme})`)
    }
  })

  test('on a phone the menu fits the screen and its entries are tall enough to touch', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(PASSWORD)
    await menuButton(page).click()
    const box = await page.getByRole('menu').boundingBox()
    expect(box).not.toBeNull()
    expect((box?.x ?? -1) >= 0).toBe(true)
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390)
    const item = await page.getByRole('menuitem').first().boundingBox()
    expect(item?.height ?? 0).toBeGreaterThanOrEqual(44)
  })
})

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false })

  test('the main action is a link to the Markdown and the menu is a disclosure of links', async ({
    page,
  }) => {
    await page.goto(PASSWORD)
    await expect(page.getByRole('link', { name: 'View as Markdown' })).toHaveAttribute(
      'href',
      `${BASE}methods/password.md`
    )
    await expect(page.getByRole('button', { name: 'Copy page' })).toBeHidden()
    await page.locator('summary[aria-label="More page actions"]').click()
    for (const name of ['Open in Claude', 'Open in ChatGPT', 'Open in Cursor', 'Copy MCP setup']) {
      await expect(page.getByRole('link', { name }), name).toBeVisible()
    }
    // With no script the setup is the page that holds it.
    await expect(page.getByRole('link', { name: 'Copy MCP setup' })).toHaveAttribute(
      'href',
      `${BASE}mcp/`
    )
  })

  test('the feedback is only a link to an issue', async ({ page }) => {
    await page.goto(PASSWORD)
    await expect(page.getByRole('button', { name: /^Yes/ })).toBeHidden()
    await expect(page.getByRole('link', { name: 'Open an issue' }).first()).toBeVisible()
  })
})

test.describe('the table of contents', () => {
  test('lights the heading the reader is in as the page scrolls, and says so to assistive technology', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(PASSWORD)
    const rail = page.getByRole('navigation', { name: 'On this page' })
    const links = rail.getByRole('link')
    const count = await links.count()
    expect(count).toBeGreaterThan(2)
    await expect(links.first()).toHaveAttribute('aria-current', 'location')
    const middle = links.nth(2)
    const id = decodeURIComponent(((await middle.getAttribute('href')) as string).slice(1))
    await page.evaluate((target) => {
      const heading = document.getElementById(target) as HTMLElement
      window.scrollTo(0, heading.getBoundingClientRect().top + window.scrollY - 70)
    }, id)
    await expect(middle).toHaveAttribute('aria-current', 'location')
    await expect(rail.locator('a[aria-current]')).toHaveCount(1)
    // Back to the top, the first entry again.
    await page.evaluate(() => window.scrollTo(0, 0))
    await expect(links.first()).toHaveAttribute('aria-current', 'location')
    // The bottom of the page lights the last one.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    await expect(links.nth(count - 1)).toHaveAttribute('aria-current', 'location')
  })

  test('clicking an entry lights it and goes to the heading', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(PASSWORD)
    const rail = page.getByRole('navigation', { name: 'On this page' })
    const target = rail.getByRole('link').nth(1)
    await target.click()
    await expect(target).toHaveAttribute('aria-current', 'location')
    await expect(page).toHaveURL(new RegExp(`${(await target.getAttribute('href')) as string}$`))
  })

  test('follows the scroll for a reader who asks for less motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(PASSWORD)
    const link = page.getByRole('navigation', { name: 'On this page' }).getByRole('link').nth(3)
    const id = decodeURIComponent(((await link.getAttribute('href')) as string).slice(1))
    await page.evaluate((target) => {
      const heading = document.getElementById(target) as HTMLElement
      window.scrollTo(0, heading.getBoundingClientRect().top + window.scrollY - 70)
    }, id)
    await expect(link).toHaveAttribute('aria-current', 'location')
    const transition = await link.evaluate(
      (element) => getComputedStyle(element).transitionDuration
    )
    expect(transition).toBe('0s')
  })

  test('on a phone the disclosure names the section the reader is in', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(PASSWORD)
    const disclosure = page.locator('details.toc-mobile')
    const names = await disclosure.locator('.toc-list a').allTextContents()
    expect(names.length).toBeGreaterThan(2)
    await expect(disclosure.locator('[data-toc-current]')).toHaveText(names[0] as string)
    const second = disclosure.locator('.toc-list a').nth(1)
    const id = decodeURIComponent(((await second.getAttribute('href')) as string).slice(1))
    await page.evaluate((target) => {
      const heading = document.getElementById(target) as HTMLElement
      window.scrollTo(0, heading.getBoundingClientRect().top + window.scrollY - 70)
    }, id)
    await expect(disclosure.locator('[data-toc-current]')).toHaveText(names[1] as string)
    // It stays under the header while the page scrolls.
    const box = await disclosure.boundingBox()
    expect(box?.y ?? 99).toBeLessThan(120)
  })
})

test.describe('the end of a page', () => {
  test('the previous and next pages follow the sidebar and lead there', async ({ page }) => {
    await page.goto(PASSWORD)
    const pager = page.getByRole('navigation', { name: 'Previous and next pages' })
    await expect(pager.getByRole('link', { name: /Previous.*Quickstart/ })).toHaveAttribute(
      'href',
      `${BASE}quickstart/`
    )
    const next = pager.getByRole('link', { name: /^Next/ })
    const href = (await next.getAttribute('href')) as string
    await next.click()
    await expect(page).toHaveURL(new RegExp(`${href}$`))
    // The next page's own previous is the page left.
    await expect(
      page
        .getByRole('navigation', { name: 'Previous and next pages' })
        .getByRole('link', { name: /^Previous/ })
    ).toHaveAttribute('href', PASSWORD)
  })

  test('the first page has no previous link and the last has no next', async ({ page }) => {
    await page.goto(`${BASE}quickstart/`)
    const pager = page.getByRole('navigation', { name: 'Previous and next pages' })
    await expect(pager.getByRole('link', { name: /^Previous/ })).toHaveCount(0)
    await expect(pager.getByRole('link', { name: /^Next/ })).toHaveCount(1)
  })

  test('the breadcrumb names the tab, the group and the page, the page not a link', async ({
    page,
  }) => {
    await page.goto(PASSWORD)
    const crumb = page.getByRole('navigation', { name: 'Breadcrumb' })
    await expect(crumb.locator('li')).toHaveText(['Guides', 'Sign-in methods', 'Password'])
    await expect(crumb.locator('[aria-current="page"]')).toHaveText('Password')
    await expect(crumb.getByRole('link')).toHaveCount(1)
  })

  test('every page links to its source on GitHub, a file that exists', async ({ request }) => {
    const pattern =
      /href="https:\/\/github\.com\/Tula-Solutions\/tula-auth-and-user-management\/(?:edit|blob)\/develop\/([^"]+)"/
    const missing: string[] = []
    for (const route of pages.filter((one) => one !== '/')) {
      const html = await (await request.get(`${BASE.slice(0, -1)}${route}`)).text()
      const file = pattern.exec(html)?.[1]
      if (file === undefined || !existsSync(join(ROOT, file))) {
        missing.push(`${route} -> ${file}`)
      }
    }
    expect(missing).toEqual([])
  })

  test('a hand-written page offers to edit its Markdown, a generated one only shows it', async ({
    page,
  }) => {
    await page.goto(PASSWORD)
    await expect(page.getByRole('link', { name: 'Edit this page on GitHub' })).toHaveAttribute(
      'href',
      'https://github.com/Tula-Solutions/tula-auth-and-user-management/edit/develop/docs/methods/password.md'
    )
    await page.goto(`${BASE}reference/error-codes/`)
    await expect(page.getByRole('link', { name: 'Edit this page on GitHub' })).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'View the source on GitHub' })).toHaveAttribute(
      'href',
      'https://github.com/Tula-Solutions/tula-auth-and-user-management/blob/develop/packages/contract/src/error-codes.ts'
    )
  })

  test('the date, where git could give one, is a real date', async ({ page }) => {
    await page.goto(PASSWORD)
    const time = page.locator('footer.page-foot time')
    // A shallow checkout gives no date, and then the page says none (never a wrong one).
    if ((await time.count()) > 0) {
      await expect(time).toHaveAttribute('datetime', /^\d{4}-\d{2}-\d{2}$/)
      await expect(time).toHaveText(/^\d{1,2} [A-Z][a-z]{2} \d{4}$/)
    }
  })

  test('the feedback shows a thank-you and an issue link and sends nothing', async ({ page }) => {
    await page.goto(PASSWORD)
    const requests: string[] = []
    page.on('request', (request) => requests.push(request.url()))
    const thanks = page.locator('[data-thanks]')
    await expect(thanks).toBeHidden()
    await page.getByRole('button', { name: /^Yes/ }).click()
    await expect(thanks).toBeVisible()
    await expect(thanks).toBeFocused()
    await expect(thanks).toContainText('Thanks for the feedback.')
    await expect(thanks.getByRole('link', { name: 'Open an issue' })).toHaveAttribute(
      'href',
      /\/issues\/new\?title=Docs%3A\+Password/
    )
    await expect(page.getByRole('button', { name: /^Yes/ })).toBeHidden()
    expect(requests).toEqual([])
    // Nothing is kept: no storage, no cookie (the theme is the only thing the site ever stores,
    // and only when the reader toggles it).
    expect(
      await page.evaluate(() => [localStorage.length, sessionStorage.length, document.cookie])
    ).toEqual([0, 0, ''])
  })

  test('the footer is accessible after an answer, in light and dark', async ({ page }) => {
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      await page.goto(PASSWORD)
      await page.getByRole('button', { name: /^No/ }).click()
      await expect(page.locator('[data-thanks]')).toContainText('Sorry this fell short.')
      await expectAccessible(page, `password after an answer (${scheme})`)
    }
  })
})
