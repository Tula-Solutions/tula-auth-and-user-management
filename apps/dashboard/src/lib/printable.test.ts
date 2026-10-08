import { expect, test } from 'bun:test'
import { printable } from './printable'

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
