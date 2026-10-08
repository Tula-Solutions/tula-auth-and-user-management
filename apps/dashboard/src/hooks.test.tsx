import { afterEach, describe, expect, test } from 'bun:test'
import { act, screen, waitFor, within } from '@testing-library/react'
import { HOOK_POINTS } from '@tula/contract'
import { type FakeHook, failure, fakeHook, IDS, installFakeApi } from '~/testing/fake-api'
import {
  DEV_PATH,
  expectFocus,
  expectNothingKept,
  holdAnswers,
  openDialogs,
  PROD_PATH,
  renderApp,
  type World,
} from '~/testing/harness'

// The hooks screen: the three points at which the server asks a question, each with its hook
// or none. Rendered as the whole app, against the fake API.

let world: World | undefined

function start(path: string, options: Parameters<typeof renderApp>[1] = {}): World {
  world = renderApp(path, options)
  return world
}

afterEach(() => {
  world?.queryClient.clear()
  world?.api.restore()
  world = undefined
})

const ASK = 'https://api.example.com/hooks/tula/sign-up'
const ALLOWING_SIGN_UP =
  'When a call of this hook fails, the sign-up goes ahead and the account is created, as if there were no hook.'
const RECORDED = 'This is recorded in the audit log as a weakening.'

function dialog(): HTMLElement {
  return screen.getByRole('dialog')
}

function button(name: string): HTMLElement {
  return within(dialog()).getByRole('button', { name })
}

/** What the open dialog says is wrong, in document order. */
function alerts(): string[] {
  return within(dialog())
    .queryAllByRole('alert')
    .map((alert) => alert.textContent ?? '')
}

/** The card of a point, once the list is on screen. */
async function card(point: string): Promise<HTMLElement> {
  const cards = await screen.findAllByTestId('hook-point')
  const found = cards.find((entry) => entry.getAttribute('data-point') === point)
  if (!found) {
    throw new Error(`no card for ${point}`)
  }
  return found
}

/** The app on the hooks screen of an environment that has these hooks. */
function withHooks(hooks: Partial<FakeHook>[], path = DEV_PATH): World {
  const api = installFakeApi()
  const environmentId = path === PROD_PATH ? IDS.production : IDS.development
  api.state.hooks.push(...hooks.map((hook) => fakeHook({ environmentId, ...hook })))
  return start(`${path}/hooks`, { api })
}

function sent(api: World['api'], method: string) {
  return api.calls
    .filter((call) => call.method === method && call.path.startsWith('/v1/admin/hooks'))
    .map((call) => call.body)
}

