import { describe, expect, test } from 'bun:test'
import {
  base32Decode,
  base32Encode,
  generateSecret,
  hotp,
  matchStep,
  otpauthUri,
  TOTP_DRIFT_STEPS,
  TOTP_SECRET_BYTES,
  totp,
  totpStep,
} from '~/lib/totp'

const ascii = (text: string) => new TextEncoder().encode(text)
/** The shared secret of the RFC 4226 and RFC 6238 (SHA-1) test vectors. */
const RFC_SECRET = ascii('12345678901234567890')
/** The moment a time step begins. */
const startOf = (step: number) => new Date(step * 30_000)

describe('base32', () => {
  // RFC 4648 §10, without the padding.
  test.each<[string, string]>([
    ['', ''],
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ])('encodes %p as %p and decodes it back', (plain, encoded) => {
    expect(base32Encode(ascii(plain))).toBe(encoded)
    expect(base32Decode(encoded)).toEqual(ascii(plain))
  })

  test('decoding ignores case, spaces, dashes and padding', () => {
    for (const typed of [
      'mzxw6ytboi',
      'MZXW 6YTB OI',
      'mzxw-6ytb-oi',
      'MZXW6YTBOI======',
      ' MZXW6YTBOI\n',
    ]) {
      expect(base32Decode(typed)).toEqual(ascii('foobar'))
    }
  })

  test.each<[string]>([['MZXW6YTB0I'], ['MZXW1'], ['MZXW8'], ['MZ_XW'], ['MZXW6é']])(
    'decoding %p throws: a character outside the alphabet is never guessed at',
    (text) => {
      expect(() => base32Decode(text)).toThrow(RangeError)
    }
  )

  test('round-trips every byte value at every length up to a secret’s', () => {
    for (let length = 0; length <= TOTP_SECRET_BYTES; length++) {
      const bytes = Uint8Array.from({ length }, (_, index) => (index * 37 + length * 11) % 256)
      const encoded = base32Encode(bytes)
      expect(encoded).toMatch(/^[A-Z2-7]*$/)
      expect(base32Decode(encoded)).toEqual(bytes)
    }
    expect(base32Decode(base32Encode(new Uint8Array(20).fill(255)))).toEqual(
      new Uint8Array(20).fill(255)
    )
  })
})

describe('generateSecret', () => {
  test('is 160 bits and differs between calls', () => {
    const secrets = Array.from({ length: 20 }, () => generateSecret())
    for (const secret of secrets) {
      expect(secret).toBeInstanceOf(Uint8Array)
      expect(secret).toHaveLength(20)
    }
    expect(TOTP_SECRET_BYTES).toBe(20)
    expect(new Set(secrets.map((secret) => base32Encode(secret))).size).toBe(20)
    // 20 bytes are 32 Base32 characters with no partial group.
    expect(base32Encode(secrets[0] as Uint8Array)).toMatch(/^[A-Z2-7]{32}$/)
  })
})

describe('hotp', () => {
  // RFC 4226 Appendix D.
  test.each<[number, string]>([
    [0, '755224'],
    [1, '287082'],
    [2, '359152'],
    [3, '969429'],
    [4, '338314'],
    [5, '254676'],
    [6, '287922'],
    [7, '162583'],
    [8, '399871'],
    [9, '520489'],
  ])('counter %d is %s', (counter, expected) => {
    expect(hotp(RFC_SECRET, counter)).toBe(expected)
  })

  test('longer codes are the same value truncated less (RFC 6238 Appendix B, 8 digits)', () => {
    expect(hotp(RFC_SECRET, 1, 8)).toBe('94287082')
    expect(hotp(RFC_SECRET, 37037036, 8)).toBe('07081804')
  })
})

