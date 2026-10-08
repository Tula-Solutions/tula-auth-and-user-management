import { afterEach, describe, expect, test } from 'bun:test'
import { screen, waitFor, within } from '@testing-library/react'
import { failure } from '~/testing/fake-api'
import { DEV_PATH, openDialogs, renderApp, type World } from '~/testing/harness'

// JWT templates on the session profiles screen (ADR 0036): the templates themselves, their
// claims, and the template a profile uses. All of it is one draft of the settings editor.

let world: World | undefined

function start(): World {
  world = renderApp(`${DEV_PATH}/sessions`)
  return world
}

afterEach(() => {
  world?.api.restore()
  world = undefined
})

/** The sessions settings the fake API holds, as the document's own (open) shape. */
function saved(current: World) {
  return current.api.state.settings.settings.sessions as unknown as {
    jwtTemplates: Record<string, { claims: Record<string, unknown> }>
    profiles: Record<string, { jwtTemplate: string | null }>
  }
}

function card(pattern: RegExp): HTMLElement {
  return screen.getByRole('heading', { name: pattern }).closest('li') as HTMLElement
}

/** Whether nothing on the screen has this text: a boolean, never an element in a matcher. */
function absent(text: string | RegExp): boolean {
  return screen.queryByText(text) === null
}

async function addTemplate(current: World, name: string) {
  await current.user.type(await screen.findByLabelText('New template name'), name)
  await current.user.click(screen.getByRole('button', { name: 'Add template' }))
}

async function addClaim(current: World, template: HTMLElement, key: string) {
  await current.user.type(within(template).getByLabelText('New claim name'), key)
  await current.user.click(within(template).getByRole('button', { name: 'Add claim' }))
}

async function save(current: World) {
  await current.user.click(screen.getByRole('button', { name: 'Save changes' }))
}