describe('the list of points', () => {
  test('the navigation leads to it, and every point is listed, with or without a hook', async () => {
    const { user, location, api } = start(`${DEV_PATH}/users`)
    await screen.findByRole('heading', { level: 1, name: 'Users' })
    await user.click(screen.getByRole('link', { name: 'Hooks' }))
    await screen.findByRole('heading', { level: 1, name: 'Hooks' })
    expect(location()).toBe(`${DEV_PATH}/hooks`)
    const cards = await screen.findAllByTestId('hook-point')
    expect(cards.map((entry) => entry.getAttribute('data-point'))).toEqual([...HOOK_POINTS])
    expect(
      cards.map((entry) => within(entry).getByRole('heading', { level: 2 }).textContent)
    ).toEqual(['Before a sign-up', 'Before a session', 'Before a token'])
    for (const entry of cards) {
      expect(within(entry).getByTestId('hook-none').textContent).toBe(
        'No hook: nothing is asked at this point.'
      )
    }
    expect(api.callsTo('GET', '/v1/admin/hooks').at(-1)?.headers.get('x-tula-environment')).toBe(
      IDS.development
    )
  })

  test('a hook says its address, how it is set and its last failed call, in words', async () => {
    withHooks([
      { point: 'before_sign_up', url: ASK },
      {
        point: 'before_session',
        url: 'https://api.example.com/hooks/session',
        failureMode: 'allow',
        deadlineMs: 800,
        lastFailedAt: '2026-10-03T09:00:00.000Z',
        lastFailureReason: 'timeout',
      },
      {
        point: 'before_token',
        url: 'https://api.example.com/hooks/token',
        enabled: false,
        lastFailedAt: '2026-10-02T09:00:00.000Z',
        lastFailureReason: 'claims_too_large',
      },
    ])
    const signUp = await card('before_sign_up')
    expect(within(signUp).getByText(ASK)).toBeDefined()
    expect(within(signUp).getByTestId('hook-state').getAttribute('data-state')).toBe('on')
    expect(within(signUp).getByTestId('hook-state').textContent).toBe(
      'OnIt is asked, and a call that fails refuses what was asked about.'
    )
    expect(within(signUp).getByText('2000 ms')).toBeDefined()
    expect(within(signUp).getByText('Refuse what was asked about (deny)')).toBeDefined()
    const never = within(signUp).getByTestId('hook-last-failure')
    expect(never.getAttribute('data-outcome')).toBe('none')
    // What the server does not record is said, so that silence is not read as "never asked".
    expect(never.textContent).toBe(
      'No failed call is recorded.Only the last call that failed is recorded. A call that was answered, with an allow or a denial, leaves no record here.'
    )

    const session = await card('before_session')
    expect(within(session).getByTestId('hook-state').getAttribute('data-state')).toBe('on-allowing')
    expect(within(session).getByTestId('hook-state').textContent).toContain(
      'On, letting through on failure'
    )
    expect(within(session).getByText('800 ms')).toBeDefined()
    const timedOut = within(session).getByTestId('hook-last-failure')
    expect(timedOut.getAttribute('data-outcome')).toBe('timed-out')
    expect(timedOut.textContent).toContain('Timed out')
    expect(timedOut.textContent).toContain('There was no answer within the deadline.')
    // An old failure is not "failing now".
    expect(timedOut.textContent).toContain(
      'This stays until another call fails: calls since then may have been answered.'
    )

    const token = await card('before_token')
    expect(within(token).getByTestId('hook-state').getAttribute('data-state')).toBe('off')
    expect(within(token).getByTestId('hook-state').textContent).toContain('Switched off')
    const failed = within(token).getByTestId('hook-last-failure')
    expect(failed.getAttribute('data-outcome')).toBe('failed')
    expect(failed.textContent).toContain('The claims were over the size limit')
  })

  test('what a later server knows is shown as the text it is, and can still be removed', async () => {
    const { user, api } = withHooks([
      {
        point: 'before_refresh<b>',
        url: 'https://api.example.com/hooks/later',
        failureMode: 'retry',
        lastFailedAt: '2026-10-03T09:00:00.000Z',
        lastFailureReason: 'quota_spent',
      },
    ])
    const later = await card('before_refresh<b>')
    expect(later.querySelector('b')).toBeNull()
    expect(within(later).getByRole('heading', { level: 2 }).textContent).toBe('before_refresh<b>')
    expect(
      within(later).getByText('A point this version of the dashboard does not know.')
    ).toBeDefined()
    expect(within(later).getByText('retry')).toBeDefined()
    expect(within(later).getByTestId('hook-last-failure').textContent).toContain(
      'The server gave this reason: quota_spent'
    )
    // No form for a point whose fields this version cannot know.
    expect(within(later).queryAllByRole('button', { name: /^Edit/ })).toHaveLength(0)
    await user.click(
      within(later).getByRole('button', { name: 'Remove the hook for before_refresh<b>' })
    )
    await user.click(button('Remove hook'))
    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(api.state.hooks).toHaveLength(0)
    // The three points of this version are there as before.
    expect((await screen.findAllByTestId('hook-point')).length).toBe(3)
  })
})

