import { describe, expect, test } from 'bun:test'
import {
  displayName,
  type EmailBrand,
  type EmailMessage,
  escapeHtml,
  render,
} from '~/modules/email/templates'

const acme: EmailBrand = { name: 'Acme', supportEmail: 'help@acme.test' }
const code: EmailMessage = { type: 'email_verification', code: '482913', ttlMinutes: 10 }

const at = new Date('2026-10-03T14:05:59.000Z')
const signIn: EmailMessage = {
  type: 'new_sign_in',
  device: 'Chrome on Windows',
  at,
  ipAddress: '203.0.113.7',
}

const MESSAGES: EmailMessage[] = [
  code,
  { type: 'password_reset', code: '482913', ttlMinutes: 10 },
  { type: 'account_exists' },
  { type: 'no_account' },
  signIn,
  { type: 'password_changed', by: 'self', added: false, at },
]

describe('render', () => {
  test.each(MESSAGES.map((message) => [message.type, message] as const))(
    '%s names the app in the subject and both bodies, and gives the support address',
    (_, message) => {
      const email = render(acme, message)
      for (const part of [email.subject, email.text, email.html]) {
        expect(part).toContain('Acme')
      }
      expect(email.text).toContain('Need help? Contact help@acme.test')
      expect(email.html).toContain('Need help? Contact help@acme.test')
      expect(email.html.startsWith('<!doctype html>')).toBe(true)
    }
  )

  test.each<['email_verification' | 'password_reset', string]>([
    ['email_verification', '482913 is your Acme verification code'],
    ['password_reset', '482913 is your Acme password reset code'],
  ])('%s leads the subject with the code', (type, subject) => {
    const email = render(acme, { type, code: '482913', ttlMinutes: 10 })
    expect(email.subject).toBe(subject)
    expect(/^(\d{6})\b/.exec(email.subject)?.[1]).toBe('482913')
    expect(email.text).toContain('\n\n482913\n\n')
    expect(email.text).toContain('This code expires in 10 minutes.')
    expect(email.html).toContain('>482913</p>')
  })

  test.each<['account_exists' | 'no_account', string]>([
    ['account_exists', 'Your Acme account already exists'],
    ['no_account', 'Acme password reset requested'],
  ])('%s is a notice with no code and no link', (type, subject) => {
    const email = render(acme, { type })
    expect(email.subject).toBe(subject)
    expect(`${email.subject} ${email.text} ${email.html}`).not.toMatch(/\d{6}/)
    expect(email.html).not.toContain('<a ')
    expect(email.text).not.toContain('http')
  })

  test.each<['self' | 'reset' | 'admin', boolean, string, string]>([
    [
      'self',
      false,
      'Your Acme password was changed',
      'was changed by someone signed in to it. Every other device was signed out.',
    ],
    [
      'reset',
      false,
      'Your Acme password was changed',
      'was reset, using a code sent to this email address. Every device that was signed in has been signed out.',
    ],
    [
      'admin',
      false,
      'Your Acme password was changed',
      'An administrator of Acme set a new password for your account.',
    ],
    [
      'reset',
      true,
      'A password was added to your Acme account',
      'A password was added to your Acme account, using a code sent to this email address.',
    ],
    [
      'admin',
      true,
      'A password was added to your Acme account',
      'An administrator of Acme added a password to your account.',
    ],
    [
      'self',
      true,
      'A password was added to your Acme account',
      'A password was added to your Acme account by someone signed in to it.',
    ],
  ])(
    'a password notice (%s, added: %p) says who did it and what to do',
    (by, added, subject, says) => {
      const email = render(acme, { type: 'password_changed', by, added, at })
      expect(email.subject).toBe(subject)
      for (const part of [email.text, email.html]) {
        expect(part).toContain(says)
        expect(part).toContain('When: 2026-10-03 14:05 UTC')
        expect(part).toContain(
          'open Acme and reset your password from the sign-in screen right away'
        )
        expect(part).toContain('If you cannot get back in to your account, contact help@acme.test.')
      }
    }
  )

  test('a new sign-in notice gives the device, the time in UTC and the address', () => {
    const email = render(acme, signIn)
    expect(email.subject).toBe('New sign-in to your Acme account')
    expect(email.text).toContain(
      '\n\nDevice: Chrome on Windows\nWhen: 2026-10-03 14:05 UTC\nIP address: 203.0.113.7\n\n'
    )
    expect(email.html).toContain(
      '<p>Device: Chrome on Windows<br>When: 2026-10-03 14:05 UTC<br>IP address: 203.0.113.7</p>'
    )
    expect(email.text).toContain("If it wasn't you, open Acme and reset your password")
  })

  test('a new sign-in notice leaves the address out when there is none', () => {
    const email = render(acme, { ...signIn, ipAddress: null })
    expect(email.text).toContain('Device: Chrome on Windows\nWhen: 2026-10-03 14:05 UTC\n\n')
    expect(`${email.text}${email.html}`).not.toContain('IP address')
  })

  test.each<[string, EmailMessage]>([
    ['new_sign_in', signIn],
    ['password_changed', { type: 'password_changed', by: 'reset', added: false, at }],
  ])(
    '%s carries no code, no link and no token, and its subject does not lead with digits',
    (_, message) => {
      for (const brand of [acme, { name: '482913', supportEmail: null }]) {
        const email = render(brand, message)
        expect(email.subject).not.toMatch(/^\d/)
        expect(email.html).not.toContain('<a ')
        expect(`${email.text}${email.html}`).not.toMatch(/https?:|tula_/)
      }
      const email = render(acme, message)
      expect(`${email.subject} ${email.text}`).not.toMatch(/\b\d{6}\b/)
      // Without a support address nothing says to write to one.
      expect(render({ name: 'Acme', supportEmail: null }, message).text).not.toContain('contact')
    }
  )

  test('what a notice shows is escaped in the HTML, whatever it is', () => {
    const hostile = '<img src=x onerror=alert(1)>'
    const { html, text } = render({ name: hostile, supportEmail: null }, {
      ...signIn,
      device: hostile,
      ipAddress: hostile,
    } as EmailMessage)
    expect(html).not.toContain('<img')
    expect(html).toContain('Device: &lt;img src=x onerror=alert(1)&gt;<br>')
    expect(text).toContain(`Device: ${hostile}`)
  })

  test('a support address that contains {app} is shown as written', () => {
    const email = render({ name: 'Acme', supportEmail: '{app}@acme.test' }, signIn)
    expect(email.text).toContain('contact {app}@acme.test.')
  })

  test('without a support address the footer is just the app name', () => {
    const email = render({ name: 'Acme', supportEmail: null }, code)
    expect(email.text.endsWith('--\nAcme')).toBe(true)
    expect(email.text).not.toContain('Need help')
    expect(email.html).not.toContain('Need help')
  })

  test('a link is offered next to the code, escaped in the attribute', () => {
    const email = render(acme, {
      ...code,
      linkUrl: 'https://app.acme.test/verify?token=abc&next="><script>',
    })
    expect(email.text).toContain(
      'Or open this link: https://app.acme.test/verify?token=abc&next="><script>'
    )
    expect(email.html).toContain(
      '<a href="https://app.acme.test/verify?token=abc&amp;next=&quot;&gt;&lt;script&gt;">Verify email</a>'
    )
    expect(email.html).not.toContain('<script>')
    expect(
      render(acme, { type: 'password_reset', code: '1', ttlMinutes: 1, linkUrl: 'https://a.test' })
        .html
    ).toContain('>Reset password</a>')
  })

  test('an app name cannot add a header: line breaks never reach the subject', () => {
    const brand = { name: 'Acme\r\nBcc: victim@example.com\r\n\r\nPay up', supportEmail: null }
    for (const message of MESSAGES) {
      const { subject } = render(brand, message)
      expect(subject).not.toMatch(/[\r\n\u2028\u2029]/)
      expect(subject).toContain('Acme Bcc: victim@example.com Pay up')
    }
  })

  test('an app name cannot add markup: it is escaped everywhere in the HTML', () => {
    const brand = {
      name: '<img src=x onerror=alert(1)> & "Co" \'s',
      supportEmail: '"><b>x</b>@evil.test',
    }
    for (const message of MESSAGES) {
      const { html, text } = render(brand, message)
      expect(html).not.toContain('<img')
      expect(html).not.toContain('<b>')
      expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;Co&quot; &#39;s')
      // The text part is not HTML, so it keeps the name as written.
      expect(text).toContain('<img src=x onerror=alert(1)> & "Co" \'s')
    }
  })

  test('replacement patterns in an app name are taken literally', () => {
    const email = render({ name: 'A$&B $1 $$', supportEmail: null }, { type: 'account_exists' })
    expect(email.subject).toBe('Your A$&B $1 $$ account already exists')
  })

  test('the only markup is the layout’s own', () => {
    const tags = new Set(
      render(acme, { ...code, linkUrl: 'https://a.test' }).html.match(/<\/?[a-z!]+/g)
    )
    expect([...tags].sort()).toEqual(
      ['</a', '</body', '</html', '</p', '<!doctype', '<a', '<body', '<br', '<html', '<p'].sort()
    )
  })
})

describe('displayName', () => {
  test.each<[string, string, string]>([
    ['a plain name', 'Acme', 'Acme'],
    ['surrounding space', '  Acme  ', 'Acme'],
    ['a line break', 'Ac\r\nme', 'Ac me'],
    ['control characters', 'Ac\u0000\u0007me', 'Ac me'],
    ['line and paragraph separators', 'Ac\u2028\u2029me', 'Ac me'],
    ['nothing printable', '\r\n\t', 'Tula'],
    ['an empty name', '', 'Tula'],
    ['a name that is too long', 'a'.repeat(200), 'a'.repeat(64)],
  ])('%s', (_, name, shown) => {
    expect(displayName(name)).toBe(shown)
  })
})

describe('escapeHtml', () => {
  test('escapes every character that can leave text or an attribute', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;'
    )
  })

  test('an already escaped value is escaped again, not trusted', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;')
  })
})
