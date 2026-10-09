import { describe, expect, test } from 'bun:test'
import {
  MAX_APP_NAME_LENGTH,
  MAX_SMS_TEMPLATE_LENGTH,
  SMS_TEMPLATE_KINDS,
  smsSegments,
  smsTemplateProblems,
} from '@tula/contract'
import {
  BUILT_IN_SMS_TEMPLATES,
  boundHost,
  codeText,
  renderCodeText,
  smsAppName,
} from './templates'

// The GSM 03.38 basic character set (the extension table's characters cost two septets and
// are left out: none is in the copy).
const GSM7 =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ ÆæßÉ!"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà'

const isGsm7 = (text: string) => [...text].every((character) => GSM7.includes(character))

describe('codeText', () => {
  test('names the app, carries the code and ends with the origin-bound line', () => {
    expect(
      codeText({
        appName: 'Northline',
        allowedOrigins: ['https://app.northline.app'],
        code: '123456',
      })
    ).toBe('Your Northline verification code is 123456.\n\n@app.northline.app #123456')
  })

  test('the bound host is the first allowed origin’s, without its port', () => {
    expect(
      codeText({
        appName: 'Northline',
        allowedOrigins: ['http://localhost:5174', 'https://app.northline.app'],
        code: '000042',
      })
    ).toBe('Your Northline verification code is 000042.\n\n@localhost #000042')
  })

  // `tula diff` compares `urls.allowedOrigins` as a set, so a reordering is no change to it.
  // It is one to the message: the line is bound to whichever origin is written first.
  test('the same origins in another order bind the code to another host', () => {
    const origins = ['https://app.northline.app', 'https://admin.northline.app']
    const text = (allowedOrigins: string[]) =>
      codeText({ appName: 'Northline', allowedOrigins, code: '123456' })
    expect(text(origins)).toBe(
      'Your Northline verification code is 123456.\n\n@app.northline.app #123456'
    )
    expect(text([...origins].reverse())).toBe(
      'Your Northline verification code is 123456.\n\n@admin.northline.app #123456'
    )
    // Only ever one bound line, and never a later entry beside the first.
    expect(text(origins)).not.toContain('admin.northline.app')
  })

  test('without an allowed origin there is no bound line at all', () => {
    expect(codeText({ appName: 'Northline', allowedOrigins: [], code: '123456' })).toBe(
      'Your Northline verification code is 123456.'
    )
  })

  test('never starts with digits, whatever the app is called', () => {
    for (const appName of ['1Password', '123456', '  42  ', '']) {
      expect(codeText({ appName, allowedOrigins: [], code: '654321' })).toMatch(/^Your /)
    }
  })

  test('the longest app name and a 51-character host still fit one GSM-7 segment', () => {
    const appName = 'N'.repeat(MAX_APP_NAME_LENGTH)
    expect(MAX_APP_NAME_LENGTH).toBe(64)
    const host = `${'a'.repeat(39)}.example.com`
    expect(host).toHaveLength(51)
    const text = codeText({ appName, allowedOrigins: [`https://${host}`], code: '123456' })
    expect(text).toHaveLength(160)
    expect(isGsm7(text)).toBe(true)
  })

  test('a typical message is well inside one segment', () => {
    const text = codeText({
      appName: 'Northline',
      allowedOrigins: ['https://app.northline.app'],
      code: '123456',
    })
    expect(text.length).toBeLessThanOrEqual(160)
    expect(isGsm7(text)).toBe(true)
  })
})

