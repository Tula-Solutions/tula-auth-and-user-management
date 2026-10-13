import { describe, expect, test } from 'bun:test'
import {
  COUNTRY_CALLING_PREFIXES,
  MAX_SMS_DAILY_MESSAGE_LIMIT,
  SMS_COUNTRIES,
  SMS_USAGE_DEFAULT_DAYS,
  SMS_USAGE_MAX_DAYS,
} from '@tula/contract'
import {
  countryChoices,
  countryEntry,
  countryName,
  countryPrefixes,
  destination,
  destinationWords,
  hourlySentence,
  sharesPrefixWith,
  spanSentence,
  totalsSentence,
  USAGE_DAYS,
  withCountry,
} from './model'

describe('a country in words', () => {
  test.each([
    ['DE', 'Germany'],
    ['US', 'United States'],
    ['XK', 'Kosovo'],
  ])('%s is %s', (code, name) => {
    expect(countryName(code)).toBe(name)
  })

  test('every country of the contract’s list has a name that is not its code', () => {
    expect(SMS_COUNTRIES.filter((code) => countryName(code) === code)).toEqual([])
  })

  test('what is no country is shown as it is, never guessed', () => {
    expect(countryName('not a code')).toBe('not a code')
    expect(countryName('')).toBe('')
  })

  test.each([
    ['DE', ['+49']],
    ['DO', ['+1809', '+1829', '+1849']],
    ['ZZ', []],
    // A key of every object is not a country.
    ['toString', []],
  ])('the prefixes of %s are %j', (code, prefixes) => {
    expect(countryPrefixes(code)).toEqual(prefixes)
  })

  test.each([
    ['US', ['CA']],
    ['CA', ['US']],
    ['IT', ['VA']],
    ['DE', []],
    ['BS', []],
  ])('%s cannot be told from %j', (code, others) => {
    expect(sharesPrefixWith(code)).toEqual(others)
  })

  test('an entry says name, prefixes and the countries it also allows', () => {
    expect(countryEntry('US')).toEqual({
      code: 'US',
      name: 'United States',
      prefixes: '+1',
      sharedWith: ['Canada'],
    })
  })
})

describe('the countries that can be added', () => {
  test('every country of the contract, by name, without those already chosen', () => {
    const all = countryChoices([])
    expect(all.map((entry) => entry.code).sort()).toEqual([...SMS_COUNTRIES])
    expect(all.map((entry) => entry.name)).toEqual(
      [...all.map((entry) => entry.name)].sort((a, b) => a.localeCompare(b, 'en'))
    )
    const rest = countryChoices(['DE', 'US'])
    expect(rest).toHaveLength(SMS_COUNTRIES.length - 2)
    expect(rest.some((entry) => entry.code === 'DE' || entry.code === 'US')).toBe(false)
  })

  test.each([
    ['a new country joins the list', ['DE'], 'US', ['DE', 'US']],
    ['one that is there is not listed twice', ['DE', 'US'], 'US', ['DE', 'US']],
    ['what is not a country of the list changes nothing', ['DE'], 'Germany', ['DE']],
    ['a lower-case code is not a country', ['DE'], 'us', ['DE']],
    ['nothing chosen changes nothing', ['DE'], '', ['DE']],
  ])('%s', (_name, chosen, country, expected) => {
    expect(withCountry(chosen, country)).toEqual(expected)
  })
})

describe('a destination of the usage', () => {
  test.each([
    ['+49', { prefix: '+49', countries: ['Germany'] }],
    ['+1', { prefix: '+1', countries: ['Canada', 'United States'] }],
    ['+1242', { prefix: '+1242', countries: ['Bahamas'] }],
    ['+999', { prefix: '+999', countries: [] }],
    // The server's text is written out: what cannot be seen in it is seen.
    ['+4\u{200B}9', { prefix: '+4\\u{200B}9', countries: [] }],
    ['+49\u{202E}', { prefix: '+49\\u{202E}', countries: [] }],
  ])('%j', (prefix, expected) => {
    expect(destination(prefix)).toEqual(expected)
  })

  test('every prefix of the contract names every country that has it', () => {
    for (const country of SMS_COUNTRIES) {
      for (const prefix of COUNTRY_CALLING_PREFIXES[country] ?? []) {
        expect(destination(`+${prefix}`).countries).toContain(countryName(country))
      }
    }
  })

  test.each([
    [[], 'A prefix this version of the dashboard does not know'],
    [['Germany'], 'Germany'],
    [
      ['Canada', 'United States'],
      'Canada, United States (2 countries share this prefix and are counted together)',
    ],
  ])('the countries %j are said as %p', (countries, words) => {
    expect(destinationWords(countries)).toBe(words)
  })
})

describe('the usage in words', () => {
  test('the spans offered are a day, the route’s default and its most', () => {
    expect(USAGE_DAYS).toEqual([1, SMS_USAGE_DEFAULT_DAYS, SMS_USAGE_MAX_DAYS])
  })

  test.each([
    [{ since: '2026-10-04', days: 1 }, 'Today, in UTC (2026-10-04).'],
    [{ since: '2026-09-28', days: 7 }, 'The last 7 days, in UTC: 2026-09-28 to today.'],
  ])('the span %j', (usage, words) => {
    expect(spanSentence(usage)).toBe(words)
  })

  test.each([
    [{ sent: 0, used: 0, unused: 0 }, '0 codes sent, 0 used, 0 never used.'],
    [{ sent: 1, used: 1, unused: 0 }, '1 code sent, 1 used, 0 never used.'],
    [{ sent: 12000, used: 3, unused: 11997 }, '12,000 codes sent, 3 used, 11,997 never used.'],
  ])('the totals %j', (usage, words) => {
    expect(totalsSentence(usage)).toBe(words)
  })
})

describe('what a daily limit allows in an hour', () => {
  test.each([
    [
      500,
      'With 500 messages a day: at most 125 in one hour in all, and at most 50 in one hour to one destination prefix.',
    ],
    [
      1,
      'With 1 message a day: at most 1 in one hour in all, and at most 1 in one hour to one destination prefix.',
    ],
    [
      MAX_SMS_DAILY_MESSAGE_LIMIT,
      'With 1,000,000 messages a day: at most 250,000 in one hour in all, and at most 100,000 in one hour to one destination prefix.',
    ],
  ])('%d', (limit, words) => {
    expect(hourlySentence(limit, MAX_SMS_DAILY_MESSAGE_LIMIT)).toBe(words)
  })

  test.each([undefined, 0, -1, 1.5, Number.NaN, MAX_SMS_DAILY_MESSAGE_LIMIT + 1])(
    'nothing is said of %p, which would not be saved',
    (limit) => {
      expect(hourlySentence(limit, MAX_SMS_DAILY_MESSAGE_LIMIT)).toBeNull()
    }
  )
})
