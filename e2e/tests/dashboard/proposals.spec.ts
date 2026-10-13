import type { Page } from '@playwright/test'
import { API_URL, uniqueEmail } from '../support'
import {
  dialog,
  ENVIRONMENT_ID,
  ENVIRONMENT_PATH,
  expect,
  expectScreenAccessible,
  open,
  signIn,
  signUpInExampleApp,
  test,
} from './support'

// Proposals: what an agent asked for with an agent key, approved in the dashboard with its
// session, against the real API. The agent here is this test: it makes an agent key as the
// dashboard does and asks with it at `POST /v1/agent/proposals`, the one thing such a key
// can ask for.

const DASHBOARD = {
  'x-tula-dashboard': '1',
  'x-tula-environment': ENVIRONMENT_ID,
  origin: API_URL,
}

interface Key {
  id: string
  key: string
}

/** An agent key of the fixture's environment, made as the dashboard makes one. */
async function agentKey(page: Page): Promise<Key> {
  const response = await page.request.post(`${API_URL}/v1/admin/api-keys`, {
    headers: DASHBOARD,
    data: { kind: 'agent', name: `e2e agent ${Date.now()}` },
  })
  expect(response.status()).toBe(201)
  const created = (await response.json()) as Key
  expect(created.key).toMatch(/^tula_ak_/)
  return created
}

async function revoke(page: Page, key: Key): Promise<void> {
  const response = await page.request.delete(`${API_URL}/v1/admin/api-keys/${key.id}`, {
    headers: DASHBOARD,
  })
  expect(response.ok()).toBe(true)
}

/** What an agent does: ask, with its own key and nothing of the dashboard's. */
async function propose(page: Page, key: Key, operation: string, userId: string): Promise<string> {
  const response = await page.request.post(`${API_URL}/v1/agent/proposals`, {
    headers: { authorization: `Bearer ${key.key}` },
    data: { operation, target: { type: 'user', id: userId } },
  })
  expect(response.status()).toBe(201)
  return ((await response.json()) as { id: string }).id
}

async function user(page: Page, email: string): Promise<{ id: string; bannedAt: string | null }> {
  const response = await page.request.get(
    `${API_URL}/v1/admin/users?q=${encodeURIComponent(email)}`,
    { headers: DASHBOARD }
  )
  expect(response.ok()).toBe(true)
  const found = ((await response.json()) as { data: { id: string; bannedAt: string | null }[] })
    .data[0]
  expect(found).toBeDefined()
  return found as { id: string; bannedAt: string | null }
}

test.beforeEach(async ({ page }) => {
  await signIn(page)
})

