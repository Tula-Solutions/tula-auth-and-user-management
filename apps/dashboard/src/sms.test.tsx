import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { screen, waitFor, within } from '@testing-library/react'
import { failure, installFakeApi, SMS_SENDER_NONE, SMS_SENDER_OK } from '~/testing/fake-api'
import { DEV_PATH, expectFocus, openDialogs, renderApp, type World } from '~/testing/harness'

// The Text messages screen (ADR 0037, ADR 0025): the `sms` settings, what a texted code may
// do, and the codes sent and never used by destination. It is a `SettingsFrame`, so what it
// asks about before a save is the contract's `settingsWeakenings`; the tests arrange the
// document and read what the screen then does, never a rule of the screen's own.

const SETTINGS = '/v1/admin/settings'
const USAGE = '/v1/admin/sms/usage'
const COUNTRIES = 'Countries text messages may go to'

let world: World | undefined

function start(options: Parameters<typeof renderApp>[1] = {}): World {
  world = renderApp(`${DEV_PATH}/text-messages`, options)
  return world
}

afterEach(() => {
  world?.queryClient.clear()
  world?.api.restore()
  world = undefined
})

/** Whether nothing on the screen has this text: a boolean, never an element in a matcher. */
function absent(text: string | RegExp): boolean {
  return screen.queryByText(text) === null
}

function rowOf(toggle: HTMLElement): string {
  return (toggle.closest('div.border-b') as HTMLElement).textContent ?? ''
}

/** A fake API whose saved document already sends text messages to these countries. */
function sending(countries: string[], change: (api: ReturnType<typeof installFakeApi>) => void) {
  const api = installFakeApi()
  api.state.settings.settings.sms = {
    ...api.state.settings.settings.sms,
    enabled: true,
    allowedCountries: countries,
  }
  change(api)
  return api
}

async function addCountry(current: World, code: string) {
  await current.user.selectOptions(await screen.findByLabelText('Add a country'), code)
  await current.user.click(screen.getByRole('button', { name: 'Add country' }))
}

async function save(current: World) {
  await current.user.click(screen.getByRole('button', { name: 'Save changes' }))
}

