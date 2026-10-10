import {
  dialog,
  ENVIRONMENT_ID,
  ENVIRONMENT_PATH,
  expect,
  expectScreenAccessible,
  open,
  PROJECT_ID,
  signIn,
  test,
  WORKSPACE_ID,
} from './support'

// The shell: workspace → project → environment, kept in the address.

test.beforeEach(async ({ page }) => {
  await signIn(page)
})

test('create a project, add its environments to the switcher and switch between them', async ({
  page,
}) => {
  await open(page, '', 'Acme Studio')
  await page.getByRole('main').getByRole('button', { name: 'Create project' }).click()
  await expectScreenAccessible(page, 'create project dialog')
  await dialog(page).getByRole('button', { name: 'Create project' }).click()
  await expect(dialog(page).getByRole('alert')).toHaveText('Enter a name.')
  const name = `Marketing site ${Date.now()}`
  await dialog(page).getByLabel('Name').fill(name)
  await dialog(page).getByRole('button', { name: 'Create project' }).click()

  // A new project opens on its development environment's users.
  await expect(page.getByRole('heading', { level: 1, name: 'Users' })).toBeVisible()
  await expect(page.getByText('No users yet')).toBeVisible()
  await expect(page.locator('[data-environment-kind="development"]')).toBeVisible()
  const development = page.url()
  expect(development).toMatch(/\/w\/[^/]+\/p\/[^/]+\/e\/[^/]+\/users$/)
  await expectScreenAccessible(page, 'a new project, development')

  // Switch to production: the screen is kept, the address changes, and the badge says so in
  // words, not only in colour.
  await page.getByRole('link', { name: 'API keys' }).click()
  await page
    .getByRole('group', { name: 'Switch environment' })
    .getByRole('link', { name: 'Production' })
    .click()
  await expect(page.getByRole('heading', { level: 1, name: 'API keys' })).toBeVisible()
  await expect(page.locator('[data-environment-kind="production"]')).toContainText('Production')
  expect(page.url()).not.toBe(development)
  expect(page.url()).toMatch(/\/api-keys$/)
  await expectScreenAccessible(page, 'a new project, production')

  // The address alone restores the selection after a reload.
  await page.reload()
  await expect(page.locator('[data-environment-kind="production"]')).toBeVisible()
  await expect(
    page.getByRole('navigation', { name: 'Projects' }).getByRole('link', { name })
  ).toHaveAttribute('aria-current', 'page')

  // In production a destructive action asks for the name to be typed.
  await page.getByRole('button', { name: 'Create key' }).click()
  await dialog(page).getByLabel('Name').fill('prod web')
  await dialog(page).getByRole('button', { name: 'Create key' }).click()
  await dialog(page).getByRole('button', { name: 'I have copied it' }).click()
  await page.getByRole('button', { name: 'Revoke prod web' }).click()
  await expect(dialog(page).getByLabel(/Type prod web to confirm/)).toBeVisible()
  await expectScreenAccessible(page, 'typed confirmation in production')
  await expect(dialog(page).getByRole('button', { name: 'Revoke key' })).toHaveAttribute(
    'aria-disabled',
    'true'
  )
  // Enter in the field does nothing until the name matches.
  await dialog(page)
    .getByLabel(/Type prod web to confirm/)
    .fill('prod')
  await page.keyboard.press('Enter')
  await expect(dialog(page)).toBeVisible()
  await dialog(page)
    .getByLabel(/Type prod web to confirm/)
    .fill('prod web')
  await dialog(page).getByRole('button', { name: 'Revoke key' }).click()
  await expect(page.getByRole('row').filter({ hasText: 'prod web' })).toContainText('Revoked')

  // The project's creation is in the instance audit log.
  await open(page, 'instance/audit-log?action=project.created', 'Instance audit log')
  await expect(page.getByRole('table', { name: 'Audit entries' })).toContainText('project.created')
})

test('the fixture project lacks a production environment: it can be added from the switcher', async ({
  page,
}) => {
  await open(page, `${ENVIRONMENT_PATH}/users`, 'Users')
  const switcher = page.getByRole('group', { name: 'Switch environment' })
  const add = switcher.getByRole('button', { name: 'Add production' })
  // Added once per run of the fixture; a second run finds it there.
  if (await add.isVisible()) {
    await add.click()
    await expect(dialog(page)).toContainText('Add a production environment?')
    await expectScreenAccessible(page, 'add environment')
    await dialog(page).getByRole('button', { name: 'Add environment' }).click()
    await expect(page.locator('[data-environment-kind="production"]')).toBeVisible()
  }
  await expect(switcher.getByRole('link', { name: 'Production' })).toBeVisible()
})

test('an environment that is not the project’s is not found, and a foreign address is a 404 page', async ({
  page,
}) => {
  await page.goto(`w/${WORKSPACE_ID}/p/${PROJECT_ID}/e/00000000-0000-7000-8000-00000000dead/users`)
  await expect(page.getByText('Environment not found')).toBeVisible()
  await expectScreenAccessible(page, 'environment not found')
  await page.goto('no-such-screen')
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible()
})

test('at 375px: the navigation is a dialog, tables are stacked, nothing scrolls sideways', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 })
  for (const [path, heading] of [
    [`${ENVIRONMENT_PATH}/users`, 'Users'],
    [`${ENVIRONMENT_PATH}/api-keys`, 'API keys'],
    [`${ENVIRONMENT_PATH}/sign-in-methods`, 'Sign-in methods'],
    [`${ENVIRONMENT_PATH}/text-messages`, 'Text messages'],
    [`${ENVIRONMENT_PATH}/audit-log`, 'Audit log'],
    ['instance/diagnostics', 'Diagnostics'],
  ] as const) {
    await open(page, path, heading)
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    )
    expect(overflow, `sideways scroll on ${heading}`).toBeLessThanOrEqual(0)
  }
  await open(page, `${ENVIRONMENT_PATH}/users`, 'Users')
  await expectScreenAccessible(page, 'users at 375px')

  await page.getByRole('button', { name: 'Menu' }).click()
  await expect(dialog(page).getByRole('navigation', { name: 'Environment' })).toBeVisible()
  await expectScreenAccessible(page, 'the navigation dialog at 375px')
  await dialog(page).getByRole('link', { name: 'Signing keys' }).click()
  await expect(dialog(page)).toBeHidden()
  await expect(page.getByRole('heading', { level: 1, name: 'Signing keys' })).toBeVisible()
  // The heading of the new screen has the focus.
  await expect(page.getByRole('heading', { level: 1, name: 'Signing keys' })).toBeFocused()
  expect(page.url()).toContain(ENVIRONMENT_ID)
})

test('keyboard: the skip link, the switcher and a dialog are operable without a mouse', async ({
  page,
}) => {
  await open(page, `${ENVIRONMENT_PATH}/api-keys`, 'API keys')
  await page.keyboard.press('Tab')
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused()
  await page.getByRole('button', { name: 'Create key' }).focus()
  await page.keyboard.press('Enter')
  await expect(dialog(page).getByLabel('Name')).toBeFocused()
  // Focus stays inside the dialog.
  for (let step = 0; step < 8; step += 1) {
    await page.keyboard.press('Tab')
    const inside = await page.evaluate(() => document.activeElement?.closest('dialog') !== null)
    const onPage = await page.evaluate(() => document.activeElement !== document.body)
    expect(inside || !onPage).toBe(true)
  }
  await page.keyboard.press('Escape')
  await expect(dialog(page)).toBeHidden()
  await expect(page.getByRole('button', { name: 'Create key' })).toBeFocused()
})