test('a proposal is listed with what it does, approved by name, carried out once, and recorded with both actors', async ({
  page,
}) => {
  const email = uniqueEmail('proposal')
  await signUpInExampleApp(page, email)
  const { id: userId } = await user(page, email)
  const key = await agentKey(page)

  await open(page, `${ENVIRONMENT_PATH}/proposals`, 'Proposals')
  await expect(page.getByTestId('proposals-no-dismiss')).toContainText(
    'it cannot be dismissed here'
  )
  await expectScreenAccessible(page, 'proposals, as first opened')

  // Asked to lift a ban that is not there: carried out, and said to change nothing.
  await propose(page, key, 'unban_user', userId)
  await page.getByRole('button', { name: 'Read the list again' }).click()
  // The question keeps what its card said when it was opened: wait for the card to have read.
  await expect(page.getByTestId('proposal-target')).toContainText('not banned now')
  await page.getByRole('button', { name: `Approve unban_user for user ${userId}` }).click()
  await expect(dialog(page).getByTestId('proposal-target')).toHaveText(
    `user ${userId} (${email}; not banned now)`
  )
  await dialog(page).getByRole('button', { name: 'Approve' }).click()
  const result = page.getByTestId('approval-result')
  await expect(result).toHaveAttribute('data-outcome', 'nothing')
  await expect(result.getByTestId('approval-result-text')).toHaveText(
    'Approved and carried out; the user was not banned, so nothing changed. The proposal is spent: it cannot be approved again.'
  )
  await result.getByRole('button', { name: 'Close this message' }).click()

  await propose(page, key, 'ban_user', userId)
  await page.getByRole('button', { name: 'Read the list again' }).click()
  const opener = page.getByRole('button', { name: `Approve ban_user for user ${userId}` })
  await expect(opener).toBeVisible()
  const waiting = page.locator('[data-testid="proposal"][data-status="pending"]').filter({
    hasText: userId,
  })
  await expect(waiting).toHaveCount(1)
  await expect(waiting.getByTestId('proposal-summary')).toHaveText(
    `Ban the user ${userId}: every session of theirs ends now, and they cannot sign in until an administrator lifts the ban.`
  )
  await expect(waiting.getByTestId('proposal-target')).toHaveText(
    `user ${userId} (${email}; not banned now)`
  )
  await expect(waiting).toContainText(`An agent (agent key ${key.id})`)
  await expect(waiting.getByTestId('proposal-time-left')).toHaveText(/^\d+ min \d+ s left\.$/)
  await expectScreenAccessible(page, 'a proposal waiting for approval')

  // The question names the operation and the target, and says what approving does.
  await opener.click()
  await expect(dialog(page).getByRole('heading')).toHaveText(`Approve ban_user for user ${userId}?`)
  await expect(dialog(page).getByTestId('approve-consequence')).toHaveText(
    'The user is banned at once: every session of theirs ends and they cannot sign in.'
  )
  await expect(dialog(page).getByTestId('proposal-target')).toContainText(email)
  await expectScreenAccessible(page, 'the question before an approval')
  expect((await user(page, email)).bannedAt).toBeNull()

  await dialog(page).getByRole('button', { name: 'Approve' }).click()
  await expect(result).toHaveAttribute('data-outcome', 'done')
  await expect(result).toContainText('Approved and carried out')
  await expect(result).toBeFocused()
  await expect(dialog(page)).toBeHidden()
  expect((await user(page, email)).bannedAt).not.toBeNull()

  // Used once: it is no longer waiting, says how it ended and has no button.
  await expect(opener).toHaveCount(0)
  const used = page.locator('[data-testid="proposal"][data-status="executed"]').filter({
    has: page.getByRole('heading', { name: `ban_user for user ${userId}`, exact: true }),
  })
  await expect(used).toHaveCount(1)
  await expect(used.getByTestId('proposal-state')).toContainText('Approved and carried out')
  await expect(used).toContainText('instance_admin')
  await expectScreenAccessible(page, 'what an approval came to')

  // A proposal whose agent key is revoked while it waits cannot be approved, and says so.
  const left = await propose(page, key, 'unban_user', userId)
  await page.getByRole('button', { name: 'Read the list again' }).click()
  const unban = page.getByRole('button', { name: `Approve unban_user for user ${userId}` })
  await expect(unban).toBeVisible()
  await revoke(page, key)
  await page.getByRole('button', { name: 'Read the list again' }).click()
  await expect(unban).toHaveCount(0)
  const ended = page
    .locator('[data-testid="proposal"][data-status="expired"]')
    .filter({ hasText: `unban_user for user ${userId}` })
  await expect(ended.getByTestId('proposal-state')).toContainText('Expired: agent key revoked')
  await expect(ended.getByTestId('proposal-state')).toContainText('it cannot be approved')
  await expectScreenAccessible(page, 'a proposal whose agent key was revoked')
  // The server agrees with the screen.
  const refused = await page.request.post(`${API_URL}/v1/admin/proposals/${left}/approve`, {
    headers: DASHBOARD,
    data: { operation: 'unban_user', target: { type: 'user', id: userId } },
  })
  expect(refused.status()).toBe(409)
  expect(((await refused.json()) as { params: { reason: string } }).params.reason).toBe(
    'agent_key_revoked'
  )
  expect((await user(page, email)).bannedAt).not.toBeNull()

  // The audit log has the proposal, the approval, the change and the outcome: the agent as
  // the actor of what it asked for and of what was carried out, the dashboard's session as
  // the actor of the approval and named beside the rest.
  await open(page, `${ENVIRONMENT_PATH}/audit-log`, 'Audit log')
  await page.getByLabel('Target id').fill(userId)
  await page.getByRole('button', { name: 'Apply filters' }).click()
  const banned = page.getByRole('row').filter({ hasText: 'user.banned' })
  await expect(banned).toHaveCount(1)
  await expect(banned.locator('[data-actor-type]')).toHaveText('agent')
  await expect(banned).toContainText(key.id)
  await expect(banned.getByTestId('audit-party')).toHaveText([
    /^Approved by instance_admin /,
    /^Carried out proposal /,
  ])
  await page.getByLabel('Target id').fill('')
  await page.getByLabel('Actor id').fill(key.id)
  await page.getByRole('button', { name: 'Apply filters' }).click()
  await expect(page.getByRole('row').filter({ hasText: 'proposal.created' })).toHaveCount(3)
  const executed = page.getByRole('row').filter({ hasText: 'proposal.executed' })
  await expect(executed).toHaveCount(2)
  await expect(executed.first().getByTestId('audit-party')).toHaveText(
    /^Approved by instance_admin /
  )
  await page.getByLabel('Actor id').fill('')
  await page.getByLabel('Actor type').selectOption('instance_admin')
  await page.getByLabel('Action').selectOption('proposal.approved')
  await page.getByRole('button', { name: 'Apply filters' }).click()
  const approved = page.getByRole('row').filter({ hasText: key.id })
  await expect(approved).toHaveCount(2)
  await expect(approved.first().getByTestId('audit-party')).toHaveText(
    `Asked for by agent ${key.id}`
  )
  await expectScreenAccessible(page, 'the audit log of a proposal')
})
