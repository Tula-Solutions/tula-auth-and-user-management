import { afterEach, describe, expect, test } from 'bun:test'
import { act, screen, waitFor, within } from '@testing-library/react'
import {
  type FakeNativeApp,
  failure,
  fakeAndroidApp,
  fakeIosApp,
  IDS,
  installFakeApi,
} from '~/testing/fake-api'
import {
  DEV_PATH,
  expectFocus,
  holdAnswers,
  openDialogs,
  PROD_PATH,
  renderApp,
  type World,
} from '~/testing/harness'

// The native apps screen: the iOS and Android apps an environment's two association files
// name. Rendered as the whole app, against the fake API.

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

const fingerprint = (byte: string) => Array.from({ length: 32 }, () => byte).join(':')
const AA = fingerprint('AA')
const BB = fingerprint('BB')
const RECORDED = 'This is recorded in the audit log as a weakening.'
const ROOT = '/v1/admin/native-apps'

function dialog(): HTMLElement {
  return screen.getByRole('dialog')
}

function button(name: string): HTMLElement {
  return within(dialog()).getByRole('button', { name })
}

function alerts(): string[] {
  return within(dialog())
    .queryAllByRole('alert')
    .map((alert) => alert.textContent ?? '')
}

/** The app on the native apps screen of an environment that has these apps. */
function withApps(apps: FakeNativeApp[], path = DEV_PATH): World {
  const api = installFakeApi()
  const environmentId = path === PROD_PATH ? IDS.production : IDS.development
  api.state.nativeApps.push(...apps.map((app) => ({ ...app, environmentId })))
  return start(`${path}/native-apps`, { api })
}

function sent(api: World['api'], method: string) {
  return api.calls
    .filter((call) => call.method === method && call.path.startsWith(ROOT))
    .map((call) => call.body)
}