describe('the text messages screen', () => {
  test('is reached from the navigation, and says what an untouched environment sends: nothing', async () => {
    const current = renderApp(`${DEV_PATH}/users`)
    world = current
    const nav = await screen.findByRole('navigation', { name: 'Environment' })
    await current.user.click(within(nav).getByRole('link', { name: 'Text messages' }))
    await screen.findByRole('heading', { level: 1, name: 'Text messages' })
    expect(current.location()).toBe(`${DEV_PATH}/text-messages`)

    const toggle = await screen.findByRole('switch', { name: 'Send text messages' })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    // An empty list is never "every country", and the screen says which it is.
    expect(document.querySelector('[data-countries="none"]')?.textContent).toContain(
      'No country is listed: no text message is sent'
    )
    expect(document.querySelector('[data-countries="none"]')?.textContent).toContain(
      'An empty list never means every country'
    )
    expect(screen.queryByRole('list', { name: COUNTRIES })).toBeNull()
    // The limit counts messages, and the screen does not call it money.
    expect(screen.getByText(/It counts messages, not segments and not money/)).toBeDefined()
    expect(screen.getByText(/There is no value that switches it off/)).toBeDefined()
    await screen.findByText('No unsaved changes.')
  })

  test('a country is chosen from the contract’s list, shown with its prefix, and the list is a set', async () => {
    const current = start()
    const select = (await screen.findByLabelText('Add a country')) as HTMLSelectElement
    // Nothing typed becomes a country: the control is a select of the contract's codes.
    expect(select.tagName).toBe('SELECT')
    expect(within(select).getByRole('option', { name: 'Germany (DE, +49)' })).toBeDefined()
    expect(
      within(select).getByRole('option', { name: 'Dominican Republic (DO, +1809, +1829, +1849)' })
    ).toBeDefined()

    await current.user.click(screen.getByRole('button', { name: 'Add country' }))
    await screen.findByText('Choose the country to add.')
    expect(current.api.state.settings.settings.sms.allowedCountries).toEqual([])

    await addCountry(current, 'US')
    await addCountry(current, 'DE')
    expect(absent('Choose the country to add.')).toBe(true)
    const list = screen.getByRole('list', { name: COUNTRIES })
    const [us, de] = within(list).getAllByRole('listitem')
    expect(us?.textContent).toContain('United States US')
    expect(us?.textContent).toContain('+1')
    // A shared prefix is said, never hidden behind one of its countries.
    expect(us?.textContent).toContain('Also allows Canada')
    expect(de?.textContent).toContain('Germany DE')
    expect(de?.textContent).toContain('+49')
    expect(de?.textContent).not.toContain('Also allows')
    // What is in the list cannot be chosen a second time.
    expect(within(select).queryByRole('option', { name: /^Germany/ })).toBeNull()
    expect(select.value).toBe('')
    // Removing a country says what stops working for its numbers.
    expect(
      screen.getByText(/a user there whose only second step is a texted code can no longer sign in/)
    ).toBeDefined()

    await current.user.click(screen.getByRole('switch', { name: 'Send text messages' }))
    await save(current)
    // No texted code signs anyone in or is a second step here: nothing asks first.
    await screen.findByText('Settings saved')
    expect(openDialogs()).toBe(0)
    // The daily limit and the wording are kept: a switch or a country never resets them.
    expect(current.api.state.settings.settings.sms).toEqual({
      enabled: true,
      allowedCountries: ['US', 'DE'],
      dailyMessageLimit: 500,
      templates: {},
    })

    await current.user.click(screen.getByRole('button', { name: 'Take out United States (US)' }))
    await save(current)
    await waitFor(() =>
      expect(current.api.state.settings.settings.sms.allowedCountries).toEqual(['DE'])
    )
    expect(openDialogs()).toBe(0)
  })

  test('the hourly limits are the contract’s, for the limit as drafted, and nothing is said of a limit that would be refused', async () => {
    const current = start()
    const limit = await screen.findByLabelText('Most text messages in a day')
    const hourly = () => document.querySelector('[data-limits="hourly"]')?.textContent ?? null
    expect(hourly()).toContain(
      'With 500 messages a day: at most 125 in one hour in all, and at most 50 in one hour to one destination prefix.'
    )
    expect(hourly()).toContain('not settings of their own')
    await current.user.clear(limit)
    expect(hourly()).toBeNull()
    await current.user.type(limit, '11')
    expect(hourly()).toContain('at most 3 in one hour in all, and at most 2 in one hour')
    await current.user.clear(limit)
    await current.user.type(limit, '0')
    expect(hourly()).toBeNull()
  })
})

