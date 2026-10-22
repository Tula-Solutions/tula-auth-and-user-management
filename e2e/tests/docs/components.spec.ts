import { expect, type Page, test } from '@playwright/test'
import { resolveBase } from '../../../apps/docs/src/lib/paths'
import { expectAccessible } from '../support'

// The content components of the documentation site (callouts, steps, tabs and code groups, code
// blocks with a copy button, file trees, parameter lists), driven in a browser on the page that
// documents them (`docs/writing-docs.md`), and the pages that use them. Axe runs on the page in
// light and dark at a phone's and an ultrawide's width; the other pages are in `site.spec.ts`.

const BASE = resolveBase()
const PAGE = `${BASE}writing-docs/`
const STORAGE_KEY = 'tula-docs-tabs'

/** The first group of tabs that shares the framework choice, and its second. */
function frameworkGroups(page: Page) {
  const groups = page.locator('[data-docs-tabs][data-sync="framework"]')
  return { first: groups.nth(0), second: groups.nth(1) }
}

/** The label of the tab that is selected in a group. */
async function selectedLabel(group: ReturnType<Page['locator']>): Promise<string | null> {
  return await group.locator('[role="tab"][aria-selected="true"]').getAttribute('data-label')
}

test.describe('callouts', () => {
  test('the five kinds are notes with their word and an icon, and keep their text', async ({
    page,
  }) => {
    await page.goto(PAGE)
    const callouts = page.locator('.doc .callout')
    await expect(callouts.nth(4)).toBeVisible()
    const kinds = (
      await callouts.evaluateAll((nodes) =>
        nodes.map((node) => ({
          kind: node.getAttribute('data-callout'),
          role: node.getAttribute('role'),
          title: node.querySelector('.callout-title')?.textContent,
          icon: getComputedStyle(node.querySelector('.callout-title') as Element, '::before')
            .webkitMaskImage,
        }))
      )
    ).slice(0, 5)
    expect(kinds.map((one) => one.kind)).toEqual(['note', 'tip', 'important', 'warning', 'caution'])
    expect(kinds.map((one) => one.title)).toEqual([
      'Note',
      'Tip',
      'Important',
      'Warning',
      'Caution',
    ])
    for (const one of kinds) {
      expect(one.role).toBe('note')
      expect(one.icon, `${one.kind} has an icon`).toContain('url(')
    }
  })
})

test.describe('steps', () => {
  test('a rail numbers the headings, which stay headings with anchors', async ({ page }) => {
    await page.goto(PAGE)
    const steps = page.locator('.doc ol.steps > li')
    await expect(steps).toHaveCount(3)
    const numbers = await steps.evaluateAll((nodes) =>
      nodes.map((node) => getComputedStyle(node, '::before').content)
    )
    // The number is a CSS counter, so the computed content is the counter call itself.
    expect(numbers).toEqual(['counter(step)', 'counter(step)', 'counter(step)'])
    await expect(page.getByRole('heading', { name: 'Install the package' })).toBeVisible()
    await expect(page.locator('.doc ol.steps h3#install-the-package')).toHaveCount(1)
  })
})

