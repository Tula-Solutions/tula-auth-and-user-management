import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import {
  DEFAULT_ENVIRONMENT_SETTINGS,
  EMAIL_TEMPLATE_KINDS,
  EMAIL_TEMPLATE_RULES,
  type EmailTemplate,
  type EmailTemplateKind,
  type EmailTemplates,
  OAUTH_PROVIDERS,
  readStoredEnvironmentSettings,
  readsAsLink,
} from '@tula/contract'
import * as logger from '~/lib/logger'
import * as Email from '~/modules/email/service'
import {
  displayName,
  type EmailBrand,
  type EmailMessage,
  MAX_RENDERED_SUBJECT_LENGTH,
  render,
  renderTemplate,
  templateKind,
} from '~/modules/email/templates'
import { createTestDeps, TEST_TENANT, type TestDeps } from '~/testing'

const acme: EmailBrand = { name: 'Acme', supportEmail: 'help@acme.test' }
const at = new Date('2026-10-03T14:05:59.000Z')
const link = 'https://app.acme.test/auth/link#tula_link=tok&tula_attempt=att'
const verification: EmailMessage = { type: 'email_verification', code: '482913', ttlMinutes: 10 }
const signIn: EmailMessage = { type: 'sign_in', code: '482913', ttlMinutes: 15, linkUrl: link }
const newSignIn: EmailMessage = {
  type: 'new_sign_in',
  device: 'Chrome on Windows',
  at,
  ipAddress: '203.0.113.7',
}
const passwordChanged: EmailMessage = { type: 'password_changed', by: 'self', added: false, at }

/** One message of every kind there is: each variant of each type `Email.send` accepts. */
const EVERY_MESSAGE: EmailMessage[] = [
  verification,
  { type: 'password_reset', code: '482913', ttlMinutes: 10 },
  signIn,
  { type: 'step_up', code: '482913', ttlMinutes: 10 },
  { type: 'account_exists' },
  { type: 'no_account' },
  { type: 'no_account_sign_in' },
  newSignIn,
  ...(['self', 'reset', 'admin', 'verification'] as const).flatMap((by) =>
    [false, true].map((added): EmailMessage => ({ type: 'password_changed', by, added, at }))
  ),
  ...(
    [
      'enabled',
      'disabled',
      'admin_reset',
      'backup_codes_regenerated',
      'backup_code_used',
      'passkey_added',
      'passkey_removed',
    ] as const
  ).map(
    (change): EmailMessage => ({
      type: 'mfa_changed',
      change,
      at,
      ...(change === 'backup_code_used' && { remaining: 9 }),
    })
  ),
  ...OAUTH_PROVIDERS.flatMap((provider) =>
    (['linked', 'unlinked'] as const).map(
      (change): EmailMessage => ({ type: 'identity_changed', change, provider, at })
    )
  ),
]

function with_(message: EmailMessage, template: EmailTemplate, brand: EmailBrand = acme) {
  return renderTemplate(brand, message, template)
}

describe('templateKind', () => {
  test('every message Email.send accepts has a kind in the contract’s list, and every kind is sent', () => {
    // Fails when a message is added with a kind the contract does not list, and when the
    // contract lists a kind no message has: the two lists are one.
    const kinds = new Set(EVERY_MESSAGE.map(templateKind))
    expect([...kinds].sort()).toEqual([...EMAIL_TEMPLATE_KINDS].sort())
  })

  test('a password notice’s kind says what happened to the password and who did it', () => {
    const kind = (by: 'self' | 'reset' | 'admin' | 'verification', added: boolean) =>
      templateKind({ type: 'password_changed', by, added, at })
    expect([kind('self', false), kind('self', true)]).toEqual([
      'password_changed',
      'password_added',
    ])
    expect([kind('reset', false), kind('reset', true)]).toEqual([
      'password_reset_completed',
      'password_added_by_reset',
    ])
    expect([kind('admin', false), kind('admin', true)]).toEqual([
      'password_set_by_admin',
      'password_added_by_admin',
    ])
    // A removal is one thing, whatever `added` says.
    expect([kind('verification', false), kind('verification', true)]).toEqual([
      'password_removed',
      'password_removed',
    ])
  })
})

function isSecurityNoticeKind(kind: EmailTemplateKind): boolean {
  return !['account_exists', 'no_account', 'no_account_sign_in'].includes(kind)
}