describe('adding a hook', () => {
  test('the request names the point, the address, the deadline and the mode; the secret is shown once', async () => {
    const current = start(`${DEV_PATH}/hooks`)
    const { user, api } = current
    const signUp = await card('before_sign_up')
    await user.click(within(signUp).getByRole('button', { name: 'Add a hook for before_sign_up' }))
    expect(within(dialog()).getByRole('heading').textContent).toBe(
      'Add the hook for before_sign_up'
    )
    await user.type(within(dialog()).getByLabelText('Address'), ASK)
    await user.click(button('Add hook'))

    const secret = (await within(dialog()).findByTestId('hook-secret')).textContent ?? ''
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/=]{20,}$/)
    await expectFocus(
      within(dialog()).getByRole('heading', { name: 'Copy the signing secret now' })
    )
    // The server makes the secret: the request carries none, and nothing was asked first.
    expect(sent(api, 'POST')).toEqual([
      { point: 'before_sign_up', url: ASK, enabled: true, deadlineMs: 2000, failureMode: 'deny' },
    ])
    expect(localStorage.length + sessionStorage.length).toBe(0)
    await user.click(button('I have copied it'))
    await waitFor(() => expect(openDialogs()).toBe(0))
    expectNothingKept(current, [secret])

    // The button that opened the dialog is gone with the empty state: the point's name has
    // the focus, and the card shows the hook.
    const added = await card('before_sign_up')
    await within(added).findByText(ASK)
    await expectFocus(within(added).getByRole('heading', { level: 2 }))
    expect(within(added).queryAllByTestId('hook-none')).toHaveLength(0)

    // Walk on and back: the secret never comes back.
    await user.click(screen.getByRole('link', { name: 'API keys' }))
    await screen.findByRole('heading', { level: 1, name: 'API keys' })
    await user.click(screen.getByRole('link', { name: 'Hooks' }))
    await within(await card('before_sign_up')).findByText(ASK)
    expectNothingKept(current, [secret])
  })

  test('“let it through” is asked about before anything is sent, and Cancel goes back to the form', async () => {
    const { user, api } = start(`${DEV_PATH}/hooks`)
    await user.click(
      within(await card('before_sign_up')).getByRole('button', {
        name: 'Add a hook for before_sign_up',
      })
    )
    await user.type(within(dialog()).getByLabelText('Address'), ASK)
    await user.clear(within(dialog()).getByLabelText('Deadline (milliseconds)'))
    await user.type(within(dialog()).getByLabelText('Deadline (milliseconds)'), '750')
    await user.selectOptions(within(dialog()).getByLabelText('When a call fails'), 'allow')
    await user.click(button('Add hook'))

    await expectFocus(
      within(dialog()).getByRole('heading', { name: 'Let it through when a call fails?' })
    )
    expect(within(dialog()).getByTestId('weakening').textContent).toBe(
      `${ALLOWING_SIGN_UP}${RECORDED}`
    )
    expect(sent(api, 'POST')).toEqual([])
    // Nothing is typed in development.
    expect(within(dialog()).queryAllByLabelText(/to confirm/)).toHaveLength(0)

    await user.click(button('Cancel'))
    expect(openDialogs()).toBe(1)
    expect((within(dialog()).getByLabelText('Address') as HTMLInputElement).value).toBe(ASK)
    expect((within(dialog()).getByLabelText('When a call fails') as HTMLSelectElement).value).toBe(
      'allow'
    )
    expect(sent(api, 'POST')).toEqual([])

    await user.click(button('Add hook'))
    await user.click(button('Add hook'))
    await within(dialog()).findByTestId('hook-secret')
    expect(sent(api, 'POST')).toEqual([
      { point: 'before_sign_up', url: ASK, enabled: true, deadlineMs: 750, failureMode: 'allow' },
    ])
  })

  test('in production the point is typed before a hook that lets through is added', async () => {
    const { user, api } = start(`${PROD_PATH}/hooks`)
    await user.click(
      within(await card('before_token')).getByRole('button', {
        name: 'Add a hook for before_token',
      })
    )
    await user.type(within(dialog()).getByLabelText('Address'), ASK)
    await user.selectOptions(within(dialog()).getByLabelText('When a call fails'), 'allow')
    await user.click(button('Add hook'))
    expect(within(dialog()).getByTestId('weakening').textContent).toContain(
      'When a call of this hook fails, the session carries none of its claims.'
    )
    const confirm = button('Add hook')
    expect(confirm.getAttribute('aria-disabled')).toBe('true')
    await user.click(confirm)
    await user.type(within(dialog()).getByLabelText(/to confirm/), 'before_session')
    await user.click(button('Add hook'))
    expect(sent(api, 'POST')).toEqual([])

    await user.clear(within(dialog()).getByLabelText(/to confirm/))
    await user.type(within(dialog()).getByLabelText(/to confirm/), 'before_token')
    expect(button('Add hook').getAttribute('aria-disabled')).toBeNull()
    await user.click(button('Add hook'))
    await within(dialog()).findByTestId('hook-secret')
    expect(sent(api, 'POST')).toHaveLength(1)
    expect(
      api.state.hooks.map((hook) => [hook.environmentId, hook.point, hook.failureMode])
    ).toEqual([[IDS.production, 'before_token', 'allow']])
  })

  test('what the form can know it says before anything is sent', async () => {
    const { user, api } = start(`${DEV_PATH}/hooks`)
    await user.click(
      within(await card('before_session')).getByRole('button', {
        name: 'Add a hook for before_session',
      })
    )
    await user.clear(within(dialog()).getByLabelText('Deadline (milliseconds)'))
    await user.type(within(dialog()).getByLabelText('Deadline (milliseconds)'), '5001')
    await user.click(button('Add hook'))
    expect(alerts()).toEqual([
      'Enter the address of your endpoint, starting with https://.',
      'Enter a whole number of milliseconds from 100 to 5000.',
    ])
    await user.clear(within(dialog()).getByLabelText('Deadline (milliseconds)'))
    await user.type(within(dialog()).getByLabelText('Deadline (milliseconds)'), '1.5e3')
    await user.type(within(dialog()).getByLabelText('Address'), 'https://a b')
    await user.click(button('Add hook'))
    expect(alerts()).toEqual([
      'Must not contain spaces or control characters.',
      'Enter a whole number of milliseconds from 100 to 5000.',
    ])
    expect(sent(api, 'POST')).toEqual([])
  })

  test.each([
    ['http://api.example.com/hooks', 'The address must start with https://.'],
    [
      'https://localhost/hooks',
      'The address leads to a private or local network address, which the server does not call. Use an address on the public internet.',
    ],
    [
      'https://nowhere.invalid/hooks',
      'The host name of the address could not be resolved. Check the spelling.',
    ],
    [
      'https://user:pw@api.example.com/hooks',
      'That is not an address the server can call. Enter a full https:// URL with no user name or password in it.',
    ],
  ])('the server’s refusal of %s is a sentence on the address', async (url, sentence) => {
    const { user, api } = start(`${DEV_PATH}/hooks`)
    await user.click(
      within(await card('before_sign_up')).getByRole('button', {
        name: 'Add a hook for before_sign_up',
      })
    )
    await user.type(within(dialog()).getByLabelText('Address'), url)
    await user.click(button('Add hook'))
    await waitFor(() => expect(alerts()).toEqual([sentence]))
    expect(within(dialog()).getByLabelText('Address').getAttribute('aria-invalid')).toBe('true')
    expect(api.state.hooks).toHaveLength(0)
  })

  test('a refusal after the question goes back to the form, where it can be put right', async () => {
    const { user, api } = start(`${DEV_PATH}/hooks`)
    await user.click(
      within(await card('before_sign_up')).getByRole('button', {
        name: 'Add a hook for before_sign_up',
      })
    )
    await user.type(within(dialog()).getByLabelText('Address'), 'https://localhost/hooks')
    await user.selectOptions(within(dialog()).getByLabelText('When a call fails'), 'allow')
    await user.click(button('Add hook'))
    await user.click(button('Add hook'))
    await within(dialog()).findByLabelText('Address')
    await waitFor(() => expect(alerts()).toHaveLength(1))
    expect(alerts()[0]).toStartWith('The address leads to a private or local network address')
    expect(api.state.hooks).toHaveLength(0)
  })

  test('a point that got a hook elsewhere meanwhile says so, and an unknown refusal has a sentence', async () => {
    const { user, api } = start(`${DEV_PATH}/hooks`)
    await user.click(
      within(await card('before_sign_up')).getByRole('button', {
        name: 'Add a hook for before_sign_up',
      })
    )
    api.state.hooks.push(fakeHook({ point: 'before_sign_up' }))
    await user.type(within(dialog()).getByLabelText('Address'), ASK)
    await user.click(button('Add hook'))
    await waitFor(() =>
      expect(alerts()).toEqual([
        'This point already has one: it was added elsewhere. Close this and look at the list again.',
      ])
    )
    api.override('POST', /^\/v1\/admin\/hooks$/, () =>
      failure(422, 'hook.url_not_allowed', 'No.', undefined, { reason: 'something_new' })
    )
    await user.click(button('Add hook'))
    await waitFor(() => expect(alerts()).toEqual(['The server cannot call that address.']))
  })
})