describe('what asks first is the contract’s', () => {
  test('a raised daily limit: says what it can cost, saves nothing until confirmed, and is sent once', async () => {
    const current = start()
    const limit = await screen.findByLabelText('Most text messages in a day')
    await current.user.clear(limit)
    await current.user.type(limit, '5000')
    await save(current)
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('This weakens security. Save anyway?')
    expect(dialog.textContent).toContain('More text messages may be sent in a day')
    expect(dialog.textContent).toContain('what a day can cost at most')
    expect(dialog.textContent).toContain('a message that was sent cannot be un-sent')
    expect(current.api.callsTo('PUT', SETTINGS)).toHaveLength(0)

    await current.user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(current.api.callsTo('PUT', SETTINGS)).toHaveLength(0)
    expect(current.api.state.settings.settings.sms.dailyMessageLimit).toBe(500)

    await save(current)
    await current.user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Save anyway' })
    )
    await screen.findByText('Settings saved')
    expect(current.api.callsTo('PUT', SETTINGS)).toHaveLength(1)
    expect(current.api.state.settings.settings.sms.dailyMessageLimit).toBe(5000)
  })

  test('a lowered daily limit is saved with no question', async () => {
    const current = start()
    const limit = await screen.findByLabelText('Most text messages in a day')
    await current.user.clear(limit)
    await current.user.type(limit, '100')
    await save(current)
    await screen.findByText('Settings saved')
    expect(openDialogs()).toBe(0)
    expect(current.api.state.settings.settings.sms.dailyMessageLimit).toBe(100)
  })

  test('a texted code as the second step where one is required: switching it on asks first', async () => {
    const api = installFakeApi()
    api.state.settings.settings.mfa = { policy: 'required', smsCode: { enabled: false } }
    const current = start({ api })
    const toggle = await screen.findByRole('switch', { name: 'Texted code as the second step' })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(rowOf(toggle)).toContain('It is the weakest second step')
    expect(rowOf(toggle)).toContain('never asked for a text instead')
    expect(rowOf(toggle)).toContain('Update the Tula SDKs in your apps before switching it on')
    expect(rowOf(toggle)).toContain('they cannot sign in until it is on again')
    // Text messages are off in the default document, and the row says what that means here.
    expect(rowOf(toggle)).toContain('nobody can use or set up this step until they are on')

    await current.user.click(toggle)
    await save(current)
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain(
      'The second step this environment requires may be a texted code'
    )
    expect(api.state.settings.settings.mfa.smsCode.enabled).toBe(false)
    await current.user.click(within(dialog).getByRole('button', { name: 'Save anyway' }))
    await screen.findByText('Settings saved')
    // Only the switch: the policy beside it is sent along as it was.
    expect(api.state.settings.settings.mfa).toEqual({
      policy: 'required',
      smsCode: { enabled: true },
    })
  })

  test('a texted code as the second step where one is optional is saved with no question', async () => {
    const api = sending(['US'], () => undefined)
    const current = start({ api })
    const toggle = await screen.findByRole('switch', { name: 'Texted code as the second step' })
    expect(rowOf(toggle)).toContain('Text messages are on, to 1 country.')
    await current.user.click(toggle)
    await save(current)
    await screen.findByText('Settings saved')
    expect(openDialogs()).toBe(0)
    expect(api.state.settings.settings.mfa).toEqual({
      policy: 'optional',
      smsCode: { enabled: true },
    })
  })

  test.each([
    [
      'a country added',
      ['US'],
      async (current: World) => addCountry(current, 'DE'),
      'Text messages go to the countries added',
    ],
    [
      'text messages switched on',
      null,
      async (current: World) =>
        current.user.click(await screen.findByRole('switch', { name: 'Send text messages' })),
      'The second step this environment requires may be a texted code',
    ],
  ] as const)(
    '%s under a required second step that may be a texted code asks first',
    async (_name, countries, change, words) => {
      const api = installFakeApi()
      api.state.settings.settings.mfa = { policy: 'required', smsCode: { enabled: true } }
      api.state.settings.settings.sms = {
        ...api.state.settings.settings.sms,
        enabled: countries !== null,
        allowedCountries: [...(countries ?? ['US'])],
      }
      const current = start({ api })
      await change(current)
      await save(current)
      const dialog = await screen.findByRole('dialog')
      expect(dialog.textContent).toContain(words)
      expect(api.callsTo('PUT', SETTINGS)).toHaveLength(0)
      await current.user.click(within(dialog).getByRole('button', { name: 'Save anyway' }))
      await screen.findByText('Settings saved')
      expect(api.callsTo('PUT', SETTINGS)).toHaveLength(1)
    }
  )

  test('a country added where the texted second step is only optional is saved with no question', async () => {
    const api = sending(['US'], (fake) => {
      fake.state.settings.settings.mfa = { policy: 'optional', smsCode: { enabled: true } }
    })
    const current = start({ api })
    await addCountry(current, 'DE')
    await save(current)
    await screen.findByText('Settings saved')
    expect(openDialogs()).toBe(0)
    expect(api.state.settings.settings.sms.allowedCountries).toEqual(['US', 'DE'])
  })

  test('signing in with a texted code: the switch says what it needs, and switching it on asks first', async () => {
    const api = sending(['US'], () => undefined)
    const current = start({ api })
    const toggle = await screen.findByRole('switch', { name: 'Sign in with a texted code' })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(rowOf(toggle)).toContain('It cannot be the only way to sign in')
    expect(rowOf(toggle)).toContain('Text messages are on, to 1 country.')

    await current.user.click(toggle)
    await save(current)
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('A texted code can sign people in')
    expect(api.state.settings.settings.signIn.methods.smsCode.enabled).toBe(false)
    await current.user.click(within(dialog).getByRole('button', { name: 'Save anyway' }))
    await screen.findByText('Settings saved')
    expect(api.state.settings.settings.signIn.methods.smsCode.enabled).toBe(true)
    // Nothing else of the document moved with it.
    expect(api.state.settings.settings.signIn.methods.password.enabled).toBe(true)
    expect(api.state.settings.settings.sms).toEqual({
      enabled: true,
      allowedCountries: ['US'],
      dailyMessageLimit: 500,
      templates: {},
    })
  })

  test.each([
    [{ enabled: false, allowedCountries: ['US'] }, 'Text messages are off above'],
    [{ enabled: true, allowedCountries: [] as string[] }, 'No country is listed above'],
  ])(
    'signing in with a texted code: with text messages %j the switch says %p, and saves with no question',
    async (sms, words) => {
      const api = installFakeApi()
      api.state.settings.settings.sms = { ...api.state.settings.settings.sms, ...sms }
      const current = start({ api })
      const toggle = await screen.findByRole('switch', { name: 'Sign in with a texted code' })
      expect(rowOf(toggle)).toContain(words)
      // It lets nobody in yet, so it is no weakening (the contract's rule, not the screen's).
      await current.user.click(toggle)
      await save(current)
      await screen.findByText('Settings saved')
      expect(openDialogs()).toBe(0)
      expect(api.state.settings.settings.signIn.methods.smsCode.enabled).toBe(true)
    }
  )

  test('the server’s refusal of a texted code as the only way in is shown at the switch', async () => {
    const api = installFakeApi()
    api.override('PUT', /^\/v1\/admin\/settings$/, () =>
      failure(422, 'validation.failed', 'Invalid settings.', [
        {
          field: 'signIn.methods',
          code: 'validation.failed',
          message: 'at least one sign-in method must be enabled',
        },
      ])
    )
    const current = start({ api })
    await current.user.click(
      await screen.findByRole('switch', { name: 'Sign in with a texted code' })
    )
    await save(current)
    await screen.findByText(/A texted code cannot be the only way to sign in/)
    expect(screen.getByText('These settings were not saved.')).toBeDefined()
  })
})

