import { expect, test } from 'bun:test'
import { printable, unseenCodePoints } from './printable'

test.each([
  ['plain text is left as it is', 'https://api.example.com/webhooks/tula?a=1&b=%20', null],
  [
    'letters of any script are left as they are',
    'https://example.com/caf\u{E9}/\u{5D0}\u{5D1}',
    null,
  ],
  [
    'a right-to-left override',
    'https://example.com/\u{202E}gnp.exe',
    'https://example.com/\\u{202E}gnp.exe',
  ],
  ['a zero-width space', 'https://exa\u{200B}mple.com/', 'https://exa\\u{200B}mple.com/'],
  ['a zero-width joiner', 'a\u{200D}b', 'a\\u{200D}b'],
  ['a byte-order mark', '\u{FEFF}a', '\\u{FEFF}a'],
  ['a control character', 'a\u{7}b\u{1B}c', 'a\\u{7}b\\u{1B}c'],
  ['a line and a paragraph separator', 'a\u{2028}b\u{2029}c', 'a\\u{2028}b\\u{2029}c'],
  ['a newline and a tab', 'a\nb\tc', 'a\\u{A}b\\u{9}c'],
  ['a space of any kind', 'a b\u{A0}c\u{3000}d', 'a\\u{20}b\\u{A0}c\\u{3000}d'],
  ['a private-use character', 'a\u{E000}b', 'a\\u{E000}b'],
  ['an unassigned code point', 'a\u{378}b', 'a\\u{378}b'],
  ['a lone surrogate', 'a\u{D800}b', 'a\\u{D800}b'],
  ['a tag character beyond the basic plane', 'a\u{E0041}b', 'a\\u{E0041}b'],
  ['a variation selector', 'a\u{FE0F}b', 'a\\u{FE0F}b'],
  ['a combining grapheme joiner', 'a\u{34F}b', 'a\\u{34F}b'],
  ['a soft hyphen', 'a\u{AD}b', 'a\\u{AD}b'],
  // A mark is drawn on the character before it, whatever that is.
  ['a combining stroke laid over a slash', 'a.com/\u{338}b', 'a.com/\\u{338}b'],
  ['a combining mark on a dot', 'a.\u{307}com', 'a.\\u{307}com'],
  ['a run of combining marks', 'a\u{301}\u{301}\u{301}b', 'a\\u{301}\\u{301}\\u{301}b'],
  ['an enclosing mark', 'a\u{20DD}b', 'a\\u{20DD}b'],
  [
    'a decomposed accent, which is drawn like the letter that has it built in',
    'cafe\u{301}',
    'cafe\\u{301}',
  ],
  // The cost, accepted: a script that writes its vowels as marks is not read fluently.
  ['a vowel sign of a script that writes vowels as marks', '\u{915}\u{93F}', '\u{915}\\u{93F}'],
  ['a mark beyond the basic plane', 'a\u{1D165}b', 'a\\u{1D165}b'],
  // Otherwise text that spells an escape would read the same as the character it names.
  ['a backslash, so that what is shown names one text only', 'a\\u{200B}b', 'a\\u{5C}u{200B}b'],
])('%s', (_name, text, shown) => {
  expect(printable(text)).toBe(shown ?? text)
})

test('a pair of surrogates that is one character is left as that character', () => {
  expect(printable('a\u{1F600}b')).toBe('a\u{1F600}b')
})

test('two texts that differ only by a character nobody can see are shown differently', () => {
  const seen = new Set(
    ['example', 'exa\u{200B}mple', 'exa\u{200C}mple', 'exa\u{2060}mple', 'exa\\u{200B}mple'].map(
      printable
    )
  )
  expect(seen.size).toBe(5)
})

test('two texts that are drawn alike, one with a mark and one without, are shown differently', () => {
  expect(printable('caf\u{E9}')).toBe('caf\u{E9}')
  expect(printable('cafe\u{301}')).not.toBe(printable('caf\u{E9}'))
  expect(printable('a/b')).not.toBe(printable('a/\u{338}b'))
  // Nor can the written-out form be typed as text and read the same.
  expect(printable('cafe\\u{301}')).toBe('cafe\\u{5C}u{301}')
})

test('what is written out can be read back to the one text it came from', () => {
  const back = (shown: string) =>
    shown.replace(/\\u\{([0-9A-F]+)\}/g, (_all, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16))
    )
  for (const text of [
    'https://a.example/\u{338}x\\y z\u{200B}',
    'cafe\u{301}\\u{301}',
    '\u{915}\u{93F}\u{1D165}\u{FE0F}',
    'plain',
  ]) {
    expect(back(printable(text))).toBe(text)
  }
})

test.each<[string, string, string[]]>([
  ['a sentence with spaces, a line break and an accent', 'Caf\u{E9} code:\n123 456', []],
  ['a decomposed accent, which is drawn', 'Cafe\u{301}', []],
  ['a zero-width space', 'Your\u{200B} code', ['U+200B']],
  [
    'a joiner and a variation selector, each once',
    'a\u{200D}b\u{FE0F}c\u{200D}',
    ['U+200D', 'U+FE0F'],
  ],
  ['a right-to-left override', 'a\u{202E}b', ['U+202E']],
  ['a control character and a tab', 'a\u{7}b\tc', ['U+0007', 'U+0009']],
  ['a line and a paragraph separator', 'a\u{2028}b\u{2029}', ['U+2028', 'U+2029']],
  ['a private-use and an unassigned character', '\u{E000}\u{378}', ['U+E000', 'U+0378']],
  ['a lone surrogate', 'a\u{D800}b', ['U+D800']],
  ['a tag character beyond the basic plane', 'a\u{E0041}b', ['U+E0041']],
])('unseenCodePoints: %s', (_name, text, expected) => {
  expect(unseenCodePoints(text)).toEqual(expected)
})