describe('editing a hook', () => {
  test('only what changed is sent, and a change that weakens nothing is not asked about', async () => {
    const { user, api } = withHooks([{ url: ASK, failureMode: 'allow' }])
    await user.click(
      within(await card('before_sign_up')).getByRole('button', {
        name: 'Edit the hook for before_sign_up',
      })
    )
    expect(within(dialog()).getByRole('heading').textContent).toBe(
      'Edit the hook for before_sign_up'
    )
    expect((within(dialog()).getByLabelText('Address') as HTMLInputElement).value).toBe(ASK)
    // Nothing changed: nothing is sent.
    await user.click(button('Save changes'))
    expect(alerts()).toEqual([
      'Change the address, the deadline or what happens when a call fails first.',
    ])
    expect(sent(api, 'PATCH')).toEqual([])

    await user.clear(within(dialog()).getByLabelText('Deadline (milliseconds)'))
    await user.type(within(dialog()).getByLabelText('Deadline (milliseconds)'), '4000')
    await user.selectOptions(within(dialog()).getByLabelText('When a call fails'), 'deny')
    await user.click(button('Save changes'))
    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(sent(api, 'PATCH')).toEqual([{ deadlineMs: 4000, failureMode: 'deny' }])
    const changed = await card('before_sign_up')
    await within(changed).findByText('4000 ms')
    expect(within(changed).getByTestId('hook-state').getAttribute('data-state')).toBe('on')
  })

  test('a change to “let it through” is asked about first; in production the point is typed', async () => {
    const { user, api } = withHooks([{ point: 'before_session', url: ASK }], PROD_PATH)
    await user.click(
      within(await card('before_session')).getByRole('button', {
        name: 'Edit the hook for before_session',
      })
    )
    await user.selectOptions(within(dialog()).getByLabelText('When a call fails'), 'allow')
    await user.click(button('Save changes'))
    await expectFocus(
      within(dialog()).getByRole('heading', { name: 'Let it through when a call fails?' })
    )
    expect(within(dialog()).getByTestId('weakening').textContent).toBe(
      `When a call of this hook fails, the sign-in goes ahead and the session is created, as if there were no hook.${RECORDED}`
    )
    expect(button('Save changes').getAttribute('aria-disabled')).toBe('true')
    await user.click(button('Save changes'))
    expect(sent(api, 'PATCH')).toEqual([])

    await user.type(within(dialog()).getByLabelText(/to confirm/), 'before_session')
    await user.click(button('Save changes'))
    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(sent(api, 'PATCH')).toEqual([{ failureMode: 'allow' }])
    expect(
      within(await card('before_session'))
        .getByTestId('hook-state')
        .getAttribute('data-state')
    ).toBe('on-allowing')
  })

  test('an edit that was asked about and cancelled sends nothing, and opens clean the next time', async () => {
    const { user, api } = withHooks([{ url: ASK }])
    const open = async () =>
      user.click(
        within(await card('before_sign_up')).getByRole('button', {
          name: 'Edit the hook for before_sign_up',
        })
      )
    await open()
    await user.selectOptions(within(dialog()).getByLabelText('When a call fails'), 'allow')
    await user.click(button('Save changes'))
    expect(within(dialog()).getByTestId('weakening').textContent).toContain(ALLOWING_SIGN_UP)
    await user.click(button('Cancel'))
    // Back on the form, with what was chosen.
    expect((within(dialog()).getByLabelText('When a call fails') as HTMLSelectElement).value).toBe(
      'allow'
    )
    await user.click(button('Cancel'))
    await waitFor(() => expect(openDialogs()).toBe(0))
    await open()
    expect((within(dialog()).getByLabelText('When a call fails') as HTMLSelectElement).value).toBe(
      'deny'
    )
    expect(sent(api, 'PATCH')).toEqual([])
  })

  test('a hook changed or removed elsewhere meanwhile says so', async () => {
    const { user, api } = withHooks([{ url: ASK }])
    await user.click(
      within(await card('before_sign_up')).getByRole('button', {
        name: 'Edit the hook for before_sign_up',
      })
    )
    api.override('PATCH', /^\/v1\/admin\/hooks\/[^/]+$/, () =>
      failure(409, 'resource.conflict', 'The hook changed since it was read.')
    )
    await user.clear(within(dialog()).getByLabelText('Deadline (milliseconds)'))
    await user.type(within(dialog()).getByLabelText('Deadline (milliseconds)'), '900')
    await user.click(button('Save changes'))
    await waitFor(() =>
      expect(alerts()).toEqual([
        'It was changed elsewhere since this screen read it. Close this, look at it again, and repeat the change if it is still wanted.',
      ])
    )
    api.override('PATCH', /^\/v1\/admin\/hooks\/[^/]+$/, () =>
      failure(404, 'resource.not_found', 'The requested resource does not exist.')
    )
    await user.click(button('Save changes'))
    await waitFor(() =>
      expect(alerts()).toEqual([
        'It no longer exists: it was removed elsewhere. Close this and look at the list again.',
      ])
    )
  })
})

