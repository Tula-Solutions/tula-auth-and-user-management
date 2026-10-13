import { afterEach, describe, expect, test } from 'bun:test'
import { act, screen, waitFor, within } from '@testing-library/react'
import { failure, IDS, installFakeApi } from '~/testing/fake-api'
import {
  DEV_PATH,
  holdAnswers,
  openDialogs,
  PROD_PATH,
  renderApp,
  type World,
} from '~/testing/harness'

const NOW_ISO = '2026-10-04T12:00:00.000Z'
const WORKSPACE_PATH = `/w/${IDS.workspace}`
const USER_PATH = `/v1/admin/users/${IDS.user}`

let world: World | undefined

function start(path: string, options: Parameters<typeof renderApp>[1] = {}): World {
  world = renderApp(path, options)
  return world
}

afterEach(() => {
  world?.api.restore()
  world = undefined
})

function dialog(): HTMLElement {
  return screen.getByRole('dialog')
}

/** The paths of the requests made with a method that is not a read. */
function writes(api: World['api']): string[] {
  return api.calls
    .filter((call) => call.method !== 'GET')
    .map((call) => `${call.method} ${call.path}`)
}

/**
 * Confirm, wait until what the dialog reads again before it closes has been asked for (the
 * request has succeeded by then), and confirm once more.
 *
 * @param current - The world.
 * @param label - The confirming button's name.
 * @param read - The path of a list the dialog waits for before it closes.
 * @param after - What else is tried while the list is held back.
 */
async function confirmTwice(
  current: World,
  label: string,
  read: string,
  after: () => Promise<void> = async () => undefined
): Promise<void> {
  const before = writes(current.api).length
  const hold = holdAnswers((path, _headers, method) => method === 'GET' && path === read)
  await current.user.click(within(dialog()).getByRole('button', { name: label }))
  await waitFor(() => expect(hold.held()).toBeGreaterThan(0))
  expect(writes(current.api)).toHaveLength(before + 1)
  for (const confirm of within(dialog()).queryAllByRole('button', { name: label })) {
    expect(confirm.getAttribute('aria-disabled')).toBe('true')
    await current.user.click(confirm)
  }
  await after()
  await act(() => hold.release())
  await waitFor(() => expect(openDialogs()).toBe(0))
  expect(writes(current.api)).toHaveLength(before + 1)
  expect(screen.queryAllByRole('alert').map((alert) => alert.textContent ?? '')).toEqual([])
}

function withKey(path: string): World {
  const api = installFakeApi()
  api.state.keys.push({
    id: '00000000-0000-7000-8000-00000000f100',
    kind: 'secret',
    name: 'Web app',
    environmentId: IDS.development,
    lastFour: 'wxyz',
    createdAt: NOW_ISO,
    lastUsedAt: null,
    revokedAt: null,
  })
  // A real server refuses the revocation of a key that is revoked already: a second request
  // would be answered in the dialog.
  api.override('DELETE', /^\/v1\/admin\/api-keys\/([^/]+)$/, (_call, match) => {
    const key = api.state.keys.find((entry) => entry.id === match[1])
    if (!key || key.revokedAt !== null) {
      return failure(404, 'resource.not_found', 'No such key.')
    }
    key.revokedAt = NOW_ISO
    return key
  })
  return start(path, { api })
}

