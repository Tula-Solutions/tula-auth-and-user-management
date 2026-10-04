import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { useSettings } from '../support'
import {
  ENVIRONMENT_PATH,
  expect,
  open,
  openUser,
  signIn,
  signUpInExampleApp,
  test,
} from './support'

// Regenerates the screenshots apps/dashboard/README.md shows (apps/dashboard/docs). Not part
// of the suite: it only runs when asked for.
//
//   bun run e2e:screenshots

test.skip(!process.env.SCREENSHOTS, 'run with `bun run e2e:screenshots`')

const docs = join(import.meta.dirname, '..', '..', '..', 'apps', 'dashboard', 'docs')
const DESKTOP = { width: 1280, height: 800 }
const PHONE = { width: 375, height: 812 }
/** A fixed account, so that the pictures do not change from run to run more than they must. */
const EMAIL = 'ada@northline.example'

type Scheme = 'light' | 'dark'

/**
 * Wait until the page is drawn at this size and in this scheme: the media queries answer
 * for them, the fonts are loaded, nothing is still animating, and two frames have been
 * painted since. A condition, not a pause: a slow machine waits longer, a fast one does not.
 */
async function settled(page: Page, scheme: Scheme, width: number): Promise<void> {
  await page.waitForFunction(
    ([wanted, expectedWidth]) =>
      window.innerWidth === expectedWidth &&
      matchMedia(`(prefers-color-scheme: ${wanted})`).matches &&
      document.fonts.status === 'loaded' &&
      document.getAnimations().every((animation) => animation.playState !== 'running'),
    [scheme, width] as const
  )
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))
      )
  )
}

async function shot(
  page: Page,
  name: string,
  scheme: Scheme = 'light',
  size = DESKTOP
): Promise<void> {
  await page.setViewportSize(size)
  await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
  await settled(page, scheme, size.width)
  await page.screenshot({ path: join(docs, `${name}.png`), animations: 'disabled' })
}

test('the dashboard’s screens, in light, dark and at a phone’s width', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000)
  await useSettings(page.request)
  await page.setViewportSize(DESKTOP)
  await page.goto('sign-in')
  await expect(page.getByLabel('Admin token')).toBeVisible()
  await shot(page, 'sign-in')
  await shot(page, 'sign-in-dark', 'dark')

  await signIn(page)
  await open(page, `${ENVIRONMENT_PATH}/users`, 'Users')
  await page.getByLabel('Search users').fill(EMAIL)
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  await expect(page.getByText(/No user matches|ada@northline/).first()).toBeVisible()
  if ((await page.getByRole('link', { name: EMAIL }).count()) === 0) {
    const visitor = await browser.newContext()
    await signUpInExampleApp(await visitor.newPage(), EMAIL)
    await visitor.close()
  }

  await open(page, '', 'Acme Studio')
  await shot(page, 'workspace')
  await open(page, `${ENVIRONMENT_PATH}/users`, 'Users')
  await expect(page.getByRole('link', { name: EMAIL })).toBeVisible()
  await shot(page, 'users')
  await shot(page, 'users-dark', 'dark')
  await shot(page, 'users-mobile', 'light', PHONE)
  await page.getByRole('button', { name: 'Menu' }).click()
  await shot(page, 'navigation-mobile', 'light', PHONE)
  await page.keyboard.press('Escape')

  await openUser(page, EMAIL)
  await shot(page, 'user')
  await page.getByRole('button', { name: 'Ban user', exact: true }).click()
  await shot(page, 'user-confirm-ban')
  await page.keyboard.press('Escape')

  await open(page, `${ENVIRONMENT_PATH}/sign-in-methods`, 'Sign-in methods')
  await expect(page.getByRole('heading', { name: 'Google' })).toBeVisible()
  await shot(page, 'sign-in-methods')
  await shot(page, 'sign-in-methods-dark', 'dark')
  await shot(page, 'sign-in-methods-mobile', 'light', PHONE)

  await open(page, `${ENVIRONMENT_PATH}/password-policy`, 'Password policy')
  await page.getByLabel('Minimum length').fill('8')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await shot(page, 'password-policy-weaker')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Discard changes' }).click()

  await open(page, `${ENVIRONMENT_PATH}/sessions`, 'Session profiles')
  await shot(page, 'session-profiles')
  await open(page, `${ENVIRONMENT_PATH}/settings`, 'Settings')
  await shot(page, 'settings')
  await open(page, `${ENVIRONMENT_PATH}/api-keys`, 'API keys')
  await shot(page, 'api-keys')
  await open(page, `${ENVIRONMENT_PATH}/signing-keys`, 'Signing keys')
  await shot(page, 'signing-keys')
  await open(page, `${ENVIRONMENT_PATH}/audit-log`, 'Audit log')
  await shot(page, 'audit-log')
  await shot(page, 'audit-log-dark', 'dark')
  await shot(page, 'audit-log-mobile', 'light', PHONE)
  await open(page, 'instance/diagnostics', 'Diagnostics')
  await expect(page.getByRole('heading', { name: 'Checks' })).toBeVisible()
  await shot(page, 'diagnostics')
  await shot(page, 'diagnostics-dark', 'dark')
})