describe('switching a hook off and on, and removing it', () => {
  test('switching off says what is lost and sends the switch alone', async () => {
    const { user, api } = withHooks([{ url: ASK }])
    await user.click(
      within(await card('before_sign_up')).getByRole('button', {
        name: 'Switch off the hook for before_sign_up',
      })
    )
    expect(within(dialog()).getByRole('heading').textContent).toBe(
      'Switch off the hook for before_sign_up?'
    )
    expect(dialog().textContent).toContain(
      `It is no longer asked: every sign-up goes ahead, as if there were no hook. ${RECORDED}`
    )
    // Nothing is typed in development.
    expect(within(dialog()).queryAllByLabelText(/to confirm/)).toHaveLength(0)
    await user.click(button('Switch off'))
    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(sent(api, 'PATCH')).toEqual([{ enabled: false }])
    const off = await card('before_sign_up')
    expect(within(off).getByTestId('hook-state').getAttribute('data-state')).toBe('off')

    // Switching on weakens nothing: it is confirmed, and says what a failing call then does.
    await user.click(
      within(off).getByRole('button', { name: 'Switch on the hook for before_sign_up' })
    )
    expect(dialog().textContent).toContain(
      'A call that fails refuses what was asked about, so check that the endpoint answers first.'
    )
    await user.click(button('Switch on'))
    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(sent(api, 'PATCH')).toEqual([{ enabled: false }, { enabled: true }])
  })

  test('in production switching off needs the point typed, and switching on does not', async () => {
    const { user, api } = withHooks(
      [
        { point: 'before_token', url: ASK },
        { point: 'before_session', url: ASK, enabled: false },
      ],
      PROD_PATH
    )
    await user.click(
      within(await card('before_token')).getByRole('button', {
        name: 'Switch off the hook for before_token',
      })
    )
    expect(button('Switch off').getAttribute('aria-disabled')).toBe('true')
    await user.click(button('Switch off'))
    expect(sent(api, 'PATCH')).toEqual([])
    await user.type(within(dialog()).getByLabelText(/to confirm/), 'before_token')
    await user.click(button('Switch off'))
    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(sent(api, 'PATCH')).toEqual([{ enabled: false }])

    await user.click(
      within(await card('before_session')).getByRole('button', {
        name: 'Switch on the hook for before_session',
      })
    )
    expect(within(dialog()).queryAllByLabelText(/to confirm/)).toHaveLength(0)
    await user.click(button('Switch on'))
    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(sent(api, 'PATCH')).toEqual([{ enabled: false }, { enabled: true }])
  })

  test('removing a hook that is on says what is lost; the point then has none and has the focus', async () => {
    const { user, api } = withHooks([{ url: ASK }])
    await user.click(
      within(await card('before_sign_up')).getByRole('button', {
        name: 'Remove the hook for before_sign_up',
      })
    )
    expect(dialog().textContent).toContain(
      `It is no longer asked: every sign-up goes ahead, as if there were no hook. Its signing secret is deleted with it and cannot be brought back. ${RECORDED}`
    )
    await user.click(button('Remove hook'))
    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(api.calls.filter((call) => call.method === 'DELETE')).toHaveLength(1)
    const empty = await card('before_sign_up')
    expect(within(empty).getByTestId('hook-none')).toBeDefined()
    await expectFocus(within(empty).getByRole('heading', { level: 2 }))
  })

  test('removing a hook that is off is no weakening, and in production is typed all the same', async () => {
    const { user, api } = withHooks([{ url: ASK, enabled: false }], PROD_PATH)
    await user.click(
      within(await card('before_sign_up')).getByRole('button', {
        name: 'Remove the hook for before_sign_up',
      })
    )
    expect(dialog().textContent).toContain(
      'It is switched off, so nothing changes for the people signing in.'
    )
    expect(dialog().textContent).not.toContain('weakening')
    await user.click(button('Remove hook'))
    expect(api.calls.filter((call) => call.method === 'DELETE')).toHaveLength(0)
    await user.type(within(dialog()).getByLabelText(/to confirm/), 'before_sign_up')
    await user.click(button('Remove hook'))
    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(api.state.hooks).toHaveLength(0)
  })

  test('a refused removal stays open with a sentence, and can be tried again', async () => {
    const { user, api } = withHooks([{ url: ASK }])
    let refusals = 1
    api.override('DELETE', /^\/v1\/admin\/hooks\/[^/]+$/, () => {
      if (refusals > 0) {
        refusals -= 1
        return failure(409, 'resource.conflict', 'The hook changed since it was read.')
      }
      api.state.hooks.length = 0
      return new Response(null, { status: 204 })
    })
    await user.click(
      within(await card('before_sign_up')).getByRole('button', {
        name: 'Remove the hook for before_sign_up',
      })
    )
    await user.click(button('Remove hook'))
    await waitFor(() => expect(alerts()).toHaveLength(1))
    expect(alerts()[0]).toStartWith('It was changed elsewhere since this screen read it.')
    expect(button('Remove hook').getAttribute('aria-disabled')).toBeNull()
    await user.click(button('Remove hook'))
    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(api.state.hooks).toHaveLength(0)
  })
})