test.describe('tabs', () => {
  test('are the ARIA tabs pattern: arrow keys, Home and End move the selection and the focus', async ({
    page,
  }) => {
    await page.goto(PAGE)
    const { first } = frameworkGroups(page)
    const tabs = first.getByRole('tab')
    await expect(first.getByRole('tablist')).toHaveCount(1)
    await expect(tabs).toHaveText(['Next.js', 'Vite'])
    await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true')
    // Only the selected tab is in the tab order.
    await expect(tabs.nth(0)).toHaveAttribute('tabindex', '0')
    await expect(tabs.nth(1)).toHaveAttribute('tabindex', '-1')

    await tabs.nth(0).focus()
    await page.keyboard.press('ArrowRight')
    await expect(tabs.nth(1)).toBeFocused()
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true')
    await expect(first.getByRole('tabpanel')).toContainText('wraps the app in')
    await expect(tabs.nth(0)).toHaveAttribute('tabindex', '-1')

    await page.keyboard.press('ArrowRight')
    await expect(tabs.nth(0)).toBeFocused()
    await page.keyboard.press('ArrowLeft')
    await expect(tabs.nth(1)).toBeFocused()
    await page.keyboard.press('Home')
    await expect(tabs.nth(0)).toBeFocused()
    await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('End')
    await expect(tabs.nth(1)).toBeFocused()
  })

  test('each tab names its panel and each panel its tab, and one panel is shown', async ({
    page,
  }) => {
    await page.goto(PAGE)
    const { first } = frameworkGroups(page)
    const ties = await first.evaluate((group) =>
      [...group.querySelectorAll('[role="tab"]')].map((tab) => {
        const panel = document.getElementById(tab.getAttribute('aria-controls') as string)
        return {
          labelled: panel?.getAttribute('aria-labelledby') === tab.id,
          role: panel?.getAttribute('role'),
          hidden: panel?.hasAttribute('hidden'),
        }
      })
    )
    expect(ties).toEqual([
      { labelled: true, role: 'tabpanel', hidden: false },
      { labelled: true, role: 'tabpanel', hidden: true },
    ])
  })

  test('Tab leaves the tab list for the panel', async ({ page }) => {
    await page.goto(PAGE)
    const { first } = frameworkGroups(page)
    await first.getByRole('tab').nth(0).focus()
    await page.keyboard.press('Tab')
    const inside = await first
      .getByRole('tabpanel')
      .evaluate((panel) => panel.contains(document.activeElement))
    expect(inside).toBe(true)
  })

  test('a choice is carried to the groups that share its key, and kept across a reload', async ({
    page,
  }) => {
    await page.goto(PAGE)
    const { first, second } = frameworkGroups(page)
    await first.getByRole('tab', { name: 'Vite' }).click()
    expect(await selectedLabel(first)).toBe('Vite')
    expect(await selectedLabel(second)).toBe('Vite')
    await page.reload()
    expect(await selectedLabel(frameworkGroups(page).first)).toBe('Vite')
    expect(await selectedLabel(frameworkGroups(page).second)).toBe('Vite')
  })

  test('the saved choice is applied before the script bundle has run: no flash', async ({
    page,
  }) => {
    await page.goto(PAGE)
    await frameworkGroups(page).first.getByRole('tab', { name: 'Vite' }).click()
    // The bundle is what the site's other behaviour is; the tabs do not wait for it.
    await page.route('**/assets/*.js', (route) => route.abort())
    await page.goto(PAGE)
    const { first } = frameworkGroups(page)
    expect(await selectedLabel(first)).toBe('Vite')
    await expect(first.getByRole('tabpanel')).toContainText('wraps the app in')
  })

  test('the choice survives going to another page of the site', async ({ page }) => {
    await page.goto(PAGE)
    const codeGroup = page.locator('[data-docs-tabs][data-sync="package-manager"]').first()
    await codeGroup.getByRole('tab', { name: 'pnpm' }).click()
    expect(await selectedLabel(codeGroup)).toBe('pnpm')
    await page.goto(`${BASE}quickstart/`)
    const other = page.locator('[data-docs-tabs][data-sync="package-manager"]').first()
    expect(await selectedLabel(other)).toBe('pnpm')
    await expect(other.getByRole('tabpanel')).toContainText('pnpm create tula@latest')
  })

  test('another open tab of the browser follows the choice', async ({ context, page }) => {
    await page.goto(PAGE)
    const other = await context.newPage()
    await other.goto(PAGE)
    await frameworkGroups(page).first.getByRole('tab', { name: 'Vite' }).click()
    await expect(
      frameworkGroups(other).first.locator('[role="tab"][aria-selected="true"]')
    ).toHaveAttribute('data-label', 'Vite')
  })

  test('a saved label the group does not have falls back to its first tab', async ({ page }) => {
    await page.addInitScript(
      ([key]) => localStorage.setItem(key as string, JSON.stringify({ framework: 'Remix' })),
      [STORAGE_KEY]
    )
    await page.goto(PAGE)
    expect(await selectedLabel(frameworkGroups(page).first)).toBe('Next.js')
  })

  test('storage that is blocked or holds nonsense does not break them', async ({ browser }) => {
    const context = await browser.newContext()
    await context.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        get() {
          throw new DOMException('blocked', 'SecurityError')
        },
      })
    })
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(PAGE)
    const { first, second } = frameworkGroups(page)
    await first.getByRole('tab', { name: 'Vite' }).click()
    expect(await selectedLabel(first)).toBe('Vite')
    // The choice still reaches the other group of the page: it is only not kept.
    expect(await selectedLabel(second)).toBe('Vite')
    expect(errors).toEqual([])
    await context.close()

    const garbled = await browser.newContext()
    await garbled.addInitScript(() => localStorage.setItem('tula-docs-tabs', '[1,'))
    const page2 = await garbled.newPage()
    await page2.goto(PAGE)
    expect(await selectedLabel(frameworkGroups(page2).first)).toBe('Next.js')
    await garbled.close()
  })

  test('without script every panel shows under its label and nothing is a tab', async ({
    browser,
  }) => {
    const context = await browser.newContext({ javaScriptEnabled: false })
    const page = await context.newPage()
    await page.goto(PAGE)
    const { first } = frameworkGroups(page)
    await expect(first.getByRole('tablist')).toHaveCount(0)
    const panels = first.locator('.docs-tab-panel')
    await expect(panels).toHaveCount(2)
    for (const panel of await panels.all()) {
      await expect(panel).toBeVisible()
      await expect(panel.locator('.docs-tab-label')).toBeVisible()
    }
    await expect(first).toContainText('wraps the children')
    await expect(first).toContainText('wraps the app in')
    // The copy button does nothing without script, so it is not drawn.
    await expect(page.locator('.copy').first()).toBeHidden()
    await context.close()
  })
})

