import { afterEach, describe, expect, test } from 'bun:test'
import { screen, waitFor, within } from '@testing-library/react'
import { EMAIL_TEMPLATE_KINDS, SMS_TEMPLATE_KINDS } from '@tula/contract'
import { failure } from '~/testing/fake-api'
import { DEV_PATH, expectFocus, renderApp, type World } from '~/testing/harness'

// The messages screen (ADR 0039, ADR 0042): every kind of email and text message, the
// environment's own wording of each as part of the one settings draft, and a preview the
// server renders. The fake API validates wording with the contract's own functions and
// fills a draft with sample values; the real copy is shown by the browser tests.

const PREVIEW = '/v1/admin/message-preview'

let world: World | undefined

function start(): World {
  world = renderApp(`${DEV_PATH}/messages`)
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

function field(label: 'Subject' | 'Body' | 'Text'): HTMLInputElement {
  return screen.getByLabelText(label) as HTMLInputElement
}

/** Put text into a field as a paste: braces are then text, not user-event's key syntax. */
async function write(current: World, label: 'Subject' | 'Body' | 'Text', text: string) {
  await current.user.click(await screen.findByLabelText(label))
  await current.user.paste(text)
}

async function choose(current: World, name: RegExp) {
  const list = await screen.findByRole('navigation', { name: 'Messages' })
  await current.user.click(within(list).getByRole('button', { name }))
}

/** The preview as drawn: its subject (if any) and its text. */
function previewed(): { subject: string | null; text: string | null } {
  return {
    subject: document.querySelector('[data-preview="subject"]')?.textContent ?? null,
    text: document.querySelector('[data-preview="text"]')?.textContent ?? null,
  }
}

function saved(current: World) {
  return current.api.state.settings.settings as unknown as {
    emails: { templates: Record<string, { subject?: string; body?: string }> }
    sms: { templates: Record<string, { text: string }> }
  }
}

describe('the messages screen', () => {
  test('every kind of the contract is listed, and the first is previewed in the built-in wording', async () => {
    const current = start()
    const list = await screen.findByRole('navigation', { name: 'Messages' })
    const kinds = within(list).getAllByRole('button')
    expect(kinds.length).toBe(EMAIL_TEMPLATE_KINDS.length + SMS_TEMPLATE_KINDS.length)
    expect(kinds.every((kind) => kind.textContent?.endsWith('Built-in'))).toBe(true)
    expect(kinds.filter((kind) => kind.getAttribute('aria-current') === 'true').length).toBe(1)

    await screen.findByText('This message is sent in the built-in wording.')
    await waitFor(() => expect(previewed().text).toBe('Built-in body of email_verification.'))
    expect(previewed().subject).toBe('Built-in subject of email_verification')
    // The request named the kind and no template, for this environment.
    const call = current.api.callsTo('POST', PREVIEW).at(-1)
    expect(call?.body).toEqual({ channel: 'email', kind: 'email_verification' })
    expect(call?.headers.get('x-tula-environment')).toBeString()
    await screen.findByText('No unsaved changes.')
  })

  test('an email is worded with placeholders put in from the keyboard, previewed and saved', async () => {
    const current = start()
    const { user } = current
    await write(current, 'Subject', 'Welcome to ')
    await user.click(screen.getByRole('button', { name: 'Insert {{appName}} into the subject' }))
    expect(field('Subject').value).toBe('Welcome to {{appName}}')
    // The caret is back in the field, after what was put in.
    await expectFocus(field('Subject'))
    expect(field('Subject').selectionStart).toBe('Welcome to {{appName}}'.length)

    await write(current, 'Body', 'Your code: ')
    const insertCode = screen.getByRole('button', {
      name: 'Insert {{code}} into the body (required)',
    })
    insertCode.focus()
    await user.keyboard('{Enter}')
    expect(field('Body').value).toBe('Your code: {{code}}')

    await waitFor(() =>
      expect(previewed()).toEqual({ subject: 'Welcome to Tula', text: 'Your code: 123456' })
    )
    await screen.findByText('The preview shows the wording above.')
    await screen.findByText('This environment has its own wording for this message.')

    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('Settings saved')
    expect(saved(current).emails.templates).toEqual({
      email_verification: { subject: 'Welcome to {{appName}}', body: 'Your code: {{code}}' },
    })
    expect(current.api.callsTo('PUT', '/v1/admin/settings').at(-1)?.headers.get('if-match')).toBe(
      '"3"'
    )
    const list = screen.getByRole('navigation', { name: 'Messages' })
    expect(
      within(list).getByRole('button', { name: /^Email verification code/ }).textContent
    ).toEndWith('Own wording')
    await screen.findByText('No unsaved changes.')
  })

  test('a placeholder goes in where the caret is, in place of what is selected', async () => {
    const current = start()
    await write(current, 'Subject', 'Hello XX now')
    field('Subject').setSelectionRange(6, 8)
    await current.user.click(
      screen.getByRole('button', { name: 'Insert {{appName}} into the subject' })
    )
    expect(field('Subject').value).toBe('Hello {{appName}} now')
  })

  test('a subject offers no link, and a notice neither a code nor a link', async () => {
    const current = start()
    await choose(current, /^Sign-in code and link/)
    const subject = await screen.findByRole('group', { name: 'Placeholders for the subject' })
    const body = screen.getByRole('group', { name: 'Placeholders for the body' })
    const names = (group: HTMLElement) =>
      within(group)
        .getAllByRole('button')
        .map((button) => button.querySelector('code')?.textContent)
    expect(names(subject)).toEqual(['{{code}}', '{{appName}}', '{{expiresInMinutes}}'])
    expect(names(body)).toEqual(['{{code}}', '{{link}}', '{{appName}}', '{{expiresInMinutes}}'])

    await choose(current, /^Password changed/)
    await screen.findByText('The user changed their password.')
    expect(names(screen.getByRole('group', { name: 'Placeholders for the body' }))).toEqual([
      '{{appName}}',
      '{{time}}',
    ])
  })

  test('wording that would be refused says why at once, is not previewed, and a save names the field', async () => {
    const current = start()
    const { user } = current
    await choose(current, /^Phone number code/)
    await screen.findByText('A signed-in user proves a phone number with a texted code.')
    await waitFor(() => expect(previewed().text).toStartWith('Built-in text of Tula: 123456.'))
    const asked = current.api.callsTo('POST', PREVIEW).length

    await write(current, 'Text', 'Welcome to the app.')
    await screen.findByText('Would be refused: the text must contain {{code}}.')
    expect(field('Text').getAttribute('aria-invalid')).toBe('true')
    await screen.findByText(/^No preview: this wording would be refused when saved\./)
    // Nothing is asked of the server for a draft the contract's own rules refuse.
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(current.api.callsTo('POST', PREVIEW).length).toBe(asked)

    // The save is still the server's to refuse, and its answer is shown by field.
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('These settings were not saved.')
    await screen.findByText('sms.templates.phone_verification.text')
    expect(saved(current).sms.templates).toEqual({})
    const list = screen.getByRole('navigation', { name: 'Messages' })
    expect(within(list).getByRole('button', { name: /^Phone number code/ }).textContent).toEndWith(
      'Refused'
    )
    await screen.findByText('You have unsaved changes.')
  })

  test.each([
    ['a second code line', 'Code {{code}} @evil #x', /must not/],
    ['a link', 'Code {{code}}. See https://example.com/x', /must not contain a link/],
    ['digits of its own', 'Code {{code}} or 4821', /four or more digits/],
  ])('a text message with %s is refused in the editor', async (_name, text, reason) => {
    const current = start()
    await choose(current, /^Texted sign-in code/)
    await write(current, 'Text', text)
    const alert = await screen.findByText(/^Would be refused:/)
    expect(reason.test(alert.textContent ?? '')).toBe(true)
  })

  test('a text message is previewed with the server’s last line and its size, and reset to built-in', async () => {
    const current = start()
    const { user } = current
    await choose(current, /^Texted sign-in code/)
    await write(current, 'Text', 'Use ')
    await user.click(
      screen.getByRole('button', { name: 'Insert {{code}} into the text (required)' })
    )
    await waitFor(() => expect(previewed().text).toBe('Use 123456\n\n@app.example #123456'))
    expect(previewed().subject).toBeNull()
    await screen.findByText('Sent as 1 text message: 32 characters of the GSM alphabet.')
    await screen.findByText('You have unsaved changes.')
    expect(current.api.callsTo('POST', PREVIEW).at(-1)?.body).toEqual({
      channel: 'sms',
      kind: 'sign_in',
      template: { text: 'Use {{code}}' },
    })

    await user.click(screen.getByRole('button', { name: 'Reset to built-in' }))
    expect(field('Text').value).toBe('')
    await screen.findByText('This message is sent in the built-in wording.')
    // The document is what it was: there is nothing to save.
    await screen.findByText('No unsaved changes.')
    await waitFor(() => expect(previewed().text).toStartWith('Built-in text of Tula'))
  })

  test('clearing one part of an email keeps the other, and clearing both is the built-in wording', async () => {
    const current = start()
    const { user } = current
    current.api.state.settings.settings.emails = {
      templates: { email_verification: { subject: 'Own subject', body: 'Own {{code}}' } },
    } as never
    await waitFor(() => expect(field('Subject').value).toBe('Own subject'))
    await user.clear(field('Subject'))
    await waitFor(() =>
      expect(previewed()).toEqual({
        subject: 'Built-in subject of email_verification',
        text: 'Own 123456',
      })
    )
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('Settings saved')
    expect(saved(current).emails.templates).toEqual({
      email_verification: { body: 'Own {{code}}' },
    })

    await user.clear(field('Body'))
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(saved(current).emails.templates).toEqual({}))
  })

  test('what an operator typed is drawn as text, never as markup', async () => {
    const current = start()
    const hostile = '<img src=x onerror=alert(1)><script>alert(2)</script> <b>bold</b> {{code}}'
    await write(current, 'Body', hostile)
    await write(current, 'Subject', '<i>Hi</i>')
    await waitFor(() =>
      expect(previewed()).toEqual({
        subject: '<i>Hi</i>',
        text: '<img src=x onerror=alert(1)><script>alert(2)</script> <b>bold</b> 123456',
      })
    )
    const main = document.querySelector('main') ?? document.body
    expect(main.querySelectorAll('img, script, b, i, iframe').length).toBe(0)
    expect(document.querySelector('[data-preview="text"]')?.children.length).toBe(0)
    expect(document.querySelector('[data-preview="subject"]')?.children.length).toBe(0)
  })

  test('characters that cannot be seen are named under the field and under the preview', async () => {
    const current = start()
    await write(current, 'Body', 'Your\u{200D} code {{code}}')
    await waitFor(() => expect(previewed().text).toBe('Your\u{200D} code 123456'))
    const notes = await screen.findAllByText(/Holds characters that cannot be seen \(U\+200D\)/)
    expect(notes.length).toBe(2)
  })

  test('a part the server would replace is said in words', async () => {
    const current = start()
    current.api.override('POST', /^\/v1\/admin\/message-preview$/, (call) => {
      const { kind } = call.body as { kind: string }
      return {
        channel: 'sms',
        kind,
        subject: null,
        text: 'Your 908172 verification code is 123456.',
        unused: [{ part: 'text', reason: 'code_not_last' }],
        segments: { encoding: 'ucs2', units: 40, segments: 2 },
      }
    })
    await choose(current, /^Texted sign-in code/)
    await screen.findByText(
      'The text would not end with the code as the last six digits of the message (the app name holds six digits of its own), so the built-in text is sent instead.'
    )
    await screen.findByText(
      'Sent as 2 text messages: 40 characters as Unicode, which fits fewer in a message.'
    )
  })

  test('a preview that fails says so, and the next draft is asked for again', async () => {
    const current = start()
    let refuse = true
    current.api.override('POST', /^\/v1\/admin\/message-preview$/, (call) => {
      if (refuse) {
        return failure(429, 'rate_limited', 'Too many requests.')
      }
      const { kind } = call.body as { kind: string }
      return { channel: 'email', kind, subject: 'S', text: 'Later', unused: [], segments: null }
    })
    await screen.findByText('The preview could not be made.')
    refuse = false
    await write(current, 'Subject', 'Again')
    await waitFor(() => expect(previewed().text).toBe('Later'))
    expect(absent('The preview could not be made.')).toBe(true)
  })

  test('a draft the server’s preview refuses is shown by field', async () => {
    const current = start()
    current.api.override('POST', /^\/v1\/admin\/message-preview$/, () =>
      failure(422, 'validation.failed', 'Invalid wording.', [
        { field: 'template.subject', code: 'validation.failed', message: 'must not be that' },
      ])
    )
    await screen.findByText('The preview could not be made.')
    await screen.findByText('template.subject')
    await screen.findByText(/must not be that/)
  })

  test('settings saved elsewhere meanwhile are not overwritten', async () => {
    const current = start()
    const { user } = current
    await write(current, 'Subject', 'Mine')
    current.api.state.settings.revision += 1
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('Changed elsewhere.')
    expect(saved(current).emails.templates).toEqual({})
    await user.click(screen.getByRole('button', { name: 'Reload settings' }))
    await waitFor(() => expect(field('Subject').value).toBe(''))
    await screen.findByText('No unsaved changes.')
  })

  test('wording in settings a config file manages asks before it is saved', async () => {
    const current = start()
    const { user } = current
    current.api.state.settings.managedBy = {
      tool: 'tula-apply',
      configHash: `sha256:${'0'.repeat(64)}`,
      at: '2026-10-04T12:00:00.000Z',
      revision: 3,
      drifted: false,
    }
    await write(current, 'Subject', 'Mine')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByText('Change settings managed by a config file?')
    expect(saved(current).emails.templates).toEqual({})
    await user.click(within(dialog).getByRole('button', { name: 'Save anyway' }))
    await screen.findByText('Settings saved')
    expect(saved(current).emails.templates).toEqual({ email_verification: { subject: 'Mine' } })
  })

  test('the screen is reached from the navigation', async () => {
    world = renderApp(`${DEV_PATH}/users`)
    await world.user.click(await screen.findByRole('link', { name: 'Messages' }))
    await screen.findByRole('heading', { level: 1, name: 'Messages' })
    expect(world.location()).toBe(`${DEV_PATH}/messages`)
  })
})
