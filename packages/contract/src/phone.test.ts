import { describe, expect, test } from 'bun:test'
import {
  COUNTRY_CALLING_PREFIXES,
  isPhoneNumberAllowed,
  isSmsCountry,
  maskPhoneNumber,
  parsePhoneNumber,
  phoneNumberCountries,
  phoneNumberPrefix,
  SMS_COUNTRIES,
  SMS_PREFIX_MAX_DIGITS,
  smsCostLimits,
  smsPrefixCountries,
} from './phone'

describe('parsePhoneNumber', () => {
  test.each([
    ['+14155550100', '+14155550100'],
    ['+1 (415) 555-0100', '+14155550100'],
    ['+49 151 1234-5678', '+4915112345678'],
    // The shortest and the longest: 8 and 15 digits.
    ['+12345678', '+12345678'],
    ['+123456789012345', '+123456789012345'],
  ])('%s is %s', (input, expected) => {
    expect(parsePhoneNumber(input)).toBe(expected)
  })

  test.each([
    ['no plus', '14155550100'],
    ['a national number', '0171 5550100'],
    ['the 00 prefix', '0049 151 12345678'],
    ['a leading zero after the plus', '+0415555010'],
    ['seven digits', '+1234567'],
    ['sixteen digits', '+1234567890123456'],
    ['a letter', '+1415555010a'],
    ['a dot', '+1.415.555.0100'],
    ['a slash', '+49151/12345678'],
    ['an extension', '+14155550100x12'],
    ['a second plus', '+1415+5550100'],
    ['a plus that is not first', '1+4155550100'],
    ['a tab', '+1415\t5550100'],
    ['a line break', '+14155550100\n'],
    ['a no-break space', '+1\u{a0}4155550100'],
    ['fullwidth digits', '+\u{ff11}4155550100'],
    ['Arabic-Indic digits', '+\u{661}4155550100'],
    ['nothing', ''],
    ['only a plus', '+'],
  ])('refuses %s', (_name, input) => {
    expect(parsePhoneNumber(input)).toBeNull()
  })
})

describe('maskPhoneNumber', () => {
  test('keeps the last two digits and nothing else', () => {
    expect(maskPhoneNumber('+14155550100')).toBe('***00')
    expect(maskPhoneNumber('+4915112345678')).toBe('***78')
  })
})

describe('the calling-prefix table', () => {
  test('every key is two upper-case letters and every prefix is digits not starting with 0', () => {
    for (const [country, prefixes] of Object.entries(COUNTRY_CALLING_PREFIXES)) {
      expect(country).toMatch(/^[A-Z]{2}$/)
      expect(prefixes.length).toBeGreaterThan(0)
      for (const prefix of prefixes) {
        expect(prefix).toMatch(/^[1-9][0-9]{0,3}$/)
      }
    }
  })

  test('SMS_COUNTRIES is the keys, sorted', () => {
    expect(SMS_COUNTRIES).toEqual(Object.keys(COUNTRY_CALLING_PREFIXES).sort())
  })

  test('isSmsCountry takes an exact, upper-case, own key', () => {
    expect(isSmsCountry('DE')).toBe(true)
    expect(isSmsCountry('de')).toBe(false)
    expect(isSmsCountry('ZZ')).toBe(false)
    expect(isSmsCountry('DEU')).toBe(false)
    expect(isSmsCountry('constructor')).toBe(false)
    expect(isSmsCountry('')).toBe(false)
  })
})

describe('phoneNumberCountries', () => {
  // Calling codes as ITU-T E.164 assigns them, and the North American numbering plan's area
  // codes for the members that have their own.
  test.each([
    ['+4915112345678', ['DE']],
    ['+33612345678', ['FR']],
    ['+919876543210', ['IN']],
    ['+819012345678', ['JP']],
    ['+5511987654321', ['BR']],
    ['+27821234567', ['ZA']],
    ['+14155550100', ['CA', 'US']],
    ['+16045550100', ['CA', 'US']],
    ['+12425550100', ['BS']],
    ['+18765550100', ['JM']],
    ['+18095550100', ['DO']],
    ['+17875550100', ['PR']],
    ['+447911123456', ['GB', 'GG', 'IM', 'JE']],
    ['+79161234567', ['RU']],
    ['+77011234567', ['KZ']],
    ['+390612345678', ['IT', 'VA']],
    ['+59996123456', ['CW']],
    ['+5997123456', ['BQ']],
    ['+358401234567', ['AX', 'FI']],
  ])('%s belongs to %j', (number, countries) => {
    expect([...phoneNumberCountries(number)].sort()).toEqual(countries)
  })

  test('a calling code the table does not have belongs to no country', () => {
    // +999 is reserved, +888 and +979 are international services, not countries.
    expect(phoneNumberCountries('+99912345678')).toEqual([])
    expect(phoneNumberCountries('+88812345678')).toEqual([])
    expect(phoneNumberCountries('+97912345678')).toEqual([])
  })
})

