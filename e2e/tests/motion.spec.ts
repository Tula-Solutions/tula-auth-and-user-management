import { expect, test } from '@playwright/test'
import { resetLimits, signUp, uniqueEmail } from './support'

// The other specs run with `reducedMotion: 'reduce'` (playwright.config.ts), so that the
// entrances do not slow every dialog down. These two run the motion itself, and the
// preference's own path, on the account menu (the modal's reduced-motion order is held by package.test.tsx).

test.beforeEach(async ({ request }) => {
  await resetLimits(request)
})

test.describe('with no motion preference', () => {
  test.use({ reducedMotion: 'no-preference' })

  test('the account menu enters with an animation that finishes', async ({ page, request }) => {
    await signUp(page, request, { email: uniqueEmail('motion') })
    await page.getByRole('button', { name: /^Account menu for/ }).click()
    const menu = page.locator('[data-tula-element="menu"]')
    await expect(menu).toBeVisible()
    const name = await menu.evaluate((el) => getComputedStyle(el).animationName)
    expect(name).toBe('tula-in')
    await menu.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)))
    expect(await menu.evaluate((el) => getComputedStyle(el).opacity)).toBe('1')
  })
})

test.describe('with reduced motion', () => {
  test.use({ reducedMotion: 'reduce' })

  test('the menu has no animation at all', async ({ page, request }) => {
    await signUp(page, request, { email: uniqueEmail('motion') })
    await page.getByRole('button', { name: /^Account menu for/ }).click()
    const menu = page.locator('[data-tula-element="menu"]')
    await expect(menu).toBeVisible()
    expect(await menu.evaluate((el) => getComputedStyle(el).animationName)).toBe('none')
  })
})