describe('totp', () => {
  // RFC 6238 Appendix B, the SHA-1 rows, truncated to 6 digits.
  test.each<[number, string]>([
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ])('at %d seconds the code is %s', (seconds, expected) => {
    expect(totp(RFC_SECRET, new Date(seconds * 1000))).toBe(expected)
  })

  test('a step is 30 whole seconds since the epoch', () => {
    expect(totpStep(new Date(0))).toBe(0)
    expect(totpStep(new Date(29_999))).toBe(0)
    expect(totpStep(new Date(30_000))).toBe(1)
    expect(totpStep(new Date(59_000))).toBe(1)
    expect(totpStep(new Date(1111111109 * 1000))).toBe(37037036)
  })

  test('the documented example holds', () => {
    expect(totp(base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'), new Date(59_000))).toBe('287082')
  })
})

describe('matchStep', () => {
  const STEP = 1000
  const at = startOf(STEP)
  const codeOf = (step: number) => hotp(RFC_SECRET, step)

  test('accepts the current step', () => {
    expect(matchStep(RFC_SECRET, codeOf(STEP), at)).toBe(STEP)
  })

  test('accepts exactly one step before and one step after', () => {
    expect(TOTP_DRIFT_STEPS).toBe(1)
    expect(matchStep(RFC_SECRET, codeOf(STEP - 1), at)).toBe(STEP - 1)
    expect(matchStep(RFC_SECRET, codeOf(STEP + 1), at)).toBe(STEP + 1)
  })

  test('refuses a code two steps away, either side', () => {
    expect(matchStep(RFC_SECRET, codeOf(STEP - 2), at)).toBeNull()
    expect(matchStep(RFC_SECRET, codeOf(STEP + 2), at)).toBeNull()
  })

  test('the window moves at the second a step rolls over', () => {
    const lastMs = new Date(startOf(STEP + 1).getTime() - 1)
    const firstMs = startOf(STEP + 1)
    // In the last millisecond of the step the code of two steps on is not yet good...
    expect(matchStep(RFC_SECRET, codeOf(STEP + 2), lastMs)).toBeNull()
    expect(matchStep(RFC_SECRET, codeOf(STEP - 1), lastMs)).toBe(STEP - 1)
    // ...and a millisecond later it is, while the oldest one has just stopped being good.
    expect(matchStep(RFC_SECRET, codeOf(STEP + 2), firstMs)).toBe(STEP + 2)
    expect(matchStep(RFC_SECRET, codeOf(STEP - 1), firstMs)).toBeNull()
  })

  test.each<[string, string]>([
    ['empty', ''],
    ['five digits', '12345'],
    ['seven digits', '1234567'],
    ['letters', 'abcdef'],
    ['a digit and spaces', ' 12345'],
    ['full-width digits', '１２３４５６'],
  ])('refuses a %s code', (_, code) => {
    expect(matchStep(RFC_SECRET, code, at)).toBeNull()
  })

  test('refuses the right code with anything added to it', () => {
    const code = codeOf(STEP)
    for (const typed of [`${code}0`, ` ${code}`, `${code}\n`, code.slice(0, 5)]) {
      expect(matchStep(RFC_SECRET, typed, at)).toBeNull()
    }
  })

  test('refuses a right code of another secret', () => {
    const other = ascii('09876543210987654321')
    expect(matchStep(other, codeOf(STEP), at)).toBeNull()
  })

  test('at the epoch there is no step before the first: steps 0 and 1 only', () => {
    const epoch = new Date(0)
    expect(matchStep(RFC_SECRET, '755224', epoch)).toBe(0)
    expect(matchStep(RFC_SECRET, '287082', epoch)).toBe(1)
    expect(matchStep(RFC_SECRET, '359152', epoch)).toBeNull()
    // One step in, step 0 is the earlier neighbour.
    expect(matchStep(RFC_SECRET, '755224', startOf(1))).toBe(0)
  })

  test('returns the latest step when two steps in the window share a code', () => {
    // For this secret, steps 153567 and 153569 both give 468457, and 910737 and 910738 both
    // give 911617 (found by search; the assertions below prove it).
    expect([hotp(RFC_SECRET, 153567), hotp(RFC_SECRET, 153569)]).toEqual(['468457', '468457'])
    expect(matchStep(RFC_SECRET, '468457', startOf(153568))).toBe(153569)
    expect([hotp(RFC_SECRET, 910737), hotp(RFC_SECRET, 910738)]).toEqual(['911617', '911617'])
    expect(matchStep(RFC_SECRET, '911617', startOf(910737))).toBe(910738)
    expect(matchStep(RFC_SECRET, '911617', startOf(910738))).toBe(910738)
    // Outside the later step's window only the earlier one is left.
    expect(matchStep(RFC_SECRET, '468457', startOf(153566))).toBe(153567)
  })
})

describe('otpauthUri', () => {
  test('is the exact Key URI for an issuer, an account and a secret', () => {
    expect(otpauthUri({ issuer: 'Acme', account: 'maya@acme.test', secret: RFC_SECRET })).toBe(
      'otpauth://totp/Acme:maya%40acme.test?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' +
        '&issuer=Acme&algorithm=SHA1&digits=6&period=30'
    )
  })

  test('percent-encodes spaces, ampersands and at signs in both places', () => {
    expect(
      otpauthUri({ issuer: 'Tom & Jerry @ Home', account: 'a b+c@x.test', secret: RFC_SECRET })
    ).toBe(
      'otpauth://totp/Tom%20%26%20Jerry%20%40%20Home:a%20b%2Bc%40x.test' +
        '?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' +
        '&issuer=Tom%20%26%20Jerry%20%40%20Home&algorithm=SHA1&digits=6&period=30'
    )
  })

  test('drops a colon from the issuer and encodes one in the account, so the label has one separator', () => {
    const uri = otpauthUri({ issuer: ' Acme: Staging ', account: 'a:b@x.test', secret: RFC_SECRET })
    expect(uri).toBe(
      'otpauth://totp/Acme%20Staging:a%3Ab%40x.test?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' +
        '&issuer=Acme%20Staging&algorithm=SHA1&digits=6&period=30'
    )
    expect(uri.slice('otpauth://totp/'.length).split('?')[0]?.split(':')).toHaveLength(2)
  })

  test('an issuer cannot add a parameter of its own', () => {
    const uri = otpauthUri({ issuer: 'X&secret=AAAA', account: 'a@x.test', secret: RFC_SECRET })
    expect(new URL(uri).searchParams.getAll('secret')).toEqual(['GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'])
    expect(new URL(uri).searchParams.get('issuer')).toBe('X&secret=AAAA')
  })
})
