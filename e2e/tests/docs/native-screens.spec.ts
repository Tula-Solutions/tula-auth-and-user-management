import { expect, type Locator, type Page, test } from '@playwright/test'
import { resolveBase } from '../../../apps/docs/src/lib/paths'
import { expectAccessible } from '../support'

// The gallery of the native SDKs' screens (`:::native-screens`, docs/swift.md, docs/kotlin.md and
// docs/expo.md): the captures the UI-test runners took of the real example apps, shown as a
// picker with a script and as a plain list without one. Axe runs on each page in both schemes
// at a phone's and a desktop's width, and again after the gallery is used. The rest of the site
// is in `site.spec.ts`.

const BASE = resolveBase()
const PAGES = {
  ios: `${BASE}swift/`,
  android: `${BASE}kotlin/`,
} as const

function gallery(page: Page, platform: 'ios' | 'android', nth = 0): Locator {
  return page.locator(`[data-native-screens="${platform}"]`).nth(nth)
}

/** The pictures of a gallery that are drawn now. */
function visibleImages(root: Locator): Locator {
  return root.locator('img.ns-img:visible')
}

test.describe('the gallery with a script', () => {
  test('shows one screen, step and scheme at a time, and starts in the page’s scheme', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await page.goto(PAGES.ios)
    const root = gallery(page, 'ios')
    await expect(root).toHaveAttribute('data-enhanced', '')
    await expect(root.getByRole('tablist', { name: 'SwiftUI screens' })).toBeVisible()
    await expect(visibleImages(root)).toHaveCount(1)
    await expect(visibleImages(root)).toHaveAttribute(
      'alt',
      'SwiftUI Sign in screen, Address step, light theme'
    )
    await expect(root).toHaveAttribute('data-ns-theme', 'light')
  })

  test('the tabs are the ARIA tabs pattern: arrows, Home and End move the selection and the focus', async ({
    page,
  }) => {
    await page.goto(PAGES.ios)
    const root = gallery(page, 'ios')
    await root.scrollIntoViewIfNeeded()
    const tabs = root.getByRole('tab')
    const count = await tabs.count()
    expect(count).toBe(5)
    await tabs.first().focus()
    await page.keyboard.press('ArrowRight')
    await expect(tabs.nth(1)).toBeFocused()
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true')
    await expect(tabs.first()).toHaveAttribute('aria-selected', 'false')
    await expect(tabs.first()).toHaveAttribute('tabindex', '-1')
    // The panel it controls is the one that shows.
    const controls = await tabs.nth(1).getAttribute('aria-controls')
    await expect(page.locator(`#${controls}`)).toBeVisible()
    await expect(root.locator('[role="tabpanel"]:visible')).toHaveCount(1)
    await page.keyboard.press('End')
    await expect(tabs.nth(count - 1)).toBeFocused()
    await page.keyboard.press('ArrowRight')
    await expect(tabs.first()).toBeFocused()
    await page.keyboard.press('ArrowLeft')
    await expect(tabs.nth(count - 1)).toBeFocused()
    await page.keyboard.press('Home')
    await expect(tabs.first()).toBeFocused()
  })

  test('a step is picked with a button, and the picture changes to it', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await page.goto(PAGES.ios)
    const root = gallery(page, 'ios')
    await root.getByRole('tab', { name: 'Second step' }).click()
    const steps = root.locator('[role="tabpanel"]:visible').getByRole('group', { name: /step/i })
    await expect(steps).toBeVisible()
    await steps.getByRole('button', { name: 'Backup codes' }).click()
    await expect(steps.getByRole('button', { name: 'Backup codes' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await expect(steps.getByRole('button', { name: 'Set up' })).toHaveAttribute(
      'aria-pressed',
      'false'
    )
    await expect(visibleImages(root)).toHaveCount(1)
    await expect(visibleImages(root)).toHaveAttribute(
      'alt',
      'SwiftUI Second step screen, Backup codes step, light theme'
    )
  })

  test('the scheme switch shows the other capture, and the header’s toggle moves it too', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await page.goto(PAGES.android)
    const root = gallery(page, 'android')
    await root.getByRole('button', { name: 'Dark' }).click()
    await expect(root.getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'true')
    await expect(root.getByRole('button', { name: 'Light' })).toHaveAttribute(
      'aria-pressed',
      'false'
    )
    await expect(visibleImages(root)).toHaveAttribute(
      'alt',
      'Compose Sign in screen, Address step, dark theme'
    )
    // The site's own toggle follows with the gallery's.
    await page.locator('#theme-toggle').click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await page.locator('#theme-toggle').click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await expect(root).toHaveAttribute('data-ns-theme', 'light')
    await expect(visibleImages(root)).toHaveAttribute('alt', /light theme/)
  })

  test('the device frame can be taken off and put back', async ({ page }) => {
    await page.goto(PAGES.ios)
    const root = gallery(page, 'ios')
    const toggle = root.getByRole('button', { name: 'Device frame' })
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    const framed = await root
      .locator('.ns-screen:visible')
      .evaluate((node) => getComputedStyle(node).borderTopWidth)
    expect(framed).toBe('8px')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await expect(root).toHaveAttribute('data-ns-frame', 'off')
    const bare = await root
      .locator('.ns-screen:visible')
      .evaluate((node) => getComputedStyle(node).borderTopWidth)
    expect(bare).toBe('1px')
  })

  test('every picture has its size written, loads lazily and says its screen, step and scheme', async ({
    page,
  }) => {
    await page.goto(PAGES.ios)
    const images = gallery(page, 'ios').locator('img.ns-img')
    expect(await images.count()).toBe(22)
    const described = await images.evaluateAll((nodes) =>
      nodes.map((node) => ({
        alt: node.getAttribute('alt') ?? '',
        lazy: node.getAttribute('loading'),
        width: node.getAttribute('width'),
        height: node.getAttribute('height'),
      }))
    )
    for (const one of described) {
      expect(one.lazy).toBe('lazy')
      expect(Number(one.width)).toBeGreaterThan(0)
      expect(Number(one.height)).toBeGreaterThan(0)
      expect(one.alt).toMatch(/^SwiftUI .+ screen, .+ step, (light|dark) theme$/)
    }
    expect(new Set(described.map((one) => one.alt)).size).toBe(22)
  })

  test('says what made the pictures and how to take them again', async ({ page }) => {
    await page.goto(PAGES.ios)
    const note = gallery(page, 'ios').locator('.ns-provenance')
    await expect(note).toContainText('iPhone 16')
    await expect(note).toContainText('Xcode')
    await expect(note).toContainText('Commit')
    await expect(note.locator('code')).toContainText('--screenshots apps/docs/public/native/ios')
  })

  test('the Expo page shows both platforms and says where they come from', async ({ page }) => {
    await page.goto(`${BASE}expo/`)
    await expect(page.locator('[data-native-screens]')).toHaveCount(2)
    await expect(gallery(page, 'ios')).toBeAttached()
    await expect(gallery(page, 'android')).toBeAttached()
    await expect(page.getByText('not from an Expo app')).toBeVisible()
  })
})