describe('JWT templates', () => {
  test('a template with a claim of every kind is added, chosen for a profile and saved', async () => {
    const current = start()
    const { user } = current
    await addTemplate(current, 'app')
    const app = card(/^app/)
    expect(within(app).getByText('Not used by a profile.')).toBeTruthy()

    await addClaim(current, app, 'email')
    await user.selectOptions(within(app).getByLabelText('Value of email'), 'user.email')
    await addClaim(current, app, 'role')
    await user.selectOptions(within(app).getByLabelText('Value of role'), 'text')
    await user.type(within(app).getByLabelText('Text of role'), 'member')
    await addClaim(current, app, 'seats')
    await user.selectOptions(within(app).getByLabelText('Value of seats'), 'number')
    const seats = within(app).getByLabelText('Number of seats')
    await user.clear(seats)
    await user.type(seats, '3')
    await addClaim(current, app, 'beta')
    await user.selectOptions(within(app).getByLabelText('Value of beta'), 'boolean')
    await user.selectOptions(within(app).getByLabelText('beta is'), 'true')

    await user.selectOptions(within(card(/^web/)).getByLabelText('JWT template'), 'app')
    expect(within(app).getByText('Used by: web.')).toBeTruthy()
    // The size is said in words, against the cap: an upper bound over every user.
    expect(within(app).getByText(/^Up to \d+ of 1,024 bytes\.$/)).toBeTruthy()

    await save(current)
    await screen.findByText('Settings saved')
    expect(openDialogs()).toBe(0)
    expect(saved(current).jwtTemplates).toEqual({
      app: {
        claims: {
          email: { from: 'user.email' },
          role: { value: 'member' },
          seats: { value: 3 },
          beta: { value: true },
        },
      },
    })
    expect(saved(current).profiles.web?.jwtTemplate).toBe('app')
    expect(saved(current).profiles.mobile?.jwtTemplate).toBeNull()
  })

  test.each([
    ['Admin Panel', /Use lowercase letters/],
    ['', /Use lowercase letters/],
  ])('a template named %p is not added', async (name, problem) => {
    const current = start()
    await screen.findByLabelText('New template name')
    if (name !== '') {
      await current.user.type(screen.getByLabelText('New template name'), name)
    }
    await current.user.click(screen.getByRole('button', { name: 'Add template' }))
    expect(screen.getByText(problem)).toBeTruthy()
    expect(screen.getByText('No unsaved changes.')).toBeTruthy()
  })

  // The contract's rule, not a copy of it: these three pass a looser pattern and are refused
  // by the server, so the operator would only learn of them at the save.
  test.each(['a_b', 'a--b', 'a-'])(
    'a template named %p is refused in the form, before any save',
    async (name) => {
      const current = start()
      await addTemplate(current, name)
      expect(
        screen.getByText(
          'Use lowercase letters, digits and single “-”, starting with a letter (up to 32).'
        )
      ).toBeTruthy()
      expect(screen.getByText('No templates yet.')).toBeTruthy()
      expect(screen.getByText('No unsaved changes.')).toBeTruthy()
      await save(current)
      expect(current.api.calls.filter((call) => call.method === 'PUT')).toHaveLength(0)
    }
  )

  test.each(['a_b', 'a--b', 'a-'])(
    'a profile named %p is refused in the form too',
    async (name) => {
      const current = start()
      await current.user.type(await screen.findByLabelText('New profile name'), name)
      await current.user.click(screen.getByRole('button', { name: 'Add profile' }))
      expect(
        screen.getByText(
          'Use lowercase letters, digits and single “-”, starting with a letter (up to 32).'
        )
      ).toBeTruthy()
      expect(screen.getByText('No unsaved changes.')).toBeTruthy()
    }
  )

  test('a second template of the same name is refused, and Enter adds one', async () => {
    const current = start()
    await current.user.type(await screen.findByLabelText('New template name'), 'app{Enter}')
    expect(card(/^app/)).toBeTruthy()
    await addTemplate(current, 'app')
    expect(screen.getByText('A template with that name exists.')).toBeTruthy()
    expect(screen.getAllByRole('heading', { name: /^app/ })).toHaveLength(1)
  })

  test.each([
    ['sub', /reserved/],
    ['ext', /reserved/],
    ['2fa', /letters, digits and “_”/],
    ['my-claim', /letters, digits and “_”/],
    ['__proto__', /letters, digits and “_”|reserved/],
  ])('a claim named %p is not added', async (key, problem) => {
    const current = start()
    await addTemplate(current, 'app')
    const app = card(/^app/)
    await addClaim(current, app, key)
    expect(within(app).getByText(problem)).toBeTruthy()
    expect(within(app).getByText('No claims yet.')).toBeTruthy()
  })

  test('a claim that exists is not added twice; a claim can be taken out; Enter adds one', async () => {
    const current = start()
    await addTemplate(current, 'app')
    const app = card(/^app/)
    await current.user.type(within(app).getByLabelText('New claim name'), 'role{Enter}')
    await addClaim(current, app, 'role')
    expect(within(app).getByText('A claim with that name exists.')).toBeTruthy()
    expect(within(app).getAllByLabelText('Value of role')).toHaveLength(1)
    await current.user.click(within(app).getByRole('button', { name: 'Take out the role claim' }))
    expect(within(app).getByText('No claims yet.')).toBeTruthy()
  })

  test('a template a profile uses is not taken out until the profile lets go of it', async () => {
    const current = start()
    const { user } = current
    await addTemplate(current, 'app')
    await user.selectOptions(within(card(/^web/)).getByLabelText('JWT template'), 'app')
    await user.click(screen.getByRole('button', { name: 'Take out the app template' }))
    expect(
      screen.getByText('The web profile uses this template. Choose another for it first.')
    ).toBeTruthy()
    expect(card(/^app/)).toBeTruthy()

    await user.selectOptions(within(card(/^web/)).getByLabelText('JWT template'), '')
    await user.click(screen.getByRole('button', { name: 'Take out the app template' }))
    expect(screen.queryByRole('heading', { name: /^app/ }) === null).toBe(true)
    expect(screen.getByText('No templates yet.')).toBeTruthy()
    // Back where it started: nothing to save.
    expect(screen.getByText('No unsaved changes.')).toBeTruthy()
  })

  test('a claim taken from a profile’s sessions asks first, in the operator’s words', async () => {
    const current = start()
    const { user } = current
    const sessions = saved(current)
    sessions.jwtTemplates = { app: { claims: { role: { value: 'member' } } } }
    ;(sessions.profiles.web as { jwtTemplate: string | null }).jwtTemplate = 'app'

    const web = (await screen.findByRole('heading', { name: /^web/ })).closest('li') as HTMLElement
    expect((within(web).getByLabelText('JWT template') as HTMLSelectElement).value).toBe('app')
    expect((screen.getByLabelText('Text of role') as HTMLInputElement).value).toBe('member')
    await user.selectOptions(within(web).getByLabelText('JWT template'), '')
    await save(current)
    const dialog = screen.getByRole('dialog')
    expect(
      within(dialog).getByText(/Sessions of the “web” profile lose custom claims/)
    ).toBeTruthy()
    await user.click(within(dialog).getByRole('button', { name: 'Save anyway' }))
    await screen.findByText('Settings saved')
    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(saved(current).profiles.web?.jwtTemplate).toBeNull()
  })

  test('what the server refuses is said on the claim, the template and the profile', async () => {
    const current = start()
    const { user } = current
    current.api.override('PUT', /^\/v1\/admin\/settings$/, () =>
      failure(422, 'validation.failed', 'Invalid settings.', [
        {
          field: 'sessions.jwtTemplates.app.claims.role',
          code: 'validation.failed',
          message: 'Refused claim.',
        },
        {
          field: 'sessions.jwtTemplates.app.claims',
          code: 'validation.failed',
          message: 'Too many bytes.',
        },
        {
          field: 'sessions.profiles.web.jwtTemplate',
          code: 'validation.failed',
          message: 'No such template.',
        },
        {
          field: 'sessions.jwtTemplates',
          code: 'validation.failed',
          message: 'Too many templates.',
        },
      ])
    )
    await addTemplate(current, 'app')
    const app = card(/^app/)
    await addClaim(current, app, 'role')
    await save(current)
    await screen.findByText('These settings were not saved.')
    // Each where it belongs, beside the summary under the form.
    expect(within(app).getByText('Refused claim.')).toBeTruthy()
    expect(within(app).getByText('Too many bytes.')).toBeTruthy()
    expect(within(card(/^web/)).getByText('No such template.')).toBeTruthy()
    expect(screen.getByText('Too many templates.')).toBeTruthy()
    expect(absent('Settings saved')).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Discard changes' }))
    expect(screen.getByText('No templates yet.')).toBeTruthy()
  })

  test('the caps are said before the server has to: sixteen claims, ten templates', async () => {
    const current = start()
    const sessions = saved(current)
    sessions.jwtTemplates = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [`t${index}`, { claims: {} }])
    )
    sessions.jwtTemplates.t0 = {
      claims: Object.fromEntries(
        Array.from({ length: 16 }, (_, index) => [`c${index}`, { value: index }])
      ),
    }
    await addTemplate(current, 'eleventh')
    expect(screen.getByText('An environment has at most 10 templates.')).toBeTruthy()
    const full = card(/^t0/)
    await addClaim(current, full, 'seventeenth')
    expect(within(full).getByText('A template has at most 16 claims.')).toBeTruthy()
    expect(screen.getByText('No unsaved changes.')).toBeTruthy()
  })

  test('a template over the size cap says so in words', async () => {
    const current = start()
    const sessions = saved(current)
    sessions.jwtTemplates = {
      big: { claims: { a: { from: 'user.email' }, b: { from: 'user.email' } } },
    }
    await screen.findByLabelText('New template name')
    expect(
      within(card(/^big/)).getByText(/of 1,024 bytes: too large\. Take a claim out\.$/)
    ).toBeTruthy()
  })
})