describe('the built-in copy', () => {
  // The rule every template is held to, asked of the server's own wording: what it says
  // besides its facts, its footer and its one link reads as no link either.
  test.each(EVERY_MESSAGE.map((message) => [templateKind(message), message] as const))(
    '%s: the server’s own words hold nothing that reads as a link',
    (_, message) => {
      const email = render({ name: 'Acme', supportEmail: null }, message)
      const words = email.text
        .replaceAll(link, 'the link')
        .split('\n\n')
        // The footer, and the facts: an IP address is a fact of the server's, not wording.
        .filter((paragraph) => !paragraph.startsWith('--\n') && !/^(When|Device): /.test(paragraph))
      expect(words.length).toBeGreaterThan(1)
      for (const paragraph of words) {
        expect([paragraph, readsAsLink(paragraph)]).toEqual([paragraph, false])
      }
      expect([email.subject, readsAsLink(email.subject)]).toEqual([email.subject, false])
    }
  )
})

describe('renderTemplate', () => {
  test.each(EVERY_MESSAGE.map((message) => [templateKind(message), message] as const))(
    '%s with nothing saved is the built-in copy, byte for byte',
    (_, message) => {
      for (const template of [undefined, {}]) {
        expect(renderTemplate(acme, message, template)).toEqual({
          message: render(acme, message),
          unused: [],
        })
      }
    }
  )

  test.each(EVERY_MESSAGE.map((message) => [templateKind(message), message] as const))(
    '%s renders every placeholder its kind lists',
    (kind, message) => {
      const { required, optional } = EMAIL_TEMPLATE_RULES[kind]
      const names = [...required, ...optional]
      const body = names.map((name) => `${name}={{${name}}}`).join('\n\n')
      const { message: email, unused } = with_(message, { body })
      // `sign_in` here has a link; a message with no value for a listed placeholder would
      // have fallen back.
      expect(unused).toEqual([])
      expect(email.text).not.toContain('{{')
      for (const name of names) {
        expect(email.text).toMatch(new RegExp(`${name}=\\S`))
      }
    }
  )

  test('a code message in the operator’s words, in the server’s layout', () => {
    const { message, unused } = with_(verification, {
      subject: 'Your {{appName}} code is {{code}}',
      body: 'Welcome to {{appName}}.\nHere is your code:\n\n{{code}}\n\nIt works for {{expiresInMinutes}} minutes.',
    })
    expect(unused).toEqual([])
    expect(message.subject).toBe('Your Acme code is 482913')
    expect(message.text).toBe(
      [
        'Welcome to Acme.\nHere is your code:',
        '482913',
        'It works for 10 minutes.',
        '--\nAcme\nNeed help? Contact help@acme.test',
      ].join('\n\n')
    )
    const built = render(acme, verification).html.split('\n')
    expect(message.html.split('\n')).toEqual([
      built[0] as string,
      built[1] as string,
      '<p>Welcome to Acme.<br>Here is your code:</p>',
      // The code's own styling, exactly as the built-in copy draws it.
      built.find((line) => line.includes('482913')) as string,
      '<p>It works for 10 minutes.</p>',
      built.at(-2) as string,
      built.at(-1) as string,
    ])
  })

  test('a body of only the required placeholder', () => {
    const { message, unused } = with_(verification, { body: '{{code}}' })
    expect(unused).toEqual([])
    expect(message.subject).toBe(render(acme, verification).subject)
    expect(message.text).toBe('482913\n\n--\nAcme\nNeed help? Contact help@acme.test')
    expect(message.html).toContain('letter-spacing:4px">482913</p>')
  })

  test('a subject alone keeps the built-in body, and a body alone the built-in subject', () => {
    const builtIn = render(acme, verification)
    const subjectOnly = with_(verification, { subject: 'Code for {{appName}}' }).message
    expect(subjectOnly).toEqual({ ...builtIn, subject: 'Code for Acme' })
    const bodyOnly = with_(verification, { body: 'Code: {{code}}' }).message
    expect(bodyOnly.subject).toBe(builtIn.subject)
    expect(bodyOnly.text).toStartWith('Code: 482913\n\n--')
  })

  test('HTML in operator text is escaped in the HTML part and literal in the text part', () => {
    const body = '<script>alert(1)</script> & <a href="evil">click</a> \'q\'\n\n<b>{{code}}</b>'
    const { message, unused } = with_(verification, { subject: '<b>{{code}}</b> & more', body })
    expect(unused).toEqual([])
    expect(message.subject).toBe('<b>482913</b> & more')
    expect(message.text).toContain(
      '<script>alert(1)</script> & <a href="evil">click</a> \'q\'\n\n<b>482913</b>'
    )
    expect(message.html).toContain(
      '<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; &lt;a href=&quot;evil&quot;&gt;click&lt;/a&gt; &#39;q&#39;</p>'
    )
    expect(message.html).toContain('<p>&lt;b&gt;<strong>482913</strong>&lt;/b&gt;</p>')
    expect(message.html).not.toContain('<script')
    expect(message.html).not.toContain('<a ')
  })

  test('an address the operator spells out is never turned into a link', () => {
    const { message, unused } = with_(verification, {
      body: '{{code}}\n\nHelp: acme . test or acme dot test, or call 555 0100',
    })
    expect(unused).toEqual([])
    expect(message.html).toContain('<p>Help: acme . test or acme dot test, or call 555 0100</p>')
    expect(message.html).not.toContain('<a ')
    expect(message.html).not.toContain('href')
  })

  // Every kind, code messages included: such a template is refused at save, and one that
  // reaches a send anyway is not used.
  test.each(['https://acme.test/help', 'www.acme.test', 'acme.test', 'help@acme.test'])(
    'a code message whose body holds %s sends the built-in body',
    (address) => {
      const { message, unused } = with_(verification, { body: `{{code}}\n\nHelp: ${address}` })
      expect(unused).toEqual([{ part: 'body', reason: 'invalid' }])
      expect(message.text).toBe(render(acme, verification).text)
    }
  )

  test('the link becomes the server’s button, and the URL in the text part', () => {
    const { message, unused } = with_(signIn, {
      body: 'Code: {{code}}\n\n{{link}}\n\nOr, in the same browser, use this: {{link}}',
    })
    expect(unused).toEqual([])
    expect(message.text).toContain(
      `Code: 482913\n\n${link}\n\nOr, in the same browser, use this: ${link}`
    )
    const anchor =
      '<a href="https://app.acme.test/auth/link#tula_link=tok&amp;tula_attempt=att">Sign in to Acme</a>'
    expect(message.html).toContain(`<p>${anchor}</p>`)
    expect(message.html).toContain(`<p>Or, in the same browser, use this: ${anchor}</p>`)
    // The button is the built-in copy's own markup.
    expect(render(acme, signIn).html).toContain(`<p>${anchor}</p>`)
  })

  test('a paragraph that names the link is left out of a message that has none', () => {
    const noLink: EmailMessage = { type: 'sign_in', code: '482913', ttlMinutes: 15 }
    const { message, unused } = with_(noLink, {
      body: 'Code: {{code}}\n\nOr open this in the same browser: {{link}}\n\nBye.',
    })
    expect(unused).toEqual([])
    expect(message.text).toStartWith('Code: 482913\n\nBye.\n\n--')
    expect(message.html).not.toContain('same browser')
    expect(message.html).not.toContain('<a ')
  })

  test('a placeholder value that looks like a placeholder is not expanded again', () => {
    const brand: EmailBrand = { name: '{{code}} {{link}} {app}', supportEmail: null }
    const { message, unused } = with_(
      verification,
      { subject: '{{appName}} sent {{code}}', body: 'From {{appName}}: {{code}}' },
      brand
    )
    expect(unused).toEqual([])
    expect(message.subject).toBe('{{code}} {{link}} {app} sent 482913')
    expect(message.text).toStartWith('From {{code}} {{link}} {app}: 482913')
    expect(message.html).toContain('<p>From {{code}} {{link}} {app}: <strong>482913</strong></p>')
  })

  test('replacement patterns in a value are text', () => {
    const brand: EmailBrand = { name: "$& $1 $' <i>", supportEmail: null }
    const { message } = with_(verification, { body: '{{appName}} {{code}}' }, brand)
    expect(message.text).toStartWith("$& $1 $' <i> 482913")
    expect(message.html).toContain('<p>$&amp; $1 $&#39; &lt;i&gt; <strong>482913</strong></p>')
  })

  test.each([
    ['a line feed', 'Hello\nBcc: eve@evil.test'],
    ['CRLF', 'Hello\r\nBcc: eve@evil.test'],
    ['a line separator', 'Hello\u{2028}Bcc: eve@evil.test'],
    ['a NUL', 'Hello\u{0}Bcc'],
  ])('a stored subject with %s cannot add a header: it is not used', (_, subject) => {
    // The settings API refuses it; this is a template that reached storage some other way.
    const { message, unused } = with_(verification, { subject })
    expect(unused).toEqual([{ part: 'subject', reason: 'invalid' }])
    expect(message.subject).toBe(render(acme, verification).subject)
  })

  test('a line break that arrives through a value is cleaned out of the subject', () => {
    // `displayName` already cleans the app name; a device family is the server's own text.
    // This is the second line of defence, with a value that should never hold one.
    const { message, unused } = with_(
      { ...newSignIn, device: 'Chrome\r\nBcc: eve@evil.test\u{2028}x' } as EmailMessage,
      { subject: 'New sign-in from {{device}}' }
    )
    expect(unused).toEqual([])
    expect(message.subject).toBe('New sign-in from Chrome Bcc: eve@evil.test x')
    expect(message.subject).not.toMatch(/[\r\n\u{2028}]/u)
  })

  describe('a security notice', () => {
    const template: EmailTemplate = {
      subject: 'Heads up: {{appName}} password changed',
      body: 'Your {{appName}} password was changed at {{time}}.\n\nIf that was not you, reset it.',
    }

    test('is worded by the operator and keeps the server’s facts and last line', () => {
      const { message, unused } = with_(passwordChanged, template)
      expect(unused).toEqual([])
      expect(message.subject).toBe('Heads up: Acme password changed')
      expect(message.text).toBe(
        [
          'Your Acme password was changed at 2026-10-03 14:05 UTC.',
          'If that was not you, reset it.',
          'When: 2026-10-03 14:05 UTC',
          "If it wasn't you, or you did not expect it, open Acme and reset your password from the sign-in screen right away.",
          'If you cannot get back in to your account, contact help@acme.test.',
          '--\nAcme\nNeed help? Contact help@acme.test',
        ].join('\n\n')
      )
      expect(message.html).not.toContain('<a ')
      expect(message.html).not.toContain('href')
    })

    // The sentence that says what to do when the reader did not do this is the server's,
    // like the facts: whatever the body says, it follows the facts and precedes the
    // support line and the footer, in both parts.
    test.each(
      EVERY_MESSAGE.filter(
        (message) => EMAIL_TEMPLATE_RULES[templateKind(message)].category === 'notice'
      ).map((message) => [templateKind(message), message] as const)
    )('%s with a body of its own still ends with the server’s own sentence', (_, message) => {
      const builtIn = render(acme, message)
      const paragraphs = (text: string) => text.split('\n\n')
      const supported =
        templateKind(message).startsWith('no_account') || templateKind(message) === 'account_exists'
          ? 2
          : 3
      const sentence = paragraphs(builtIn.text).at(-supported) as string
      expect(sentence).toMatch(/^If (it wasn't you|you did not just sign in)/)

      const { message: email, unused } = with_(message, {
        body: 'Nothing happened.\n\nThere is nothing you need to do, whatever follows.',
      })
      expect(unused).toEqual([])
      const written = paragraphs(email.text)
      expect(written.slice(0, 2)).toEqual([
        'Nothing happened.',
        'There is nothing you need to do, whatever follows.',
      ])
      // Last before the support line (a notice's) and the footer.
      expect(written.at(-supported)).toBe(sentence)
      expect(written.filter((paragraph) => paragraph === sentence)).toHaveLength(1)
      const html = email.html
      const inHtml = `<p>${sentence.replaceAll("'", '&#39;')}</p>`
      expect(html).toContain(inHtml)
      expect(html.indexOf(inHtml)).toBeGreaterThan(html.indexOf('whatever follows.'))
      expect(html.split(inHtml)).toHaveLength(2)
    })

    // The HTML part in full order: the operator's paragraphs, the facts, the server's
    // sentence, the support line, the footer.
    test.each(
      EVERY_MESSAGE.filter(
        (message) => EMAIL_TEMPLATE_RULES[templateKind(message)].category === 'notice'
      ).map((message) => [templateKind(message), message] as const)
    )(
      '%s keeps the order of its HTML part: body, facts, the server’s sentence, support, footer',
      (_, message) => {
        const builtIn = render(acme, message)
        const { message: email } = with_(message, { body: 'First of mine.\n\nLast of mine.' })
        const paragraphsOf = (html: string) => html.match(/<p[ >].*?<\/p>/gs) ?? []
        const theirs = paragraphsOf(builtIn.html)
        const ours = paragraphsOf(email.html)
        const decoy = !isSecurityNoticeKind(templateKind(message))
        // What the built-in copy ends with, after its own wording: for a security notice the
        // sentence, the support line and the footer; for the other three the sentence and
        // the footer.
        const tail = theirs.slice(decoy ? -2 : -3)
        const facts = theirs.filter((paragraph) => /^<p>(When|Device): /.test(paragraph))
        expect(facts).toHaveLength(decoy ? 0 : 1)
        expect(ours).toEqual(['<p>First of mine.</p>', '<p>Last of mine.</p>', ...facts, ...tail])
        expect(tail.at(-1)).toContain('Need help? Contact help@acme.test')
      }
    )

    test('the sentence of an “account exists” message is the server’s too', () => {
      const { message } = with_({ type: 'account_exists' }, { body: 'Hello from {{appName}}.' })
      expect(message.text).toBe(
        [
          'Hello from Acme.',
          "If it wasn't you, you can safely ignore this email. Your account has not changed.",
          '--\nAcme\nNeed help? Contact help@acme.test',
        ].join('\n\n')
      )
    })

    test('a code message has no sentence of the server’s: its closing is the operator’s', () => {
      const { message } = with_(verification, { body: 'Code: {{code}}' })
      expect(message.text).toBe('Code: 482913\n\n--\nAcme\nNeed help? Contact help@acme.test')
    })

    test('a new sign-in still says which device, when and from where', () => {
      const { message } = with_(newSignIn, { body: 'Someone signed in to {{appName}}.' })
      expect(message.text).toContain(
        'Someone signed in to Acme.\n\nDevice: Chrome on Windows\nWhen: 2026-10-03 14:05 UTC\nIP address: 203.0.113.7'
      )
      expect(message.html).toContain(
        '<p>Device: Chrome on Windows<br>When: 2026-10-03 14:05 UTC<br>IP address: 203.0.113.7</p>'
      )
    })

    test('a used backup code still says how many are left', () => {
      const used: EmailMessage = {
        type: 'mfa_changed',
        change: 'backup_code_used',
        at,
        remaining: 9,
      }
      const { message, unused } = with_(used, { body: '{{backupCodesLeft}} left.' })
      expect(unused).toEqual([])
      expect(message.text).toStartWith(
        '9 left.\n\nWhen: 2026-10-03 14:05 UTC\nBackup codes left: 9'
      )
    })

    test.each(
      EVERY_MESSAGE.filter(
        (message) => EMAIL_TEMPLATE_RULES[templateKind(message)].category === 'notice'
      ).map((message) => [templateKind(message), message] as const)
    )('%s given a code, a link or a token placeholder is not used at all', (_, message) => {
      for (const name of ['code', 'link', 'token']) {
        const { message: email, unused } = with_(message, {
          subject: `Act now {{${name}}}`,
          body: `Click {{${name}}}`,
        })
        expect(unused).toEqual([
          { part: 'subject', reason: 'invalid' },
          { part: 'body', reason: 'invalid' },
        ])
        expect(email).toEqual(render(acme, message))
      }
    })

    test('a stored template with something that reads as a link is not used', () => {
      const { message, unused } = with_(passwordChanged, {
        subject: 'Verify at evil.test',
        body: 'Go to https://evil.test/login now.',
      })
      expect(unused).toEqual([
        { part: 'subject', reason: 'invalid' },
        { part: 'body', reason: 'invalid' },
      ])
      expect(message).toEqual(render(acme, passwordChanged))
    })

    test('a subject that would start with a digit once rendered falls back to the built-in one', () => {
      const digits: EmailBrand = { name: '365 Days', supportEmail: null }
      const subject = '{{appName}}: your password changed'
      const rendered = with_(passwordChanged, { subject, body: 'Changed.' }, digits)
      expect(rendered.unused).toEqual([{ part: 'subject', reason: 'leading_digit' }])
      // The built-in subject never leads with the name; the operator's body is still used.
      expect(rendered.message.subject).toBe('Your 365 Days password was changed')
      expect(rendered.message.subject).not.toMatch(/^\d/)
      expect(rendered.message.text).toStartWith('Changed.')
      // The same template with a name that starts with a letter is used.
      expect(with_(passwordChanged, { subject }).message.subject).toBe(
        'Acme: your password changed'
      )
    })

    test('a stand-in notice is held to the same subject rule', () => {
      const digits: EmailBrand = { name: '1Password', supportEmail: null }
      const rendered = with_({ type: 'no_account' }, { subject: '{{appName}} reset' }, digits)
      expect(rendered.unused).toEqual([{ part: 'subject', reason: 'leading_digit' }])
      expect(rendered.message.subject).toBe(render(digits, { type: 'no_account' }).subject)
    })

    test('a code message’s subject may lead with digits', () => {
      const digits: EmailBrand = { name: '365 Days', supportEmail: null }
      const rendered = with_(verification, { subject: '{{appName}} code {{code}}' }, digits)
      expect(rendered.unused).toEqual([])
      expect(rendered.message.subject).toBe('365 Days code 482913')
    })
  })

  test('an invisible character from the app’s name does not hide a leading digit', () => {
    const { message, unused } = with_(
      passwordChanged,
      { subject: '{{appName}} password changed' },
      { name: '\u{200D}1Password', supportEmail: null }
    )
    expect(unused).toEqual([{ part: 'subject', reason: 'leading_digit' }])
    expect(message.subject).toBe(
      render({ name: '\u{200D}1Password', supportEmail: null }, passwordChanged).subject
    )
  })

  test('a subject that renders to nothing a reader can see is not used', () => {
    const { message, unused } = with_(
      verification,
      { subject: '{{appName}}' },
      { name: '\u{200D}\u{2060}', supportEmail: null }
    )
    expect(unused).toEqual([{ part: 'subject', reason: 'empty' }])
    expect(message.subject).toStartWith('482913 ')
  })

  describe('falls back whole, never half-rendered', () => {
    test('a stored body that no longer passes sends the built-in body; a good subject is kept', () => {
      const { message, unused } = with_(verification, {
        subject: 'Hello from {{appName}}',
        body: 'Hi {{firstName}}, your code is {{code}}',
      })
      expect(unused).toEqual([{ part: 'body', reason: 'invalid' }])
      expect(message).toEqual({ ...render(acme, verification), subject: 'Hello from Acme' })
      expect(message.text).not.toContain('{{')
    })

    test('a body without the code is not used', () => {
      const { message, unused } = with_(verification, { body: 'No code for you.' })
      expect(unused).toEqual([{ part: 'body', reason: 'invalid' }])
      expect(message.text).toContain('482913')
    })

    test('a placeholder the message has no value for sends the built-in body', () => {
      // `backup_code_used` without a count: the kind lists the placeholder, this message
      // cannot fill it.
      const used: EmailMessage = { type: 'mfa_changed', change: 'backup_code_used', at }
      const { message, unused } = with_(used, {
        subject: 'Left: {{backupCodesLeft}}',
        body: 'You have {{backupCodesLeft}} codes left.',
      })
      // Each part falls back by itself, for the value it could not fill.
      expect(unused).toEqual([
        { part: 'subject', reason: 'missing_value' },
        { part: 'body', reason: 'missing_value' },
      ])
      expect(message).toEqual(render(acme, used))
    })

    test('a subject that renders too long is not cut: the built-in one is sent', () => {
      const long: EmailBrand = { name: 'N'.repeat(64), supportEmail: null }
      const subject = Array.from({ length: 5 }, () => '{{appName}}').join(' ')
      const rendered = with_(verification, { subject }, long)
      expect(64 * 5).toBeGreaterThan(MAX_RENDERED_SUBJECT_LENGTH)
      expect(rendered.unused).toEqual([{ part: 'subject', reason: 'too_long' }])
      expect(rendered.message.subject).toBe(render(long, verification).subject)
    })
  })
})

describe('send', () => {
  const tenant = { environmentId: TEST_TENANT.environmentId }
  const other = { environmentId: TEST_TENANT.productionEnvironmentId }
  let deps: TestDeps
  let warn: ReturnType<typeof spyOn<typeof logger, 'warn'>>

  function save(environmentId: string, templates: EmailTemplates, name = 'Acme') {
    deps.environmentSettings.seed(environmentId, {
      revision: 1,
      settings: {
        ...DEFAULT_ENVIRONMENT_SETTINGS,
        app: { name, supportEmail: null },
        emails: { templates },
      },
    })
  }

  beforeEach(() => {
    deps = createTestDeps()
    warn = spyOn(logger, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    warn.mockRestore()
  })

  test('uses the environment’s template for the message’s kind', async () => {
    save(tenant.environmentId, {
      email_verification: { subject: 'Welcome: {{code}}', body: 'Your {{appName}} code: {{code}}' },
    })
    await Email.send(deps, tenant, 'maya@northline.app', verification)
    expect(deps.mailer.last().subject).toBe('Welcome: 482913')
    expect(deps.mailer.last().text).toStartWith('Your Acme code: 482913')
    // Another kind of the same environment is untouched.
    await Email.send(deps, tenant, 'maya@northline.app', { type: 'account_exists' })
    expect(deps.mailer.last()).toMatchObject(
      render({ name: 'Acme', supportEmail: null }, { type: 'account_exists' })
    )
    expect(warn).not.toHaveBeenCalled()
  })

  test('another environment’s template is never used', async () => {
    save(tenant.environmentId, { email_verification: { body: 'Dev wording {{code}}' } }, 'Dev')
    save(other.environmentId, {}, 'Prod')
    await Email.send(deps, other, 'maya@northline.app', verification)
    expect(deps.mailer.last()).toMatchObject(
      render({ name: 'Prod', supportEmail: null }, verification)
    )
    expect(deps.mailer.last().text).not.toContain('Dev wording')
    await Email.send(deps, tenant, 'maya@northline.app', verification)
    expect(deps.mailer.last().text).toStartWith('Dev wording 482913')
  })

  // The path a real server takes: the store reads a stored document through the tolerant
  // read, and `send` works with what that left. Each part alone, in both directions.
  test.each<[string, EmailTemplate, 'subject' | 'body']>([
    ['a body that no longer passes', { subject: 'Kept {{code}}', body: 'no code here' }, 'subject'],
    [
      'a subject that no longer passes',
      { subject: 'Hi {{firstName}}', body: 'Kept {{code}}' },
      'body',
    ],
  ])(
    'through the store’s tolerant read, %s leaves the other part in use',
    async (_, template, kept) => {
      const stored = readStoredEnvironmentSettings({
        app: { name: 'Acme' },
        emails: { templates: { step_up: template } },
      })
      expect(stored.droppedEmailTemplates).toEqual(['step_up'])
      expect(stored.settings.emails.templates).toEqual({ step_up: { [kept]: template[kept] } })
      deps.environmentSettings.seed(tenant.environmentId, {
        revision: 1,
        settings: stored.settings,
      })
      const stepUp: EmailMessage = { type: 'step_up', code: '482913', ttlMinutes: 10 }
      await Email.send(deps, tenant, 'maya@northline.app', stepUp)
      const sent = deps.mailer.last()
      const builtIn = render({ name: 'Acme', supportEmail: null }, stepUp)
      if (kept === 'subject') {
        expect(sent.subject).toBe('Kept 482913')
        expect(sent.text).toBe(builtIn.text)
      } else {
        expect(sent.subject).toBe(builtIn.subject)
        expect(sent.text).toStartWith('Kept 482913')
      }
      // The store said what it left out; `send` had nothing left to refuse.
      expect(warn).not.toHaveBeenCalled()
    }
  )

  test('a template that reaches a send unjudged sends the built-in copy and is logged by environment and kind', async () => {
    const canary = 'canary-wording-91d2'
    save(tenant.environmentId, {
      step_up: { subject: `${canary} {{code}}`, body: `${canary}: no code here` },
    })
    const stepUp: EmailMessage = { type: 'step_up', code: '482913', ttlMinutes: 10 }
    await Email.send(deps, tenant, 'maya@northline.app', stepUp)
    const sent = deps.mailer.last()
    // The subject passes and is used; the body lacks the code and is not.
    expect(sent.subject).toBe(`${canary} 482913`)
    expect(sent.text).toBe(render({ name: 'Acme', supportEmail: null }, stepUp).text)
    expect(warn.mock.calls).toEqual([
      [
        'email template not used: the built-in copy was sent for that part',
        { environmentId: tenant.environmentId, kind: 'step_up', part: 'body', reason: 'invalid' },
      ],
    ])
    expect(JSON.stringify(warn.mock.calls)).not.toContain(canary)
  })

  test('a stored template with a text-direction control is not used, and the log has none of it', async () => {
    save(tenant.environmentId, {
      email_verification: { subject: 'Code \u{202E}{{code}}', body: 'Your code\u{2066}: {{code}}' },
    })
    await Email.send(deps, tenant, 'maya@northline.app', verification)
    expect(deps.mailer.last()).toMatchObject(
      render({ name: 'Acme', supportEmail: null }, verification)
    )
    expect(warn.mock.calls.map(([, fields]) => fields)).toEqual([
      {
        environmentId: tenant.environmentId,
        kind: 'email_verification',
        part: 'subject',
        reason: 'invalid',
      },
      {
        environmentId: tenant.environmentId,
        kind: 'email_verification',
        part: 'body',
        reason: 'invalid',
      },
    ])
  })

  test('a zero-width joiner and non-joiner are delivered as written', async () => {
    const body = 'می\u{200C}خواهم 👩\u{200D}💻 \u{2764}\u{FE0F} {{code}}'
    save(tenant.environmentId, {
      email_verification: { subject: 'نمی\u{200C}دانم {{code}}', body },
    })
    await Email.send(deps, tenant, 'maya@northline.app', verification)
    expect(deps.mailer.last().subject).toBe('نمی\u{200C}دانم 482913')
    expect(deps.mailer.last().text).toStartWith(
      'می\u{200C}خواهم 👩\u{200D}💻 \u{2764}\u{FE0F} 482913'
    )
    expect(deps.mailer.last().html).toContain('می\u{200C}خواهم 👩\u{200D}💻 \u{2764}\u{FE0F} ')
    expect(warn).not.toHaveBeenCalled()
  })

  test('a template under an inherited name is not a template', async () => {
    save(tenant.environmentId, {})
    const stored = await deps.environmentSettings.get(tenant.environmentId)
    expect(Object.hasOwn(stored?.settings.emails.templates ?? {}, 'toString')).toBe(false)
    await Email.send(deps, tenant, 'maya@northline.app', verification)
    expect(deps.mailer.last().subject).toBe('482913 is your Acme verification code')
  })
})

// Review round 2: a name stored before the input rule is cleaned when it is put in.
describe('an app name stored with a hidden character', () => {
  const stored: EmailBrand = { name: 'Acme\u{202E}moc', supportEmail: null }
  const hidden = /[\u{202A}-\u{202E}\u{2066}-\u{2069}\u{200E}\u{200F}\u{061C}]/u

  test.each<[string, string]>([
    ['a right-to-left override', 'Acme\u{202E}moc'],
    ['an isolate and its pop', '\u{2066}Acme\u{2069}moc'],
    ['a direction mark', 'Acme\u{200F}moc'],
    ['a private-use character', 'Acme\u{E000}moc'],
    ['an unassigned code point', 'Acme\u{0378}moc'],
    ['a lone surrogate', 'Acme\u{D83D}moc'],
  ])('displayName takes out %s', (_, name) => {
    expect(displayName(name)).toBe('Acmemoc')
  })

  test('joiners and variation selectors stay in a name', () => {
    expect(displayName('می\u{200C}خواهم \u{2764}\u{FE0F}')).toBe('می\u{200C}خواهم \u{2764}\u{FE0F}')
  })

  test('the built-in copy and a template both render it without the control', () => {
    const builtIn = render(stored, verification)
    const own = with_(
      verification,
      { subject: '{{code}} for {{appName}}', body: '{{appName}}: {{code}}' },
      stored
    ).message
    for (const message of [builtIn, own]) {
      expect(hidden.test(message.subject)).toBe(false)
      expect(hidden.test(message.text)).toBe(false)
      expect(hidden.test(message.html)).toBe(false)
      expect(message.subject).toContain('Acmemoc')
    }
  })

  test('a name of only hidden characters is the default name', () => {
    expect(displayName('\u{202E}\u{2066}')).toBe('Tula')
  })

  test('a digit behind a hidden or an invisible character still makes a notice fall back', () => {
    for (const name of ['\u{200D}1Password', '\u{202E}1Password', '\u{202E}\u{200D}1Password']) {
      const { unused } = with_(
        passwordChanged,
        { subject: '{{appName}} password changed' },
        { name, supportEmail: null }
      )
      expect(unused).toEqual([{ part: 'subject', reason: 'leading_digit' }])
    }
  })
})
