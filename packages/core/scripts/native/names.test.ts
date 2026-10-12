import { describe, expect, test } from 'bun:test'
import {
  camelCase,
  commentText,
  kotlinIdentifier,
  kotlinString,
  memberNames,
  pascalCase,
  swiftIdentifier,
  swiftString,
  typeName,
} from './names'

describe('names from the wire', () => {
  test.each([
    ['auth.invalid_credentials', 'authInvalidCredentials', 'AuthInvalidCredentials'],
    ['needs_first_factor', 'needsFirstFactor', 'NeedsFirstFactor'],
    ['public-key', 'publicKey', 'PublicKey'],
    ['x-tula-client', 'xTulaClient', 'XTulaClient'],
    // No separator: nothing but the first letter is touched.
    ['clientDataJSON', 'clientDataJSON', 'ClientDataJSON'],
    ['URL', 'uRL', 'URL'],
    ['rate_limited', 'rateLimited', 'RateLimited'],
    ['2fa', '_2fa', '_2fa'],
    ['a__b..c', 'aBC', 'ABC'],
    ['', 'empty', 'Empty'],
    ['--', 'empty', 'Empty'],
    ['\u00e9', 'empty', 'Empty'],
  ])('%p is %s in camelCase and %s in PascalCase', (wire, camel, pascal) => {
    expect(camelCase(wire)).toBe(camel)
    expect(pascalCase(wire)).toBe(pascal)
  })

  test.each([
    ['FlowStep', 'FlowStep'],
    ['flow_step', 'FlowStep'],
    ['Error', 'TulaError'],
    ['String', 'TulaString'],
    ['Type', 'TulaType'],
    ['Unknown', 'TulaUnknown'],
    ['JsonElement', 'TulaJsonElement'],
    ['2Factor', 'Tula_2Factor'],
  ])('the type for %p is %s, in both languages', (name, expected) => {
    expect(typeName(name)).toBe(expected)
  })
})

describe('identifiers a language cannot take are escaped in one function', () => {
  test.each([
    ['name', 'name'],
    ['default', '`default`'],
    ['class', '`class`'],
    ['in', '`in`'],
    ['protocol', '`protocol`'],
    ['true', '`true`'],
    // Backticks do not help for these.
    ['self', 'self_'],
    ['init', 'init_'],
    ['Type', 'Type_'],
    ['Self', 'Self_'],
    ['Protocol', 'Protocol_'],
    // Contextual keywords are plain identifiers.
    ['optional', 'optional'],
    ['required', 'required'],
    ['type', 'type'],
    ['2fa', '_2fa'],
    ['a-b', 'a_b'],
    ['', 'empty'],
    ['_', 'empty'],
  ])('Swift: %p is written %s', (name, expected) => {
    expect(swiftIdentifier(name)).toBe(expected)
  })

  test.each([
    ['name', 'name'],
    ['object', '`object`'],
    ['class', '`class`'],
    ['when', '`when`'],
    ['in', '`in`'],
    ['typealias', '`typealias`'],
    ['null', '`null`'],
    // Soft keywords are plain identifiers.
    ['value', 'value'],
    ['data', 'data'],
    ['default', 'default'],
    ['9lives', '_9lives'],
    ['a.b', 'a_b'],
    ['', 'empty'],
  ])('Kotlin: %p is written %s', (name, expected) => {
    expect(kotlinIdentifier(name)).toBe(expected)
  })
})

describe('string literals', () => {
  test.each([
    ['plain', '"plain"', '"plain"'],
    ['say "hi"', '"say \\"hi\\""', '"say \\"hi\\""'],
    ['back\\slash', '"back\\\\slash"', '"back\\\\slash"'],
    // A dollar sign starts a template in Kotlin and nothing in Swift.
    ['costs $5 $x', '"costs $5 $x"', '"costs \\$5 \\$x"'],
    ['line\nbreak\ttab', '"line\\u{a}break\\u{9}tab"', '"line\\u000abreak\\u0009tab"'],
    ['caf\u00e9', '"caf\\u{e9}"', '"caf\\u00e9"'],
    // Outside the basic plane: one scalar in Swift, two UTF-16 units in Kotlin.
    ['\u{1f600}', '"\\u{1f600}"', '"\\ud83d\\ude00"'],
    // What a reader cannot see is never written literally.
    ['a\u200bb\u202e', '"a\\u{200b}b\\u{202e}"', '"a\\u200bb\\u202e"'],
    ['\u007f', '"\\u{7f}"', '"\\u007f"'],
  ])('%p', (value, swift, kotlin) => {
    expect(swiftString(value)).toBe(swift)
    expect(kotlinString(value)).toBe(kotlin)
  })

  test('a literal is printable ASCII whatever it is given', () => {
    const hostile = '"\\\n\r\u0000\u2028$ {}*/\u{10ffff}'
    for (const literal of [swiftString(hostile), kotlinString(hostile)]) {
      expect(literal).toMatch(/^"[\x20-\x7e]*"$/)
      // No quote that is not escaped: the literal ends where it says it does.
      expect(literal.slice(1, -1).replace(/\\./g, '')).not.toContain('"')
    }
  })
})

describe('commentText', () => {
  test('is one line and cannot end or open a block comment', () => {
    expect(commentText('  a\n  b */ c /* d\t')).toBe('a b * / c / * d')
  })

  test.each([
    ['a typographic apostrophe', 'a provider’s ‘token’', "a provider's 'token'"],
    ['typographic quotes', 'say “no”', 'say "no"'],
    ['a text-direction override', 'ab‮cd', 'abU+202Ecd'],
    ['a zero-width space', 'a​b', 'aU+200Bb'],
    ['a control character', 'a\u0007b', 'aU+0007b'],
    ['a letter outside ASCII', 'café', 'cafU+00E9'],
    ['a character outside the basic plane', 'a\u{1f600}b', 'aU+1F600b'],
    ['a line separator, which would end a line comment', 'a b c', 'a b c'],
    ['a comment end spelled with a line separator', '* /', '* /'],
  ])('holds nothing a reader cannot see: %s', (_name, text, expected) => {
    const cleaned = commentText(text)
    expect(cleaned).toBe(expected)
    expect(cleaned).toMatch(/^[\x20-\x7e]*$/)
  })
})

describe('memberNames', () => {
  test('keeps the order and gives a taken name the suffix Value', () => {
    expect(memberNames(['a_b', 'unknown', 'c'], camelCase, new Set(['unknown']))).toEqual([
      'aB',
      'unknownValue',
      'c',
    ])
  })

  test('a taken name is recognised through its backticks', () => {
    expect(memberNames(['default'], swiftIdentifier, new Set(['default']))).toEqual([
      'defaultValue',
    ])
  })

  test('two members that would get one name fail the generation, naming both', () => {
    expect(() => memberNames(['a_b', 'a.b'], camelCase)).toThrow(
      '"a_b" and "a.b" would both be named aB'
    )
    expect(() =>
      memberNames(['unknown', 'unknown_value'], camelCase, new Set(['unknown']))
    ).toThrow('would both be named unknownValue')
  })
})