// The request has succeeded and a list is still being read again: for that moment the dialog
// is still open, and its button must not send the request a second time.
describe('a confirmed change is sent once, however slow the list is to come back', () => {
  describe('an API key', () => {
    test('a revocation', async () => {
      const current = withKey(`${DEV_PATH}/api-keys`)
      await current.user.click(await screen.findByRole('button', { name: 'Revoke Web app' }))
      await confirmTwice(current, 'Revoke key', '/v1/admin/api-keys')
      expect(writes(current.api)).toEqual([
        'DELETE /v1/admin/api-keys/00000000-0000-7000-8000-00000000f100',
      ])
      await screen.findByText(/^Revoked/)
    })

    test('a revocation in production, with the name still typed: not by Enter either', async () => {
      const current = withKey(`${PROD_PATH}/api-keys`)
      await current.user.click(await screen.findByRole('button', { name: 'Revoke Web app' }))
      const field = within(dialog()).getByLabelText(/to confirm/)
      await current.user.type(field, 'Web app')
      await confirmTwice(current, 'Revoke key', '/v1/admin/api-keys', () =>
        current.user.type(field, '{Enter}')
      )
    })

    test('a refused revocation gives the button back, and the next try is sent once', async () => {
      const current = withKey(`${DEV_PATH}/api-keys`)
      let refuse = true
      current.api.override('DELETE', /^\/v1\/admin\/api-keys\/([^/]+)$/, (_call, match) => {
        const key = current.api.state.keys.find((entry) => entry.id === match[1])
        if (refuse || !key) {
          return failure(409, 'resource.conflict', 'The key cannot be revoked now.')
        }
        key.revokedAt = NOW_ISO
        return key
      })
      await current.user.click(await screen.findByRole('button', { name: 'Revoke Web app' }))
      const confirm = within(dialog()).getByRole('button', { name: 'Revoke key' })
      await current.user.click(confirm)
      await within(dialog()).findByRole('alert')
      expect(confirm.getAttribute('aria-disabled')).toBeNull()
      expect(writes(current.api)).toHaveLength(1)
      refuse = false
      await confirmTwice(current, 'Revoke key', '/v1/admin/api-keys')
      expect(writes(current.api)).toHaveLength(2)
    })
  })

  describe('a user', () => {
    async function open(button: string | RegExp, api = installFakeApi()): Promise<World> {
      const current = start(`${DEV_PATH}/users/${IDS.user}`, { api })
      await current.user.click(await screen.findByRole('button', { name: button }))
      return current
    }

    test('a ban', async () => {
      const current = await open('Ban user')
      await confirmTwice(current, 'Ban user', USER_PATH)
      expect(writes(current.api)).toEqual([`POST ${USER_PATH}/ban`])
    })

    test('the end of a ban', async () => {
      const api = installFakeApi()
      ;(api.state.users[0] as { bannedAt: string | null }).bannedAt = NOW_ISO
      const current = await open('Unban user', api)
      await confirmTwice(current, 'Unban user', USER_PATH)
    })

    test('a reset of two-step verification', async () => {
      const current = await open('Reset two-step verification')
      const before = writes(current.api).length
      const hold = holdAnswers((path, _headers, method) => method === 'GET' && path === USER_PATH)
      const label = 'Reset two-step verification'
      await current.user.click(within(dialog()).getByRole('button', { name: label }))
      await waitFor(() => expect(hold.held()).toBeGreaterThan(0))
      const confirm = within(dialog()).getByRole('button', { name: label })
      expect(confirm.getAttribute('aria-disabled')).toBe('true')
      await current.user.click(confirm)
      await act(() => hold.release())
      await waitFor(() => expect(openDialogs()).toBe(0))
      expect(writes(current.api)).toHaveLength(before + 1)
    })

    test('the end of one session', async () => {
      const current = await open(/^Revoke the .* session/)
      await confirmTwice(current, 'Revoke session', USER_PATH)
    })

    test('the end of every session', async () => {
      const current = await open('Revoke all sessions')
      await confirmTwice(current, 'Revoke all sessions', USER_PATH)
    })

    test('a new password', async () => {
      const current = await open('Set password')
      await current.user.type(within(dialog()).getByLabelText('New password'), 'granite-Lantern-93')
      await confirmTwice(current, 'Set password', `${USER_PATH}/sessions`)
    })

    test('a new user', async () => {
      const current = start(`${DEV_PATH}/users`)
      await current.user.click(await screen.findByRole('button', { name: 'Create user' }))
      await current.user.type(within(dialog()).getByLabelText('Email'), 'grace@example.com')
      await confirmTwice(current, 'Create user', '/v1/admin/users')
      expect(current.api.state.users).toHaveLength(2)
    })
  })

  describe('the control plane', () => {
    test('a new environment', async () => {
      const api = installFakeApi()
      api.state.environments = api.state.environments.filter(
        (entry) => entry.kind === 'development'
      )
      const current = start(`${DEV_PATH}/users`, { api })
      await current.user.click(await screen.findByRole('button', { name: 'Add production' }))
      await confirmTwice(current, 'Add environment', '/v1/instance/environments')
      expect(api.state.environments).toHaveLength(2)
    })

    test('a new workspace', async () => {
      const current = start(WORKSPACE_PATH)
      await current.user.click(await screen.findByRole('button', { name: 'New workspace' }))
      await current.user.type(within(dialog()).getByLabelText('Name'), 'Northline')
      await confirmTwice(current, 'Create workspace', '/v1/instance/workspaces')
      expect(current.api.state.workspaces).toHaveLength(2)
    })

    test('a new project', async () => {
      const current = start(WORKSPACE_PATH)
      await screen.findByRole('heading', { level: 1, name: 'Acme Studio' })
      const projects = current.api.state.projects.length
      await current.user.click(
        within(screen.getByRole('main')).getByRole('button', { name: 'Create project' })
      )
      await current.user.type(within(dialog()).getByLabelText('Name'), 'Admin portal')
      await confirmTwice(current, 'Create project', '/v1/instance/projects')
      expect(current.api.state.projects).toHaveLength(projects + 1)
    })

    test('a project’s new name', async () => {
      const current = start(WORKSPACE_PATH)
      await current.user.click(await screen.findByRole('button', { name: /^Rename / }))
      await current.user.type(within(dialog()).getByLabelText('Name'), ' two')
      await confirmTwice(current, 'Rename', '/v1/instance/projects')
    })
  })
})