describe('what the server refuses', () => {
  test('a refused country list is said at the list', async () => {
    const api = installFakeApi()
    api.override('PUT', /^\/v1\/admin\/settings$/, () =>
      failure(422, 'validation.failed', 'Invalid settings.', [
        {
          field: 'sms.allowedCountries',
          code: 'validation.failed',
          message: 'must not list a country twice',
        },
      ])
    )
    const current = start({ api })
    await addCountry(current, 'US')
    await save(current)
    await waitFor(() =>
      expect(
        (screen.getByLabelText('Add a country') as HTMLSelectElement).getAttribute('aria-invalid')
      ).toBe('true')
    )
    expect(screen.getAllByText(/must not list a country twice/).length).toBeGreaterThan(1)
  })

  test('a refused daily limit is said at the field', async () => {
    const api = installFakeApi()
    api.override('PUT', /^\/v1\/admin\/settings$/, () =>
      failure(422, 'validation.failed', 'Invalid settings.', [
        { field: 'sms.dailyMessageLimit', code: 'validation.failed', message: 'Too small.' },
      ])
    )
    const current = start({ api })
    const limit = await screen.findByLabelText('Most text messages in a day')
    await current.user.clear(limit)
    await current.user.type(limit, '0')
    await save(current)
    await waitFor(() => expect(limit.getAttribute('aria-invalid')).toBe('true'))
    expect(screen.getAllByText(/Too small\./).length).toBeGreaterThan(0)
  })
})

