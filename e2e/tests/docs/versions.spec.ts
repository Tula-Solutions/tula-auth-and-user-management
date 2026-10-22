import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { resolveBase } from '../../../apps/docs/src/lib/paths'
import { expectAccessible } from '../support'

// The two versions of the documentation site as it is deployed: the latest release's docs at the
// base, and the development branch's under `next/` with a banner that says so. They are built by
// `build:versions` from this checkout (the released docs are labelled with the contract's
// version here), and both are served under the same base GitHub Pages serves the site at.

const BASE = resolveBase()
const NEXT = `${BASE}next/`
const VERSION = (
  JSON.parse(
    readFileSync(`${import.meta.dirname}/../../../packages/contract/package.json`, 'utf8')
  ) as {
    version: string
  }
).version

test.describe('the released docs', () => {
  test('say their version, link to next and are indexed', async ({ page }) => {
    await page.goto(`${BASE}quickstart/`)
    await expect(page.locator('header')).toContainText(`v${VERSION}`)
    await expect(page.locator('[data-docs-banner]')).toHaveCount(0)
    await expect(page.locator('meta[name="robots"]')).toHaveCount(0)
    const link = page.locator('header a[data-docs-version]')
    await expect(link).toHaveText('next')
    await expect(link).toHaveAttribute('href', `${NEXT}quickstart/`)
  })

  test('the switch leads to the same page of the development docs', async ({ page }) => {
    await page.goto(`${BASE}quickstart/`)
    await page.locator('header a[data-docs-version]').click()
    await expect(page).toHaveURL(new RegExp(`${NEXT}quickstart/$`))
    await expect(page.locator('main h1').first()).toBeVisible()
  })
})

test.describe('the development docs under next/', () => {
  for (const route of ['', 'quickstart/', 'docs/']) {
    for (const scheme of ['light', 'dark'] as const) {
      test(`${NEXT}${route} loads, says it is unreleased and is accessible in ${scheme}`, async ({
        page,
      }) => {
        const problems: string[] = []
        page.on('pageerror', (error) => problems.push(error.message))
        page.on('response', (response) => {
          if (response.status() >= 400) {
            problems.push(`${response.status()}: ${response.url()}`)
          }
        })
        await page.emulateMedia({ colorScheme: scheme })
        await page.goto(`${NEXT}${route}`)
        await expect(page.locator('main h1').first()).toBeVisible()
        await expect(page.locator('[data-docs-banner="next"]')).toContainText(
          'These are the unreleased docs'
        )
        await expect(page.locator('header')).toContainText('next')
        await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex')
        await expectAccessible(page, `${NEXT}${route} (${scheme})`)
        expect(problems).toEqual([])
      })
    }
  }

  test('the banner leads back to the released docs, and the page searches under next/', async ({
    page,
  }) => {
    await page.goto(`${NEXT}quickstart/`)
    await expect(page.locator('[data-docs-banner] a')).toHaveAttribute('href', `${BASE}quickstart/`)
    const index = await page.request.get(`${NEXT}search-index.json`)
    expect(index.status()).toBe(200)
    await page.locator('#search-input').fill('password')
    await expect(page.locator('#search-results a').first()).toBeVisible()
    const href = (await page.locator('#search-results a').first().getAttribute('href')) ?? ''
    expect(href.startsWith(NEXT)).toBe(true)
    await page.locator('[data-docs-banner] a').click()
    await expect(page).toHaveURL(new RegExp(`${BASE}quickstart/$`))
  })

  test('a page missing from next/ answers with the site’s own 404, with a way back', async ({
    page,
  }) => {
    const response = await page.goto(`${NEXT}no-such-page/`)
    expect(response?.status()).toBe(404)
    await expect(page.locator('main h1')).toHaveText('Page not found')
  })
})