describe('a confirmed change is sent once, however slow the list is to come back', () => {
  /** Confirm, wait for the list to be asked for again, and confirm once more. */
  async function confirmTwice(current: World, label: string, method: string): Promise<void> {
    const hold = holdAnswers(
      (path, _headers, asked) => asked === 'GET' && path === '/v1/admin/hooks'
    )
    await current.user.click(button(label))
    await waitFor(() => expect(hold.held()).toBe(1))
    expect(sent(current.api, method)).toHaveLength(1)
    for (const confirm of within(dialog()).queryAllByRole('button', { name: label })) {
      expect(confirm.getAttribute('aria-disabled')).toBe('true')
      await current.user.click(confirm)
    }
    await act(() => hold.release())
    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(sent(current.api, method)).toHaveLength(1)
    expect(screen.queryAllByRole('alert')).toHaveLength(0)
  }

  test('a removal', async () => {
    const current = withHooks([{ url: ASK }])
    await current.user.click(
      within(await card('before_sign_up')).getByRole('button', {
        name: 'Remove the hook for before_sign_up',
      })
    )
    await confirmTwice(current, 'Remove hook', 'DELETE')
  })

  test('a switch', async () => {
    const current = withHooks([{ url: ASK }])
    await current.user.click(
      within(await card('before_sign_up')).getByRole('button', {
        name: 'Switch off the hook for before_sign_up',
      })
    )
    await confirmTwice(current, 'Switch off', 'PATCH')
  })

  test('an edit that was asked about', async () => {
    const current = withHooks([{ url: ASK }])
    await current.user.click(
      within(await card('before_sign_up')).getByRole('button', {
        name: 'Edit the hook for before_sign_up',
      })
    )
    await current.user.selectOptions(within(dialog()).getByLabelText('When a call fails'), 'allow')
    await current.user.click(button('Save changes'))
    await confirmTwice(current, 'Save changes', 'PATCH')
  })
})
