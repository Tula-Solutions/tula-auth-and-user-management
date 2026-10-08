import { describe, expect, test } from 'bun:test'
import { MAX_APP_NAME_LENGTH } from '@tula/contract'
import { boundHost, codeText, smsAppName } from './templates'

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