describe('taking a country out', () => {
  test.each([
    ['one of two', ['US', 'DE'], 'Take out Germany (DE)'],
    ['the last one', ['DE'], 'Take out Germany (DE)'],
  ])(
    '%s: the focus goes to the country picker, not to the document',
    async (_name, countries, button) => {
      const current = start({ api: sending(countries, () => undefined) })
      await current.user.click(await screen.findByRole('button', { name: button }))
      // The row that held the focus is gone with its button.
      await expectFocus(screen.getByLabelText('Add a country'))
      expect(screen.queryByRole('button', { name: button })).toBeNull()
    }
  )
})

describe('the rest of the document', () => {
  test('wording saved under Messages comes back unchanged in a save of a country and a limit', async () => {
    const api = sending(['US'], () => undefined)
    const sms = { sign_in: { text: 'Use {{code}} to sign in' } }
    const emails = { templates: { email_verification: { subject: 'Own subject' } } }
    api.state.settings.settings.sms = {
      ...api.state.settings.settings.sms,
      dailyMessageLimit: 500,
      templates: sms,
    }
    ;(api.state.settings.settings as { emails: unknown }).emails = emails
    const current = start({ api })

    await addCountry(current, 'DE')
    const limit = screen.getByLabelText('Most text messages in a day')
    await current.user.clear(limit)
    await current.user.type(limit, '40')
    await save(current)
    await screen.findByText('Settings saved')

    const [put] = api.callsTo('PUT', SETTINGS)
    const body = put?.body as { sms: unknown; emails: unknown }
    expect(body.sms).toEqual({
      enabled: true,
      allowedCountries: ['US', 'DE'],
      dailyMessageLimit: 40,
      templates: sms,
    })
    expect(body.emails).toEqual(emails)
  })
})

describe('the one save model', () => {
  test('settings saved elsewhere meanwhile are “changed elsewhere”: nothing is overwritten, and a reload shows them', async () => {
    const current = start()
    await addCountry(current, 'DE')
    // Someone else saves: the revision this draft was made from is no longer the server's.
    current.api.state.settings.revision += 1
    current.api.state.settings.settings.sms.dailyMessageLimit = 40
    await save(current)
    const alert = await screen.findByText('Changed elsewhere.')
    expect(alert.closest('[role="alert"]')?.textContent).toContain('your changes were not saved')
    expect(current.api.callsTo('PUT', SETTINGS)).toHaveLength(1)
    expect(current.api.state.settings.settings.sms.allowedCountries).toEqual([])

    await current.user.click(screen.getByRole('button', { name: 'Reload settings' }))
    await waitFor(() =>
      expect((screen.getByLabelText('Most text messages in a day') as HTMLInputElement).value).toBe(
        '40'
      )
    )
    // The draft went with the reload, and nothing was retried.
    expect(screen.queryByRole('list', { name: COUNTRIES })).toBeNull()
    expect(current.api.callsTo('PUT', SETTINGS)).toHaveLength(1)
  })

  test('settings managed by a config file say so, and a change to them asks first', async () => {
    const api = installFakeApi()
    api.state.settings.managedBy = {
      tool: 'tula-apply',
      configHash: `sha256:${'a'.repeat(64)}`,
      at: '2026-10-01T00:00:00.000Z',
      revision: 3,
      drifted: false,
    }
    const current = start({ api })
    await screen.findByText('Managed by tula apply')
    await addCountry(current, 'DE')
    await save(current)
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('Change settings managed by a config file?')
    await current.user.click(within(dialog).getByRole('button', { name: 'Save anyway' }))
    await screen.findByText('Settings saved')
    expect(api.state.settings.settings.sms.allowedCountries).toEqual(['DE'])
  })
})