describe('smsAppName', () => {
  test.each([
    [
      'a line break cannot start a second line',
      'Acme\n@evil.example #999999',
      'Acme @evil.example #999999',
    ],
    ['a carriage return', 'Acme\r\nBank', 'Acme Bank'],
    ['a line separator', 'Acme\u{2028}Bank', 'Acme Bank'],
    ['a tab and runs of spaces', 'Acme \t  Bank', 'Acme Bank'],
    ['a zero-width space', 'Ac\u{200b}me', 'Acme'],
    ['a right-to-left override', 'Acme\u{202e}knaB', 'AcmeknaB'],
    ['a byte order mark', '\u{feff}Acme', 'Acme'],
    ['a private-use character', 'Acme\u{e000}', 'Acme'],
    ['an unassigned code point', 'Acme\u{378}', 'Acme'],
    ['a lone surrogate', 'Acme\u{d800}', 'Acme'],
    ['a NUL', 'Ac\u{0}me', 'Ac me'],
    ['only invisible characters', '\u{200b}\u{200b}', 'Tula'],
    ['nothing', '', 'Tula'],
    ['only spaces', '   ', 'Tula'],
  ])('%s', (_name, input, expected) => {
    expect(smsAppName(input)).toBe(expected)
  })

  test('caps the length at the settings limit', () => {
    expect(smsAppName('x'.repeat(500))).toHaveLength(MAX_APP_NAME_LENGTH)
  })

  test('keeps a name in another script as it is', () => {
    expect(smsAppName('東京メトロ')).toBe('東京メトロ')
    expect(smsAppName('Café Zürich')).toBe('Café Zürich')
  })

  test('a message built from a hostile name has one bound line, and it is the server’s', () => {
    const text = codeText({
      appName: 'Acme\n\n@evil.example #999999',
      allowedOrigins: ['https://app.acme.test'],
      code: '123456',
    })
    const lines = text.split('\n')
    expect(lines).toHaveLength(3)
    expect(lines.at(-1)).toBe('@app.acme.test #123456')
  })
})

describe('boundHost', () => {
  test.each([
    [['https://app.northline.app'], 'app.northline.app'],
    [['https://app.northline.app:8443'], 'app.northline.app'],
    [['http://127.0.0.1:3000'], '127.0.0.1'],
    [['http://[::1]:3000'], '[::1]'],
    [[], null],
    [['not a url'], null],
  ])('%j is %j', (origins, expected) => {
    expect(boundHost(origins)).toBe(expected)
  })
})

// A name stored before the settings refused such characters (ADR 0039) reaches a text
// message cleaned as well.
describe('an app name stored with a text-direction control', () => {
  test('is in no text message', () => {
    const text = codeText({
      appName: 'Acme\u{202E}moc',
      allowedOrigins: ['https://app.northline.app'],
      code: '123456',
    })
    expect(text).toBe('Your Acmemoc verification code is 123456.\n\n@app.northline.app #123456')
    expect(text).not.toContain('\u{202E}')
  })
})