describe('isPhoneNumberAllowed', () => {
  test('an empty list allows nothing', () => {
    expect(isPhoneNumberAllowed('+4915112345678', [])).toBe(false)
  })

  test('a listed country allows its numbers and no other', () => {
    expect(isPhoneNumberAllowed('+4915112345678', ['DE'])).toBe(true)
    expect(isPhoneNumberAllowed('+33612345678', ['DE'])).toBe(false)
  })

  test('the longest prefix decides: a Bahamian number is not let through by US', () => {
    expect(isPhoneNumberAllowed('+12425550100', ['US', 'CA'])).toBe(false)
    expect(isPhoneNumberAllowed('+12425550100', ['BS'])).toBe(true)
    expect(isPhoneNumberAllowed('+77011234567', ['RU'])).toBe(false)
  })

  test('countries that share a prefix are one destination', () => {
    expect(isPhoneNumberAllowed('+16045550100', ['US'])).toBe(true)
  })

  test('a number of an unknown calling code is allowed by no list', () => {
    expect(isPhoneNumberAllowed('+99912345678', [...SMS_COUNTRIES])).toBe(false)
  })
})

describe('phoneNumberPrefix', () => {
  test.each([
    ['+14155550100', '+1'],
    ['+4915112345678', '+49'],
    ['+37120000000', '+371'],
    // Longest first: the Bahamas inside `+1`, Kazakhstan inside `+7`.
    ['+12425550100', '+1242'],
    ['+77012345678', '+77'],
    ['+79161234567', '+7'],
  ])('of %s is %s', (number, prefix) => {
    expect(phoneNumberPrefix(number)).toBe(prefix)
  })

  test('a calling code the table does not have has no prefix', () => {
    expect(phoneNumberPrefix('+99912345678')).toBeNull()
  })

  test('numbers of one destination share it, and it is the prefix the allow-list matched', () => {
    expect(phoneNumberPrefix('+14155550100')).toBe(phoneNumberPrefix('+12125559999'))
    expect(phoneNumberPrefix('+14155550100')).not.toBe(phoneNumberPrefix('+12425550100'))
    for (const country of SMS_COUNTRIES) {
      for (const prefix of COUNTRY_CALLING_PREFIXES[country] ?? []) {
        const number = `+${prefix}55550100`
        expect(phoneNumberPrefix(number)).toBe(`+${prefix}`)
        expect(phoneNumberCountries(number)).toContain(country)
      }
    }
  })

  test('no prefix is longer than SMS_PREFIX_MAX_DIGITS, and one is that long', () => {
    const lengths = Object.values(COUNTRY_CALLING_PREFIXES).flatMap((prefixes) =>
      prefixes.map((prefix) => prefix.length)
    )
    expect(Math.max(...lengths)).toBe(SMS_PREFIX_MAX_DIGITS)
  })
})

describe('smsPrefixCountries', () => {
  test.each([
    ['+49', ['DE']],
    ['49', ['DE']],
    // A shared prefix is every country that has it, never one of them.
    ['+1', ['CA', 'US']],
    ['+39', ['IT', 'VA']],
    // The prefix exactly: the Bahamas are not under `+1`.
    ['+1242', ['BS']],
    ['+999', []],
    ['', []],
    ['+', []],
  ])('%s covers %j', (prefix, countries) => {
    expect(smsPrefixCountries(prefix)).toEqual(countries)
  })

  test('every prefix a number can be counted under covers the countries the number may be of', () => {
    for (const country of SMS_COUNTRIES) {
      for (const prefix of COUNTRY_CALLING_PREFIXES[country] ?? []) {
        expect(smsPrefixCountries(`+${prefix}`)).toContain(country)
        expect(smsPrefixCountries(`+${prefix}`)).toEqual(phoneNumberCountries(`+${prefix}5550100`))
      }
    }
  })
})

describe('smsCostLimits', () => {
  test.each([
    [500, { prefixPerHour: 50, environmentPerHour: 125, perDay: 500 }],
    // Rounded up, and never below one message an hour.
    [1, { prefixPerHour: 1, environmentPerHour: 1, perDay: 1 }],
    [11, { prefixPerHour: 2, environmentPerHour: 3, perDay: 11 }],
    [1_000_000, { prefixPerHour: 100_000, environmentPerHour: 250_000, perDay: 1_000_000 }],
  ])('a day of %d is %j', (limit, limits) => {
    expect(smsCostLimits(limit)).toEqual(limits)
  })

  test.each([0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'a limit of %p, which the API never stores, reads as one message a day',
    (limit) => {
      expect(smsCostLimits(limit)).toEqual({ prefixPerHour: 1, environmentPerHour: 1, perDay: 1 })
    }
  )
})