test.describe('code blocks', () => {
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] })

  test('the copy button copies the code and announces it', async ({ page }) => {
    await page.goto(PAGE)
    const button = page.getByRole('button', { name: 'Copy app/layout.tsx' })
    await expect(button).toBeVisible()
    const status = page.locator(
      '.code-frame:has(.copy[aria-label="Copy app/layout.tsx"]) [role="status"]'
    )
    await expect(status).toHaveText('')
    await button.click()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      'export default function Layout({ children }: { children: React.ReactNode }) {\n  return <html lang="en">{children}</html>\n}'
    )
    await expect(button).toHaveAttribute('data-copied', '')
    await expect(button).toContainText('Copied')
    await expect(status).toHaveText('Copied')
    // And it goes back to "Copy" on its own.
    await expect(button).not.toHaveAttribute('data-copied', '')
    await expect(status).toHaveText('')
  })

  test('a removed line is not copied, and the notation comment is not in the code', async ({
    page,
  }) => {
    await page.goto(PAGE)
    await page.getByRole('button', { name: 'Copy auth.ts' }).nth(1).click()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      'export const auth = createClient({\n  baseUrl: process.env.TULA_API_URL,\n  publishableKey: process.env.TULA_PUBLISHABLE_KEY,\n})'
    )
  })

  test('the copy button is reachable and works from the keyboard', async ({ page }) => {
    await page.goto(PAGE)
    const button = page.getByRole('button', { name: 'Copy app/layout.tsx' })
    await button.focus()
    await page.keyboard.press('Enter')
    await expect(button).toHaveAttribute('data-copied', '')
  })

  test('a title, a highlighted line and a changed line are marked in the markup', async ({
    page,
  }) => {
    await page.goto(PAGE)
    await expect(page.locator('.code-title-text', { hasText: 'app/layout.tsx' })).toBeVisible()
    await expect(page.locator('.line.highlighted')).toHaveCount(2)
    await expect(page.locator('.line.diff.add').first()).toBeVisible()
    await expect(page.locator('.line.diff.remove').first()).toBeVisible()
  })

  test('a long line scrolls the block and never wraps', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 })
    await page.goto(PAGE)
    const long = page
      .locator('pre', { hasText: 'publishableKey: process.env.TULA_PUBLISHABLE_KEY' })
      .first()
    const metrics = await long.evaluate((pre) => ({
      scrolls: pre.scrollWidth > pre.clientWidth,
      wrap: getComputedStyle(pre.querySelector('code') as Element).whiteSpace,
    }))
    expect(metrics.wrap).toBe('pre')
    expect(metrics.scrolls).toBe(true)
    // A block that scrolls is a stop for the keyboard.
    await expect(long).toHaveAttribute('tabindex', '0')
  })
})

test.describe('file trees and parameters', () => {
  test('a tree is a named region of nested lists a keyboard can scroll', async ({ page }) => {
    await page.goto(PAGE)
    const tree = page.getByRole('region', { name: 'File tree' })
    await expect(tree).toHaveCount(1)
    await expect(tree).toHaveAttribute('tabindex', '0')
    await expect(
      tree.getByRole('listitem').filter({ hasText: 'tula.config.ts' }).last()
    ).toBeVisible()
    await expect(tree.locator('ul ul ul').first()).toBeVisible()
  })

  test('parameters are a list of terms and definitions with one required', async ({ page }) => {
    await page.goto(PAGE)
    const params = page.locator('dl.params')
    await expect(params.locator('.param')).toHaveCount(4)
    await expect(params.locator('.param-required')).toHaveCount(1)
    await expect(params.locator('.param').first().locator('dt')).toContainText('email')
    await expect(params.locator('.param').first().locator('dd')).toContainText('address to sign up')
  })
})

test.describe('every width and scheme', () => {
  for (const width of [390, 1440, 2560]) {
    test(`the page does not scroll sideways at ${width} px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto(PAGE)
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      )
      expect(overflow).toBe(0)
      // Nothing stretches on an ultrawide: the prose stays at its measure.
      const prose = await page.locator('article.doc').evaluate((node) => node.clientWidth)
      expect(prose).toBeLessThanOrEqual(720)
    })
  }

  for (const scheme of ['light', 'dark'] as const) {
    for (const width of [390, 2560]) {
      test(`the page is accessible at ${width} px in ${scheme}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 })
        await page.emulateMedia({ colorScheme: scheme })
        await page.goto(PAGE)
        await expect(page.locator('html')).toHaveAttribute('data-theme', scheme)
        await expectAccessible(page, `writing-docs at ${width} (${scheme})`)
      })
    }

    test(`the page is accessible in ${scheme} with a tab, a copy and a tree used`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme })
      await page.goto(PAGE)
      await frameworkGroups(page).first.getByRole('tab', { name: 'Vite' }).click()
      await page.getByRole('button', { name: 'Copy app/layout.tsx' }).click()
      await expectAccessible(page, `writing-docs after use (${scheme})`)
    })
  }
})