describe('whether the deployment can send', () => {
  function note(): HTMLElement | null {
    return document.querySelector('[data-sender]')
  }

  test('a deployment with a sender: the server’s own sentence, and no warning', async () => {
    start()
    await waitFor(() => expect(note()?.getAttribute('data-sender')).toBe('ok'))
    // The check's own sentence leads; its status is a word beside the check's name, and
    // nothing says or draws that a sender works: the check looked at configuration only.
    expect(note()?.querySelector('p')?.textContent).toBe(SMS_SENDER_OK)
    expect(note()?.textContent).toContain('Status of the sms_sender check: OK')
    expect(note()?.textContent).not.toContain('SMS sender of this deployment')
    expect(note()?.querySelector('svg')).toBeNull()
  })

  test('the note is asked for once in five minutes, however often the screen is opened', async () => {
    const DIAGNOSTICS = '/v1/instance/diagnostics'
    const current = start()
    await waitFor(() => expect(note()?.getAttribute('data-sender')).toBe('ok'))
    expect(current.api.callsTo('GET', DIAGNOSTICS)).toHaveLength(1)

    const nav = screen.getByRole('navigation', { name: 'Environment' })
    await current.user.click(within(nav).getByRole('link', { name: 'Users' }))
    await screen.findByRole('heading', { level: 1, name: 'Users' })
    // Four minutes later the answer is still the one shown.
    const real = Date.now()
    const clock = spyOn(Date, 'now').mockImplementation(() => real + 4 * 60_000)
    try {
      await current.user.click(within(nav).getByRole('link', { name: 'Text messages' }))
      await screen.findByRole('heading', { level: 1, name: 'Text messages' })
      await waitFor(() => expect(note()?.getAttribute('data-sender')).toBe('ok'))
      await screen.findByText('No unsaved changes.')
      expect(current.api.callsTo('GET', DIAGNOSTICS)).toHaveLength(1)
    } finally {
      clock.mockRestore()
    }
  })

  test.each([
    ['skipped', 'Skipped', SMS_SENDER_NONE, undefined],
    [
      'warn',
      'Warning',
      'SMS_PROVIDER is `none`, and 1 environment has text messages switched on: no message is sent.',
      'Set SMS_PROVIDER=twilio and the TWILIO_* variables on every API instance and restart them.',
    ],
    [
      'fail',
      'Failing',
      'SMS_PROVIDER is `none`, and 1 environment has signing in with a texted code switched on.',
      'Set SMS_PROVIDER=twilio. Or switch the texted sign-in code off.',
    ],
  ] as const)(
    'a deployment whose check is %s: said first, in words, with the server’s fix, and the settings stay editable',
    async (status, label, summary, fix) => {
      const api = installFakeApi()
      api.state.smsSender = { status, summary, ...(fix ? { fix } : {}) }
      const current = start({ api })
      await waitFor(() => expect(note()?.getAttribute('data-sender')).toBe(status))
      // State in words as well as colour.
      expect(note()?.textContent).toContain(`Status of the sms_sender check: ${label}`)
      expect(note()?.textContent).toContain(summary)
      if (fix) {
        expect(note()?.textContent).toContain(`Fix: ${fix}`)
      }
      expect(note()?.textContent).toContain('These settings can be edited either way.')
      // It comes before the settings it is about.
      const toggle = screen.getByRole('switch', { name: 'Send text messages' })
      expect(
        (note() as HTMLElement).compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy()

      await addCountry(current, 'DE')
      await current.user.click(toggle)
      await save(current)
      await screen.findByText('Settings saved')
      expect(api.state.settings.settings.sms.enabled).toBe(true)
    }
  )

  test.each([
    [
      'a server that reports no such check',
      (api: ReturnType<typeof installFakeApi>) => {
        api.state.smsSender = null
      },
    ],
    [
      'diagnostics that cannot be read',
      (api: ReturnType<typeof installFakeApi>) => {
        api.override('GET', /^\/v1\/instance\/diagnostics$/, () =>
          failure(503, 'service.unavailable', 'Try again.')
        )
      },
    ],
  ])('%s: the screen says it could not be read, and claims nothing', async (_name, arrange) => {
    const api = installFakeApi()
    arrange(api)
    start({ api })
    await screen.findByText('Whether this deployment can send text messages could not be read.')
    expect(note()).toBeNull()
    expect(screen.getByRole('switch', { name: 'Send text messages' })).toBeDefined()
  })
})

describe('codes sent and never used', () => {
  function totals(): string {
    return document.querySelector('[data-usage="totals"]')?.textContent ?? ''
  }

  test('no code texted: the span and the zeros, and no table', async () => {
    const current = start()
    await waitFor(() => expect(totals()).toContain('The last 7 days, in UTC: 2026-09-28 to today.'))
    expect(totals()).toContain('0 codes sent, 0 used, 0 never used.')
    expect(screen.getByText('No code was texted in these days')).toBeDefined()
    expect(screen.queryByRole('table')).toBeNull()
    // The route's default span, for this screen's environment.
    const [call] = current.api.callsTo('GET', USAGE)
    expect(call?.search.get('days')).toBe('7')
    expect(call?.headers.get('x-tula-environment')).toBe(DEV_PATH.split('/e/')[1] ?? '')
  })

  test('by destination prefix: the server’s counts and order, every country of a shared prefix, and what the numbers are not', async () => {
    const api = installFakeApi()
    api.state.smsUsage = [
      { prefix: '+49', sent: 12, used: 11 },
      { prefix: '+1', sent: 40, used: 2 },
      { prefix: '+1242', sent: 1, used: 0 },
      { prefix: '+999', sent: 3, used: 0 },
    ]
    start({ api })
    const table = await screen.findByRole('table')
    expect(totals()).toContain('56 codes sent, 13 used, 43 never used.')
    const rows = within(table)
      .getAllByRole('row')
      .slice(1)
      .map((row) =>
        within(row)
          .getAllByRole('cell')
          .map((cell) => cell.textContent)
      )
    // Most never used first, as the server orders them.
    expect(rows).toEqual([
      [
        '+1Canada, United States (2 countries share this prefix and are counted together)',
        '40',
        '2',
        '38',
      ],
      ['+999A prefix this version of the dashboard does not know', '3', '0', '3'],
      // The same number never used: the one with more sent first.
      ['+49Germany', '12', '11', '1'],
      ['+1242Bahamas', '1', '0', '1'],
    ])
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((header) => header.textContent)
    ).toEqual(['Destination', 'Codes sent', 'Used', 'Never used'])
    // What the numbers are and are not.
    expect(screen.getByText(/It is not a delivery/)).toBeDefined()
    expect(screen.getByText(/not a count of segments, and\s+not an amount of money/)).toBeDefined()
    expect(screen.getByText(/also one that expired or was replaced by a later code/)).toBeDefined()
    expect(
      screen.getByText(/which number or which user a code went to, or who asked/)
    ).toBeDefined()
    expect(
      screen.getByText(/works out a rate or a trend, or decides that something is abuse/)
    ).toBeDefined()
    // No rate is drawn: no percent sign anywhere in the section.
    expect(table.closest('section')?.textContent).not.toContain('%')
    expect(absent(/more destinations than/i)).toBe(true)
  })

  test('another span is asked of the server, and “Read again” asks again', async () => {
    const api = installFakeApi()
    api.state.smsUsage = [{ prefix: '+49', sent: 1, used: 1 }]
    const current = start({ api })
    await screen.findByRole('table')
    await current.user.selectOptions(screen.getByLabelText('Days'), '30')
    await waitFor(() =>
      expect(totals()).toContain('The last 30 days, in UTC: 2026-09-05 to today.')
    )
    await current.user.selectOptions(screen.getByLabelText('Days'), '1')
    await waitFor(() => expect(totals()).toContain('Today, in UTC (2026-10-04).'))
    expect(totals()).toContain('1 code sent, 1 used, 0 never used.')
    expect(api.callsTo('GET', USAGE).map((call) => call.search.get('days'))).toEqual([
      '7',
      '30',
      '1',
    ])

    api.state.smsUsage = [{ prefix: '+49', sent: 2, used: 1 }]
    await current.user.click(screen.getByRole('button', { name: 'Read again' }))
    await waitFor(() => expect(totals()).toContain('2 codes sent, 1 used, 1 never used.'))
  })

  test('more destinations than one answer lists: said, with the totals over all of them', async () => {
    const api = installFakeApi()
    api.state.smsUsageMaxPrefixes = 1
    api.state.smsUsage = [
      { prefix: '+49', sent: 5, used: 0 },
      { prefix: '+33', sent: 4, used: 4 },
    ]
    start({ api })
    await screen.findByRole('table')
    expect(document.querySelector('[data-usage="truncated"]')?.textContent).toContain(
      'More destinations than the 1 listed were texted in these days. The totals above count all of them.'
    )
    expect(totals()).toContain('9 codes sent, 4 used, 5 never used.')
  })

  test('a prefix that holds what cannot be seen is written out, never drawn as it came', async () => {
    const api = installFakeApi()
    api.override('GET', /^\/v1\/admin\/sms\/usage$/, () => ({
      since: '2026-09-28',
      days: 7,
      sent: 1,
      used: 0,
      unused: 1,
      prefixes: [{ prefix: '+4\u{200B}9', sent: 1, used: 0, unused: 1 }],
      truncated: false,
    }))
    start({ api })
    const table = await screen.findByRole('table')
    expect(table.textContent).toContain('+4\\u{200B}9')
    expect(table.textContent).not.toContain('\u{200B}')
  })

  test('counts that cannot be read: said, with a way to try again, and the settings above still work', async () => {
    const api = installFakeApi()
    let fail = true
    api.override('GET', /^\/v1\/admin\/sms\/usage$/, () =>
      fail ? failure(503, 'service.unavailable', 'Try again.') : undefined
    )
    const current = start({ api })
    await screen.findByText('This could not be loaded')
    expect(screen.getByRole('switch', { name: 'Send text messages' })).toBeDefined()
    fail = false
    api.override('GET', /^\/v1\/admin\/sms\/usage$/, () => ({
      since: '2026-09-28',
      days: 7,
      sent: 0,
      used: 0,
      unused: 0,
      prefixes: [],
      truncated: false,
    }))
    await current.user.click(screen.getByRole('button', { name: 'Try again' }))
    await screen.findByText('No code was texted in these days')
  })
})

