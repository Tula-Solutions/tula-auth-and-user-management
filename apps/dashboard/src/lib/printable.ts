// Characters a reader cannot see, or that change how the text around them is drawn: control
// characters, format characters (the direction overrides, the zero-width ones), private-use
// and unassigned code points, lone surrogates, every kind of space and separator, and what
// Unicode says is not drawn by default (variation selectors, the combining grapheme joiner).
// Classes, never a list of code points: a list is out of date with the next Unicode version.
// The backslash is in the set so that what is written out cannot also be typed as text.
const UNSEEN = /[\p{C}\p{Z}\p{Default_Ignorable_Code_Point}\\]/gu

/**
 * Text from the server (an address an operator typed) as something a reader can check by
 * eye: every character that cannot be seen, or that turns the text round, is written out as
 * `\u{…}` with its code point.
 *
 * Two texts are shown the same only when they are the same: a backslash is written out too,
 * so an address that spells `\u{200B}` is not shown like one that holds the character. What
 * it does not do is tell apart letters of different scripts that look alike.
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