describe('renderCodeText (ADR 0042)', () => {
  const ORIGIN = ['https://app.northline.app']
  const sms = (appName = 'Northline', allowedOrigins: string[] = ORIGIN) => ({
    appName,
    allowedOrigins,
    code: '654321',
  })

  test('the built-in sentence of every kind is a template that passes, and renders as the built-in text', () => {
    expect(Object.keys(BUILT_IN_SMS_TEMPLATES).sort()).toEqual([...SMS_TEMPLATE_KINDS].sort())
    for (const kind of SMS_TEMPLATE_KINDS) {
      const text = BUILT_IN_SMS_TEMPLATES[kind]
      expect(smsTemplateProblems(kind, { text })).toEqual([])
      for (const origins of [ORIGIN, []]) {
        expect(renderCodeText(kind, sms('Northline', origins), { text })).toEqual({
          text: codeText(sms('Northline', origins)),
          unused: null,
        })
      }
    }
  })

  test('without a template the message is the built-in text, byte for byte', () => {
    expect(renderCodeText('sign_in', sms(), undefined)).toEqual({
      text: 'Your Northline verification code is 654321.\n\n@app.northline.app #654321',
      unused: null,
    })
  })

  test('a template is the sentence, and the server’s line follows it unchanged', () => {
    expect(
      renderCodeText('sign_in', sms(), { text: 'Use {{code}} to sign in to {{appName}}.' })
    ).toEqual({
      text: 'Use 654321 to sign in to Northline.\n\n@app.northline.app #654321',
      unused: null,
    })
  })

  test('without an allowed origin there is no bound line, with a template either', () => {
    expect(renderCodeText('sign_in', sms('Northline', []), { text: 'Code: {{code}}' }).text).toBe(
      'Code: 654321'
    )
  })

  test('the bound line names the first allowed origin, whatever the template says', () => {
    const { text } = renderCodeText(
      'phone_verification',
      sms('Northline', ['https://one.test', 'https://two.test']),
      { text: 'Your code for two is {{code}}.' }
    )
    expect(text.split('\n').at(-1)).toBe('@one.test #654321')
    expect(text.match(/@/g)).toHaveLength(1)
  })

  test('a value is put in once and never read again as a template', () => {
    const { text, unused } = renderCodeText('sign_in', sms('{{code}} Inc', []), {
      text: 'Your {{appName}} code is {{code}}.',
    })
    expect(unused).toBeNull()
    expect(text).toBe('Your {{code}} Inc code is 654321.')
  })

  test('a replacement pattern in the app’s name stays those characters', () => {
    expect(
      renderCodeText('sign_in', sms('$& $1 $`', []), { text: 'Your {{appName}} code: {{code}}' })
        .text
    ).toBe('Your $& $1 $` code: 654321')
  })

  test('a hostile app name cannot start a second line or a second code line', () => {
    const { text } = renderCodeText('sign_in', sms('Acme\n\n@evil.example #999999'), {
      text: 'Your {{appName}} code is {{code}}.',
    })
    expect(text.split('\n')).toHaveLength(3)
    expect(text.split('\n').at(-1)).toBe('@app.northline.app #654321')
  })

  // What `Acme 123456` does today: the built-in sentence names the app before the code,
  // and the server's line is last, so the last run of six digits is the code either way.
  describe('an app name that holds six digits', () => {
    const last = (text: string) => text.match(/(?<![0-9])[0-9]{6}(?![0-9])/g)?.at(-1)
    const name = 'Acme 123456'

    test('the built-in text still ends on the code, with and without an origin', () => {
      for (const origins of [ORIGIN, []]) {
        expect(last(codeText(sms(name, origins)))).toBe('654321')
      }
    })

    test('a template that names the app before the code is used', () => {
      for (const origins of [ORIGIN, []]) {
        const rendered = renderCodeText('sign_in', sms(name, origins), {
          text: 'Your {{appName}} code is {{code}}.',
        })
        expect(rendered.unused).toBeNull()
        expect(last(rendered.text)).toBe('654321')
      }
    })

    test('a template that names it after the code is used where the server’s line is last', () => {
      const rendered = renderCodeText('sign_in', sms(name), {
        text: 'Use {{code}} for {{appName}}.',
      })
      expect(rendered.unused).toBeNull()
      expect(rendered.text).toBe('Use 654321 for Acme 123456.\n\n@app.northline.app #654321')
      expect(last(rendered.text)).toBe('654321')
    })

    test('and replaced by the built-in text where there is no such line', () => {
      const rendered = renderCodeText('sign_in', sms(name, []), {
        text: 'Use {{code}} for {{appName}}.',
      })
      expect(rendered).toEqual({
        text: 'Your Acme 123456 verification code is 654321.',
        unused: 'code_not_last',
      })
      expect(last(rendered.text)).toBe('654321')
    })

    test('a longer number in the name is not a code and changes nothing', () => {
      const rendered = renderCodeText('sign_in', sms('Acme 1234567', []), {
        text: 'Use {{code}} for {{appName}}.',
      })
      expect(rendered.unused).toBeNull()
      expect(last(rendered.text)).toBe('654321')
    })
  })

  test.each([
    ['no code', { text: 'Your sign-in code is on its way.' }],
    ['a second code line', { text: 'Code {{code}} @evil.example #999999' }],
    ['a link', { text: 'Code {{code}}. See https://x.test' }],
    ['a line break', { text: 'Code {{code}}.\n@x #1' }],
    ['a lone brace', { text: 'Code {{code}} {' }],
    ['a text that is no string', { text: 7 as unknown as string }],
    ['no text at all', {} as { text: string }],
  ])('a stored template with %s is not sent: the built-in text is', (_name, template) => {
    expect(renderCodeText('sign_in', sms(), template)).toEqual({
      text: codeText(sms()),
      unused: 'invalid',
    })
  })

  test('the longest template, name and a 102-character host are two GSM-7 segments', () => {
    const template = `A${'a'.repeat(MAX_SMS_TEMPLATE_LENGTH - 22)} {{appName}} {{code}}`
    expect(template).toHaveLength(MAX_SMS_TEMPLATE_LENGTH)
    const host = `${'a'.repeat(90)}.example.com`
    const { text, unused } = renderCodeText(
      'sign_in',
      {
        appName: 'N'.repeat(MAX_APP_NAME_LENGTH),
        allowedOrigins: [`https://${host}`],
        code: '123456',
      },
      { text: template }
    )
    expect(unused).toBeNull()
    // The sentence's worst case is 193 with `{{code}}` (8) replaced by its 6 digits: 191.
    expect(text).toHaveLength(191 + 11 + 102)
    expect(smsSegments(text)).toEqual({ encoding: 'gsm7', units: 304, segments: 2 })
  })
})