test.describe('the gallery without a script', () => {
  test.use({ javaScriptEnabled: false })

  test('lists every capture of the platform, in the page’s scheme, with no picker', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await page.goto(PAGES.ios)
    const root = gallery(page, 'ios')
    await expect(root).not.toHaveAttribute('data-enhanced', '')
    await expect(root.locator('.ns-toolbar')).toBeHidden()
    // Every step of every screen is there to see: eleven captures in the light scheme.
    await expect(root.locator('li.ns-shot')).toHaveCount(11)
    await expect(visibleImages(root)).toHaveCount(11)
    await expect(root.locator('img.ns-img')).toHaveCount(22)
  })

  test('shows the dark captures, all of them, where the system prefers the dark', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.goto(PAGES.android)
    const root = gallery(page, 'android')
    await expect(visibleImages(root)).toHaveCount(11)
    for (const alt of await visibleImages(root).evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('alt'))
    )) {
      expect(alt).toMatch(/dark theme$/)
    }
  })

  test('is accessible and does not scroll sideways at a phone’s width', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(PAGES.ios)
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    )
    expect(overflow).toBe(0)
    await expectAccessible(page, 'swift without a script', {
      include: ['[data-native-screens]'],
    })
  })
})

test.describe('every page, width and scheme', () => {
  for (const [name, path] of [
    ['swift', PAGES.ios],
    ['kotlin', PAGES.android],
    ['expo', `${BASE}expo/`],
  ] as const) {
    for (const scheme of ['light', 'dark'] as const) {
      for (const width of [390, 1440]) {
        test(`the gallery of ${name} is accessible at ${width} px in ${scheme}`, async ({
          page,
        }) => {
          await page.setViewportSize({ width, height: 900 })
          await page.emulateMedia({ colorScheme: scheme })
          await page.goto(path)
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth
          )
          expect(overflow).toBe(0)
          await expectAccessible(page, `${name} gallery at ${width} (${scheme})`, {
            include: ['[data-native-screens]'],
          })
        })
      }

      test(`the gallery of ${name} is accessible in ${scheme} after it is used`, async ({
        page,
      }) => {
        await page.emulateMedia({ colorScheme: scheme })
        await page.goto(path)
        const root = page.locator('[data-native-screens]').first()
        await root.getByRole('tab', { name: 'Account' }).click()
        await root.getByRole('button', { name: scheme === 'light' ? 'Dark' : 'Light' }).click()
        await root.getByRole('button', { name: 'Device frame' }).click()
        await expectAccessible(page, `${name} gallery used (${scheme})`, {
          include: ['[data-native-screens]'],
        })
      })
    }
  }
})
