// Characters a reader cannot see, or that change how the text around them is drawn: control
// characters, format characters (the direction overrides, the zero-width ones), private-use
// and unassigned code points, lone surrogates, every kind of space and separator, and what
// Unicode says is not drawn by default (variation selectors, the combining grapheme joiner).
// And every combining mark: it is drawn on whatever comes before it, so a stroke laid over a
// slash, a dot over a dot or a pile of accents changes how an address reads, and an accent
// that is a character of its own is drawn exactly like the letter that has it built in.
// Classes, never a list of code points: a list is out of date with the next Unicode version.
// The backslash is in the set so that what is written out cannot also be typed as text.
const UNSEEN = /[\p{C}\p{Z}\p{M}\p{Default_Ignorable_Code_Point}\\]/gu

/**
 * Text from the server (an address an operator typed) as something a reader can check by
 * eye: every character that cannot be seen, that turns the text round, or that is drawn on
 * top of its neighbour (a combining mark) is written out as `\u{…}` with its code point.
 *
 * Two texts are shown the same only when they are the same: each such character becomes its
 * own escape, and a backslash is written out too, so an address that spells `\u{200B}` is
 * not shown like one that holds the character. What it does not do is tell apart letters of
 * different scripts that look alike.
 *
 * The cost of writing out every mark: text in a script that writes vowels or accents as
 * marks (Devanagari, Thai, pointed Hebrew, a decomposed "é") is shown with escapes in it.
 * An address is the one thing this is used for. The server keeps one as it was typed, and
 * an address is usually typed with such text in Punycode and percent escapes; where one
 * holds a mark as itself, seeing it is the point.
 *
 * @param text - The text as the server gave it.
 * @returns The text with such characters written out; ordinary text unchanged.
 * @example
 * printable('https://exa\u{200B}mple.com') // 'https://exa\\u{200B}mple.com'
 */
export function printable(text: string): string {
  return text.replace(UNSEEN, (character) => {
    const point = character.codePointAt(0) ?? 0
    return `\\u{${point.toString(16).toUpperCase()}}`
  })
}

// What cannot be seen in a sentence, where spaces, line breaks and accents are ordinary:
// control characters other than the line break, format characters, private-use and
// unassigned code points, lone surrogates, the line and paragraph separators, and what
// Unicode says is not drawn by default. Classes, for the reason above.
const UNSEEN_IN_PROSE = /[^\P{C}\n]|[\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu

/**
 * The characters of a sentence that a reader cannot see, as code points: for text that is
 * shown as it is (a message's wording, its preview) and so cannot be written out the way
 * {@link printable} writes an address out. `printable` escapes every space and every
 * combining mark, which is right for an address and unreadable for prose; this names what
 * is hidden and leaves the text alone.
 *
 * @param text - The text as it is.
 * @returns Each such character once, in the order it first appears, as `U+XXXX`.
 * @example
 * unseenCodePoints('Your\u{200B} code') // ['U+200B']
 */
export function unseenCodePoints(text: string): string[] {
  const found = new Set<string>()
  for (const character of text.match(UNSEEN_IN_PROSE) ?? []) {
    const point = character.codePointAt(0) ?? 0
    found.add(`U+${point.toString(16).toUpperCase().padStart(4, '0')}`)
  }
  return [...found]
}