describe('one place for each setting', () => {
  test('the sign-in methods screen says how the two texted-code settings stand and where they are changed, and has no switch for them', async () => {
    const api = installFakeApi()
    api.state.settings.settings.mfa = { policy: 'optional', smsCode: { enabled: true } }
    const current = renderApp(`${DEV_PATH}/sign-in-methods`, { api })
    world = current
    await screen.findByRole('switch', { name: 'Emailed code' })
    expect(screen.queryByRole('switch', { name: /Texted code/ })).toBeNull()
    expect(screen.queryByRole('switch', { name: /texted code/ })).toBeNull()
    const states = [...document.querySelectorAll('[data-elsewhere]')].map((node) => [
      node.parentElement?.textContent ?? '',
      node.getAttribute('data-elsewhere'),
    ])
    expect(states).toHaveLength(2)
    expect(states[0]?.[0]).toContain('Texted code')
    expect(states[0]?.[1]).toBe('off')
    expect(states[1]?.[0]).toContain('Texted code as the second step')
    expect(states[1]?.[1]).toBe('on')
    // A change of the policy still sends the switch along: the whole document is replaced.
    await current.user.selectOptions(screen.getByLabelText('Two-step verification'), 'required')
    await current.user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('Settings saved')
    expect(api.state.settings.settings.mfa).toEqual({
      policy: 'required',
      smsCode: { enabled: true },
    })

    const [link] = screen.getAllByRole('link', { name: 'Text messages' }).slice(-1)
    await current.user.click(link as HTMLElement)
    await screen.findByRole('heading', { level: 1, name: 'Text messages' })
    expect(current.location()).toBe(`${DEV_PATH}/text-messages`)
  })

  test('the general settings no longer hold the text message settings', async () => {
    world = renderApp(`${DEV_PATH}/settings`)
    await screen.findByLabelText('App name')
    expect(screen.queryByRole('switch', { name: 'Send text messages' })).toBeNull()
    expect(screen.queryByLabelText('Most text messages in a day')).toBeNull()
  })
})