describe('the list', () => {
  test('the navigation leads to it; with no app it says so, and shows where the two files are served', async () => {
    const { user, location } = start(`${DEV_PATH}/users`)
    await screen.findByRole('heading', { level: 1, name: 'Users' })
    await user.click(screen.getByRole('link', { name: 'Native apps' }))
    await screen.findByRole('heading', { level: 1, name: 'Native apps' })
    expect(location()).toBe(`${DEV_PATH}/native-apps`)
    await screen.findByText('No native apps yet')
    expect(screen.getByText('0 of 20 apps')).toBeTruthy()
    const files = await screen.findAllByTestId('association-file')
    const origin = window.location.origin
    expect(
      files.map((file) => within(file).getAllByText(/\/v1\/environments\//)[0]?.textContent)
    ).toEqual([
      `${origin}/v1/environments/${IDS.development}/.well-known/apple-app-site-association`,
      `${origin}/v1/environments/${IDS.development}/.well-known/assetlinks.json`,
    ])
    // An address to copy into a proxy's configuration, never a link the dashboard follows.
    for (const file of files) {
      expect(within(file).queryAllByRole('link')).toHaveLength(0)
    }
  })

  test('each app is listed with what its file says of it, and state is in words', async () => {
    withApps([fakeIosApp(), fakeAndroidApp({ sha256CertFingerprints: [AA, BB] })])
    const cards = await screen.findAllByTestId('native-app')
    expect(cards.map((card) => card.getAttribute('data-platform'))).toEqual(['ios', 'android'])
    const [ios, android] = cards as [HTMLElement, HTMLElement]
    expect(within(ios).getByRole('heading', { level: 2 }).textContent).toBe('iOS app.northline.ios')
    expect(within(ios).getByText('A1B2C3D4E5.app.northline.ios')).toBeTruthy()
    expect(within(android).getByRole('heading', { level: 2 }).textContent).toBe(
      'Android app.northline.android'
    )
    expect(within(android).getByText(AA)).toBeTruthy()
    expect(within(android).getByText(BB)).toBeTruthy()
    expect(screen.getByText('2 of 20 apps')).toBeTruthy()
  })

  test('an app’s link paths are listed, none is said in words, and Android’s reach is said', async () => {
    withApps([
      fakeIosApp({ appLinkPaths: ['/link', '/oauth/callback'] }),
      fakeAndroidApp({ appLinkPaths: ['/oauth/callback'] }),
      fakeIosApp({ bundleId: 'app.northline.plain' }),
    ])
    const [ios, android, plain] = (await screen.findAllByTestId('native-app')) as [
      HTMLElement,
      HTMLElement,
      HTMLElement,
    ]
    expect(within(ios).getByText('/link')).toBeTruthy()
    expect(within(ios).getByText('/oauth/callback')).toBeTruthy()
    expect(ios.textContent).not.toContain('every link of the domain')
    expect(within(android).getByText('/oauth/callback')).toBeTruthy()
    expect(android.textContent).toContain('the app may claim every link of the domain')
    expect(plain.textContent).toContain('None: the served file hands this app no link.')
  })

  test('a link path from the server is written out where a reader could not see all of it', async () => {
    withApps([fakeIosApp({ appLinkPaths: ['/oa\u{202E}uth'] })])
    const card = await screen.findByTestId('native-app')
    expect(card.textContent).not.toContain('\u{202E}')
  })

  test('an identifier from the server is written out where a reader could not see all of it', async () => {
    withApps([fakeIosApp({ bundleId: 'app.north‮line' })])
    const card = await screen.findByTestId('native-app')
    expect(card.textContent).not.toContain('‮')
    expect(within(card).getByRole('button', { name: /Remove app\.north/ })).toBeTruthy()
  })
})

describe('registering an app', () => {
  test('an iOS app is asked about first, in the contract’s terms, and then sent once', async () => {
    const { user, api } = withApps([])
    await user.click(await screen.findByRole('button', { name: 'Register app' }))
    await user.type(within(dialog()).getByLabelText('Team ID'), 'A1B2C3D4E5')
    await user.type(within(dialog()).getByLabelText('Bundle ID'), 'app.northline.ios')
    await user.click(button('Continue'))
    await screen.findByRole('heading', { name: 'Register this app?' })
    expect(sent(api, 'POST')).toHaveLength(0)
    const question = within(dialog()).getByTestId('weakening').textContent ?? ''
    expect(question).toContain('The file Apple fetches for this environment will name this app.')
    expect(question).toContain(RECORDED)
    await user.click(button('Register app'))
    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(sent(api, 'POST')).toEqual([
      { platform: 'ios', teamId: 'A1B2C3D4E5', bundleId: 'app.northline.ios' },
    ])
    const card = await screen.findByTestId('native-app')
    expect(card.textContent).toContain('A1B2C3D4E5.app.northline.ios')
  })

  test('an app registered with link paths is asked about both, and the paths are sent as typed, each once', async () => {
    const { user, api } = withApps([])
    await user.click(await screen.findByRole('button', { name: 'Register app' }))
    await user.type(within(dialog()).getByLabelText('Team ID'), 'A1B2C3D4E5')
    await user.type(within(dialog()).getByLabelText('Bundle ID'), 'app.northline.ios')
    await user.click(within(dialog()).getByLabelText('App link paths'))
    await user.paste('/oauth/callback\n/link\n/oauth/callback')
    await user.click(button('Continue'))
    await screen.findByRole('heading', { name: 'Register this app?' })
    const question = within(dialog()).getByTestId('weakening').textContent ?? ''
    expect(question).toContain('will name this app.')
    expect(question).toContain('will hand this app the links of an added path')
    expect(sent(api, 'POST')).toHaveLength(0)
    await user.click(button('Register app'))
    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(sent(api, 'POST')).toEqual([
      {
        platform: 'ios',
        teamId: 'A1B2C3D4E5',
        bundleId: 'app.northline.ios',
        appLinkPaths: ['/oauth/callback', '/link'],
      },
    ])
  })

  test.each([
    ['a wildcard', '/oauth/*'],
    ['a whole address', 'https://northline.app/oauth'],
    ['a trailing slash', '/oauth/'],
  ])('a link path with %s names its entry and sends nothing', async (_name, path) => {
    const { user, api } = withApps([])
    await user.click(await screen.findByRole('button', { name: 'Register app' }))
    await user.type(within(dialog()).getByLabelText('Team ID'), 'A1B2C3D4E5')
    await user.type(within(dialog()).getByLabelText('Bundle ID'), 'app.northline.ios')
    await user.click(within(dialog()).getByLabelText('App link paths'))
    await user.paste(`/fine\n${path}`)
    await user.click(button('Continue'))
    await waitFor(() => expect(alerts().join()).toContain('Entry 2: Must be one exact path'))
    expect(sent(api, 'POST')).toHaveLength(0)
  })

  test('an Android app takes fingerprints as pasted: one per line, any case, a repeat dropped', async () => {
    const { user, api } = withApps([])
    await user.click(await screen.findByRole('button', { name: 'Register app' }))
    await user.selectOptions(within(dialog()).getByLabelText('Platform'), 'android')
    await user.type(within(dialog()).getByLabelText('Package name'), 'app.northline.android')
    await user.click(within(dialog()).getByLabelText('Certificate fingerprints (SHA-256)'))
    await user.paste(`${'bb'.repeat(32)}\n${AA}\n${BB.toLowerCase()}`)
    await user.click(button('Continue'))
    await screen.findByRole('heading', { name: 'Register this app?' })
    await user.click(button('Register app'))
    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(api.state.nativeApps).toMatchObject([
      {
        platform: 'android',
        packageName: 'app.northline.android',
        sha256CertFingerprints: [AA, BB],
      },
    ])
  })

  test.each([
    ['a team in lower case', { 'Team ID': 'a1b2c3d4e5', 'Bundle ID': 'app.northline.ios' }],
    ['a bundle ID of one segment', { 'Team ID': 'A1B2C3D4E5', 'Bundle ID': 'northline' }],
    ['nothing typed', {}],
  ])('%s is refused by the form, on its field, and nothing is sent', async (_name, typed) => {
    const { user, api } = withApps([])
    await user.click(await screen.findByRole('button', { name: 'Register app' }))
    for (const [label, value] of Object.entries(typed)) {
      await user.type(within(dialog()).getByLabelText(label), value)
    }
    await user.click(button('Continue'))
    await waitFor(() => expect(alerts().length).toBeGreaterThan(0))
    expect(screen.queryAllByRole('heading', { name: 'Register this app?' })).toHaveLength(0)
    expect(sent(api, 'POST')).toHaveLength(0)
  })

  test('a fingerprint that is not one names its entry', async () => {
    const { user } = withApps([])
    await user.click(await screen.findByRole('button', { name: 'Register app' }))
    await user.selectOptions(within(dialog()).getByLabelText('Platform'), 'android')
    await user.type(within(dialog()).getByLabelText('Package name'), 'app.northline.android')
    await user.click(within(dialog()).getByLabelText('Certificate fingerprints (SHA-256)'))
    await user.paste(`${AA}\nAA:BB`)
    await user.click(button('Continue'))
    await waitFor(() => expect(alerts().join(' ')).toContain('Entry 2:'))
  })

  test('in production the name is typed before the app is registered', async () => {
    const { user, api } = withApps([], PROD_PATH)
    await user.click(await screen.findByRole('button', { name: 'Register app' }))
    await user.type(within(dialog()).getByLabelText('Team ID'), 'A1B2C3D4E5')
    await user.type(within(dialog()).getByLabelText('Bundle ID'), 'app.northline.ios')
    await user.click(button('Continue'))
    await screen.findByRole('heading', { name: 'Register this app?' })
    expect(button('Register app').getAttribute('aria-disabled')).toBe('true')
    await user.click(button('Register app'))
    expect(sent(api, 'POST')).toHaveLength(0)
    await user.type(within(dialog()).getByLabelText(/to confirm/), 'app.northline.ios')
    await user.click(button('Register app'))
    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(sent(api, 'POST')).toHaveLength(1)
  })

  test('an app that is there by now, and a full environment, are said in words on the form', async () => {
    const { user, api } = withApps([fakeIosApp()])
    await user.click(await screen.findByRole('button', { name: 'Register app' }))
    await user.type(within(dialog()).getByLabelText('Team ID'), 'ZZZZZZZZZZ')
    await user.type(within(dialog()).getByLabelText('Bundle ID'), 'app.northline.ios')
    await user.click(button('Continue'))
    await user.click(button('Register app'))
    await waitFor(() =>
      expect(alerts()).toEqual([
        'This environment already has that app. Close this and look at the list again.',
      ])
    )
    api.override('POST', /^\/v1\/admin\/native-apps$/, () =>
      failure(409, 'resource.conflict', 'This environment already has 20 native apps.', undefined, {
        max: 20,
      })
    )
    await user.click(button('Continue'))
    await user.click(button('Register app'))
    await waitFor(() =>
      expect(alerts()).toEqual([
        'This environment already has 20 native apps, which is as many as it may have. Remove one first.',
      ])
    )
  })
})

describe('changing an app', () => {
  test('a fingerprint taken away is saved without a question', async () => {
    const { user, api } = withApps([fakeAndroidApp({ sha256CertFingerprints: [AA, BB] })])
    await user.click(await screen.findByRole('button', { name: 'Edit app.northline.android' }))
    const field = within(dialog()).getByLabelText('Certificate fingerprints (SHA-256)')
    expect((field as HTMLTextAreaElement).value).toBe(`${AA}\n${BB}`)
    await user.clear(field)
    await user.click(field)
    await user.paste(AA)
    await user.click(button('Save changes'))
    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(sent(api, 'PATCH')).toEqual([{ sha256CertFingerprints: [AA] }])
  })

  test('a gained fingerprint is asked about first', async () => {
    const { user, api } = withApps([fakeAndroidApp({ sha256CertFingerprints: [AA] })])
    await user.click(await screen.findByRole('button', { name: 'Edit app.northline.android' }))
    const field = within(dialog()).getByLabelText('Certificate fingerprints (SHA-256)')
    await user.click(field)
    await user.paste(`\n${BB}`)
    await user.click(button('Save changes'))
    await screen.findByRole('heading', { name: 'Add a certificate?' })
    expect(sent(api, 'PATCH')).toHaveLength(0)
    expect(within(dialog()).getByTestId('weakening').textContent).toContain(
      'Whoever holds the key of an added certificate can sign an app that Android accepts as this one.'
    )
    // Cancel goes back to the form with what was typed.
    await user.click(button('Cancel'))
    expect(
      (within(dialog()).getByLabelText('Certificate fingerprints (SHA-256)') as HTMLTextAreaElement)
        .value
    ).toBe(`${AA}\n${BB}`)
    await user.click(button('Save changes'))
    await user.click(button('Save changes'))
    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(sent(api, 'PATCH')).toEqual([{ sha256CertFingerprints: [AA, BB] }])
  })

  test('a gained link path is asked about first, in the platform’s own terms, and only the paths are sent', async () => {
    const { user, api } = withApps([fakeAndroidApp({ sha256CertFingerprints: [AA] })])
    await user.click(await screen.findByRole('button', { name: 'Edit app.northline.android' }))
    await user.click(within(dialog()).getByLabelText('App link paths'))
    await user.paste('/oauth/callback')
    await user.click(button('Save changes'))
    await screen.findByRole('heading', { name: 'Hand the app more links?' })
    expect(sent(api, 'PATCH')).toHaveLength(0)
    expect(within(dialog()).getByTestId('weakening').textContent).toContain(
      'the file lets this app claim every link of the domain it is published on, not only the paths listed'
    )
    await user.click(button('Save changes'))
    await waitFor(() => expect(openDialogs()).toBe(0))
    // The fingerprints did not differ and are not sent.
    expect(sent(api, 'PATCH')).toEqual([{ appLinkPaths: ['/oauth/callback'] }])
    expect(api.state.nativeApps).toMatchObject([
      { sha256CertFingerprints: [AA], appLinkPaths: ['/oauth/callback'] },
    ])
  })

  test('a link path taken away is saved without a question, and the last one as an empty list', async () => {
    const { user, api } = withApps([fakeIosApp({ appLinkPaths: ['/link', '/oauth/callback'] })])
    await user.click(await screen.findByRole('button', { name: 'Edit app.northline.ios' }))
    const field = within(dialog()).getByLabelText('App link paths') as HTMLTextAreaElement
    expect(field.value).toBe('/link\n/oauth/callback')
    await user.clear(field)
    await user.click(button('Save changes'))
    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(sent(api, 'PATCH')).toEqual([{ appLinkPaths: [] }])
    expect((await screen.findByTestId('native-app')).textContent).toContain(
      'None: the served file hands this app no link.'
    )
  })

  test('the same paths in another order are no change', async () => {
    const { user, api } = withApps([fakeIosApp({ appLinkPaths: ['/link', '/oauth'] })])
    await user.click(await screen.findByRole('button', { name: 'Edit app.northline.ios' }))
    const field = within(dialog()).getByLabelText('App link paths')
    await user.clear(field)
    await user.click(field)
    await user.paste('/oauth\n/link')
    await user.click(button('Save changes'))
    await waitFor(() => expect(alerts()).toEqual(['Change the team or the link paths first.']))
    expect(sent(api, 'PATCH')).toHaveLength(0)
  })

  test('another team is asked about first, and typed in production', async () => {
    const { user, api } = withApps([fakeIosApp()], PROD_PATH)
    await user.click(await screen.findByRole('button', { name: 'Edit app.northline.ios' }))
    const field = within(dialog()).getByLabelText('Team ID')
    await user.clear(field)
    await user.type(field, 'ZZZZZZZZZZ')
    await user.click(button('Save changes'))
    await screen.findByRole('heading', { name: 'Move the app to another team?' })
    expect(button('Save changes').getAttribute('aria-disabled')).toBe('true')
    await user.type(within(dialog()).getByLabelText(/to confirm/), 'app.northline.ios')
    await user.click(button('Save changes'))
    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(sent(api, 'PATCH')).toEqual([{ teamId: 'ZZZZZZZZZZ' }])
  })

  test('a save that changes nothing says so and sends nothing', async () => {
    const { user, api } = withApps([fakeIosApp()])
    await user.click(await screen.findByRole('button', { name: 'Edit app.northline.ios' }))
    await user.click(button('Save changes'))
    await waitFor(() => expect(alerts()).toEqual(['Change the team or the link paths first.']))
    expect(sent(api, 'PATCH')).toHaveLength(0)
  })

  test('an app that changed elsewhere meanwhile is said in words', async () => {
    const { user, api } = withApps([fakeAndroidApp({ sha256CertFingerprints: [AA, BB] })])
    api.override('PATCH', /^\/v1\/admin\/native-apps\//, () =>
      failure(409, 'resource.conflict', 'The app changed since it was read.')
    )
    await user.click(await screen.findByRole('button', { name: 'Edit app.northline.android' }))
    const field = within(dialog()).getByLabelText('Certificate fingerprints (SHA-256)')
    await user.clear(field)
    await user.click(field)
    await user.paste(AA)
    await user.click(button('Save changes'))
    await waitFor(() =>
      expect(alerts()).toEqual([
        'It was changed elsewhere since this screen read it. Close this, look at it again, and repeat the change if it is still wanted.',
      ])
    )
  })
})

describe('removing an app', () => {
  test('names the app, and the heading takes the focus once its card is gone', async () => {
    const { user, api } = withApps([fakeIosApp()])
    await user.click(await screen.findByRole('button', { name: 'Remove app.northline.ios' }))
    expect(within(dialog()).getByRole('heading').textContent).toBe(
      'Remove the iOS app app.northline.ios?'
    )
    await user.click(button('Remove app'))
    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(sent(api, 'DELETE')).toHaveLength(1)
    await screen.findByText('No native apps yet')
    await expectFocus(screen.getByRole('heading', { level: 1, name: 'Native apps' }))
  })

  test('in production the name is typed first', async () => {
    const { user, api } = withApps([fakeAndroidApp()], PROD_PATH)
    await user.click(await screen.findByRole('button', { name: 'Remove app.northline.android' }))
    expect(button('Remove app').getAttribute('aria-disabled')).toBe('true')
    await user.click(button('Remove app'))
    expect(sent(api, 'DELETE')).toHaveLength(0)
    await user.type(within(dialog()).getByLabelText(/to confirm/), 'app.northline.android')
    await user.click(button('Remove app'))
    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(sent(api, 'DELETE')).toHaveLength(1)
  })

  test('a refused removal stays open, says why, and can be tried again', async () => {
    const { user, api } = withApps([fakeIosApp()])
    api.override('DELETE', /^\/v1\/admin\/native-apps\//, () =>
      failure(503, 'service.unavailable', 'The service is unavailable.')
    )
    await user.click(await screen.findByRole('button', { name: 'Remove app.northline.ios' }))
    await user.click(button('Remove app'))
    await waitFor(() => expect(alerts()).toEqual(['The service is unavailable.']))
    expect(button('Remove app').getAttribute('aria-disabled')).toBeNull()
  })
})

describe('a confirmed change is sent once, however slow the list is to come back', () => {
  /** Confirm, wait for the list to be asked for again, and confirm once more. */
  async function confirmTwice(current: World, label: string, method: string): Promise<void> {
    const hold = holdAnswers((path, _headers, asked) => asked === 'GET' && path === ROOT)
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
    const current = withApps([fakeIosApp()])
    await current.user.click(
      await screen.findByRole('button', { name: 'Remove app.northline.ios' })
    )
    await confirmTwice(current, 'Remove app', 'DELETE')
  })

  test('a registration', async () => {
    const current = withApps([])
    await current.user.click(await screen.findByRole('button', { name: 'Register app' }))
    await current.user.type(within(dialog()).getByLabelText('Team ID'), 'A1B2C3D4E5')
    await current.user.type(within(dialog()).getByLabelText('Bundle ID'), 'app.northline.ios')
    await current.user.click(button('Continue'))
    await screen.findByRole('heading', { name: 'Register this app?' })
    await confirmTwice(current, 'Register app', 'POST')
  })

  test('an edit that was asked about', async () => {
    const current = withApps([fakeIosApp()])
    await current.user.click(await screen.findByRole('button', { name: 'Edit app.northline.ios' }))
    const field = within(dialog()).getByLabelText('Team ID')
    await current.user.clear(field)
    await current.user.type(field, 'ZZZZZZZZZZ')
    await current.user.click(button('Save changes'))
    await screen.findByRole('heading', { name: 'Move the app to another team?' })
    await confirmTwice(current, 'Save changes', 'PATCH')
  })
})
