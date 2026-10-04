/**
 * The longest string a tool returns for one field. Longer text is cut and ends with `…`.
 *
 * @example
 * ```ts
 * cleanText(name, MAX_STRING_CHARS)
 * ```
 */
export const MAX_STRING_CHARS = 512

/**
 * The most entries of one array a tool returns.
 *
 * @example
 * ```ts
 * S.array(S.string(), MAX_ARRAY_ITEMS)
 * ```
 */
export const MAX_ARRAY_ITEMS = 100

/**
 * The largest result of one tool call, as characters of JSON. A list that does not fit loses
 * entries from its end and is marked `truncated`.
 *
 * @example
 * ```ts
 * JSON.stringify(bound(output)).length <= MAX_OUTPUT_CHARS
 * ```
 */
export const MAX_OUTPUT_CHARS = 64_000

/**
 * What a secret-shaped value, or one of the server's own credentials, is replaced with.
 *
 * @example
 * ```ts
 * cleanText('tula_sk_live_…') // '[redacted]'
 * ```
 */
export const REDACTED = '[redacted]'

/**
 * The most combining marks kept in a row. Real text stacks a few on a letter (a Vietnamese
 * vowel has two, pointed Hebrew up to four); hundreds are a flood that hides or buries the
 * text around it, so the rest of a longer run is dropped.
 *
 * @example
 * ```ts
 * cleanText(`a${'\u{301}'.repeat(200)}`) // 'a' and MAX_COMBINING_MARKS accents
 * ```
 */
export const MAX_COMBINING_MARKS = 8

const MIN_WINDOW_CHARS = 4096

/**
 * How much of a string from the API is looked at for a field capped at `max` characters: four
 * times the cap, and at least 4096 characters. What lies past it is dropped before any
 * pattern runs, so one enormous value cannot keep the server (one thread, one pipe) busy.
 *
 * @param max - The field's cap.
 * @returns The number of characters considered.
 *
 * @example
 * ```ts
 * inputWindow(512) // 4096
 * ```
 */
export function inputWindow(max: number): number {
  return Math.max(max * 4, MIN_WINDOW_CHARS)
}

// Controls (an escape sequence, a newline that would break a field out of its line) and the
// line and paragraph separators become a space: they separate words, and still must.
const SEPARATORS = /[\p{Cc}\p{Zl}\p{Zp}]/gu

// What a reader cannot see and a model still reads, removed outright:
// - `Cf`, format characters: zero-width spaces and joiners, bidirectional marks, embeddings,
//   overrides and isolates, the soft hyphen, the tag characters ("ASCII smuggling": a whole
//   sentence in code points that render as nothing), interlinear annotation;
// - `Co` and `Cn`, private-use and unassigned code points (and noncharacters): they mean
//   nothing a tool should pass on, and the tag block's unassigned ends are among them;
// - `Cs`, a surrogate that is not half of a pair;
// - the variation selectors (both blocks, and Mongolian's) and the combining grapheme joiner,
//   which are marks and so not in the classes above;
// - the Hangul fillers, letters that render as nothing.
const VARIATION_SELECTORS = /[\u{FE00}-\u{FE0F}\u{180B}-\u{180F}\u{E0100}-\u{E01EF}]/gu
const INVISIBLE = /[\p{Cf}\p{Co}\p{Cn}\p{Cs}]|\u{34F}|[\u{115F}\u{1160}\u{3164}\u{FFA0}]/gu
const MARK_FLOOD = new RegExp(`(\\p{M}{${MAX_COMBINING_MARKS}})\\p{M}+`, 'gu')

const JWT_START = 'eyJ'
const KEY_START = 'tula_sk_'
// The characters a key or a JWT is made of, with the dot that joins a JWT's parts.
const TOKEN_RUN = /[A-Za-z0-9_.-]+/g

/**
 * Replace every JWT inside one run of token characters: `eyJ` and five more characters, a
 * dot, and two more parts of five or more.
 *
 * Written by hand because the pattern for it (`eyJ…\.…\.…`) starts again at every `eyJ` of a
 * run that has no dot, which is quadratic. Here each part of a run is looked at once.
 */
function redactJwtsInRun(run: string): string {
  if (!run.includes(JWT_START)) {
    return run
  }
  const parts = run.split('.')
  const out: string[] = []
  let index = 0
  while (index < parts.length) {
    const part = parts[index] as string
    const at = part.indexOf(JWT_START)
    const second = parts[index + 1]
    const third = parts[index + 2]
    if (
      at !== -1 &&
      part.length - at >= JWT_START.length + 5 &&
      second !== undefined &&
      second.length >= 5 &&
      third !== undefined &&
      third.length >= 5
    ) {
      out.push(`${part.slice(0, at)}${REDACTED}`)
      index += 3
    } else {
      out.push(part)
      index += 1
    }
  }
  return out.join('.')
}

/**
 * Shapes that are secrets wherever they turn up: a Tula secret key, a JWT, a password hash,
 * an authenticator URI or its `secret=`, a PEM block. The projection already drops every field
 * that could hold one; this is for a secret that arrives inside a field that is kept (a user
 * who pasted a key into their name, an API that one day answers differently).
 *
 * Each costs time in proportion to the text: a pattern here has no quantifier inside another,
 * and none that can fail after a long scan and start again inside what it scanned. They run
 * after the cleaning, so a newline inside a PEM block is a space by now.
 */
const SECRET_SHAPES: readonly ((text: string) => string)[] = [
  (text) => text.replace(/tula_sk_[a-z]+_[A-Za-z0-9_-]{8,}/g, REDACTED),
  (text) => text.replace(TOKEN_RUN, redactJwtsInRun),
  (text) => text.replace(/\$(?:argon2(?:id|i|d)|2[aby]|scrypt)\$[^\s"']+/g, REDACTED),
  (text) => text.replace(/otpauth:\/\/[^\s"']+/g, REDACTED),
  (text) => text.replace(/-----BEGIN [A-Z ]+-----[\s\S]*?(?:-----END [A-Z ]+-----|$)/g, REDACTED),
]

function isTokenCharacter(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) || // 0-9
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) || // a-z
    code === 0x5f || // _
    code === 0x2d || // -
    code === 0x2e // .
  )
}

/**
 * For text the window cut: a key or a JWT that began before the cut and did not finish is too
 * short for its shape, and would be returned as it is. Replace it from where it starts. (A
 * hash, an authenticator URI and a PEM block match however short they were cut.)
 */
function withoutCutSecret(text: string): string {
  let start = text.length
  while (start > 0 && isTokenCharacter(text.charCodeAt(start - 1))) {
    start -= 1
  }
  const tail = text.slice(start)
  const starts = [tail.indexOf(KEY_START), tail.indexOf(JWT_START)].filter((at) => at !== -1)
  return starts.length === 0 ? text : `${text.slice(0, start + Math.min(...starts))}${REDACTED}`
}

/**
 * Text from the API made safe to hand to a model, in this order:
 *
 * 1. Only the first {@link inputWindow} characters are considered; the rest is dropped.
 * 2. Control characters and line and paragraph separators become a space. Characters a reader
 *    cannot see are removed: format characters (zero-width, bidirectional controls, the soft
 *    hyphen, tag characters), private-use and unassigned code points, lone surrogates,
 *    variation selectors, the combining grapheme joiner and the Hangul fillers. A run of
 *    combining marks is cut at {@link MAX_COMBINING_MARKS}.
 * 3. Secret-shaped values are replaced. After step 2, so that a key split by a zero-width
 *    space is whole again when it is looked for.
 * 4. The text is cut at `max` and ends with `…` when anything was cut.
 *
 * Letters of every script survive, composed or decomposed, and so do emoji. The price is in
 * the joiners and selectors: a family emoji comes apart into its people, an emoji that needed
 * a variation selector is shown in its text form, and Arabic or Persian text loses its
 * zero-width (non-)joiners. A code point newer than the runtime's Unicode tables counts as
 * unassigned and is removed.
 *
 * @param value - The text.
 * @param max - The longest text kept.
 * @returns The cleaned text.
 *
 * @example
 * ```ts
 * cleanText('Maya\u001b[2J') // 'Maya [2J'
 * cleanText('tula_sk_live_abc\u{200B}defghijklmnop') // '[redacted]'
 * ```
 */
export function cleanText(value: string, max: number = MAX_STRING_CHARS): string {
  const window = inputWindow(max)
  let cut = value.length > window
  let text = (cut ? value.slice(0, window) : value)
    .replace(SEPARATORS, ' ')
    .replace(VARIATION_SELECTORS, '')
    .replace(INVISIBLE, '')
    .replace(MARK_FLOOD, '$1')
  for (const redact of SECRET_SHAPES) {
    text = redact(text)
  }
  if (cut) {
    text = withoutCutSecret(text)
  }
  if (text.length > max) {
    // Not between the halves of a surrogate pair: half of one is not a character.
    const last = text.charCodeAt(max - 1)
    text = text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max)
    cut = true
  }
  return cut ? `${text}…` : text
}

/**
 * What a tool may return of a value: the fields named here and nothing else.
 *
 * @example
 * ```ts
 * const USER: Shape = S.object({ id: S.string(), email: S.string() })
 * ```
 */
export type Shape =
  | { readonly kind: 'string'; readonly max: number }
  | { readonly kind: 'number' }
  | { readonly kind: 'boolean' }
  | { readonly kind: 'array'; readonly of: Shape; readonly max: number }
  | { readonly kind: 'object'; readonly fields: Readonly<Record<string, Shape>> }
  | { readonly kind: 'record'; readonly of: Shape; readonly max: number }

/**
 * Builders for a {@link Shape}.
 *
 * @example
 * ```ts
 * S.object({ id: S.string(), tags: S.array(S.string(40), 10) })
 * ```
 */
export const S = {
  /** Text, cleaned and cut at `max`. */
  string: (max: number = MAX_STRING_CHARS): Shape => ({ kind: 'string', max }),
  /** A finite number. */
  number: { kind: 'number' } as Shape,
  /** A boolean. */
  boolean: { kind: 'boolean' } as Shape,
  /** The first `max` entries that fit `of`. */
  array: (of: Shape, max: number = MAX_ARRAY_ITEMS): Shape => ({ kind: 'array', of, max }),
  /** An object's named fields. */
  object: (fields: Record<string, Shape>): Shape => ({ kind: 'object', fields }),
  /** An object whose keys are data (a session profile's name): the first `max` of them. */
  record: (of: Shape, max: number): Shape => ({ kind: 'record', of, max }),
} as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * Copy the part of `value` that `shape` names. A field the shape does not name is dropped; a
 * value of another type than the shape says is dropped too, never passed through. `null` is
 * kept, because "none" is an answer.
 *
 * This is what stands between an API answer and a tool result: a field added to the API later
 * is not returned until someone names it here.
 *
 * @param value - What the API answered.
 * @param shape - What may be returned of it.
 * @returns The projection, or `undefined` when nothing of `value` fits.
 *
 * @example
 * ```ts
 * project({ id: 'u1', passwordHash: '…' }, S.object({ id: S.string() })) // { id: 'u1' }
 * ```
 */
export function project(value: unknown, shape: Shape): unknown {
  if (value === null) {
    return null
  }
  switch (shape.kind) {
    case 'string':
      return typeof value === 'string' ? cleanText(value, shape.max) : undefined
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined
    case 'boolean':
      return typeof value === 'boolean' ? value : undefined
    case 'array': {
      if (!Array.isArray(value)) {
        return undefined
      }
      const kept: unknown[] = []
      for (const item of value) {
        if (kept.length >= shape.max) {
          break
        }
        const projected = project(item, shape.of)
        if (projected !== undefined) {
          kept.push(projected)
        }
      }
      return kept
    }
    case 'object': {
      if (!isRecord(value)) {
        return undefined
      }
      const out: Record<string, unknown> = {}
      for (const [key, inner] of Object.entries(shape.fields)) {
        const projected = Object.hasOwn(value, key) ? project(value[key], inner) : undefined
        if (projected !== undefined) {
          out[key] = projected
        }
      }
      return out
    }
    case 'record': {
      if (!isRecord(value)) {
        return undefined
      }
      const out: Record<string, unknown> = {}
      let count = 0
      for (const [key, inner] of Object.entries(value)) {
        if (count >= shape.max) {
          break
        }
        if (FORBIDDEN_KEYS.has(key)) {
          continue
        }
        const projected = project(inner, shape.of)
        if (projected !== undefined) {
          out[cleanText(key, 64)] = projected
          count += 1
        }
      }
      return out
    }
  }
}

/**
 * Keep a tool's result under {@link MAX_OUTPUT_CHARS}. A result with a `data` list loses
 * entries from the end until it fits and gains `truncated: true`; anything else that is too
 * large is replaced by an `output.too_large` error.
 *
 * @param output - The tool's result.
 * @returns The result, bounded.
 *
 * @example
 * ```ts
 * const safe = bound({ meta, data })
 * ```
 */
export function bound(output: Record<string, unknown>): Record<string, unknown> {
  if (JSON.stringify(output).length <= MAX_OUTPUT_CHARS) {
    return output
  }
  if (Array.isArray(output.data)) {
    const data = [...output.data]
    const candidate: Record<string, unknown> = { ...output, data, truncated: true }
    while (data.length > 0 && JSON.stringify(candidate).length > MAX_OUTPUT_CHARS) {
      data.pop()
    }
    if (JSON.stringify(candidate).length <= MAX_OUTPUT_CHARS) {
      return candidate
    }
  }
  return {
    error: {
      code: 'output.too_large',
      message: 'The result is too large to return. Ask for a smaller page or a narrower filter.',
    },
  }
}

/**
 * Make a function that replaces the server's own credentials wherever they appear in a value.
 * Nothing puts them there; this is the last step of every result and log line all the same.
 *
 * @param secrets - The secret key, the admin token. Empty and very short values are ignored
 *   (replacing a three-letter string would mangle ordinary text).
 * @returns The function.
 *
 * @example
 * ```ts
 * const redact = redactor([secretKey])
 * redact({ message: `refused ${secretKey}` }) // { message: 'refused [redacted]' }
 * ```
 */
export function redactor(secrets: readonly (string | undefined)[]): <T>(value: T) => T {
  const known = secrets.filter(
    (secret): secret is string => typeof secret === 'string' && secret.length >= 8
  )
  function walk(value: unknown): unknown {
    if (typeof value === 'string') {
      let text = value
      for (const secret of known) {
        text = text.split(secret).join(REDACTED)
      }
      return text
    }
    if (Array.isArray(value)) {
      return value.map(walk)
    }
    if (isRecord(value)) {
      const out: Record<string, unknown> = {}
      for (const [key, inner] of Object.entries(value)) {
        out[walk(key) as string] = walk(inner)
      }
      return out
    }
    return value
  }
  return <T>(value: T): T => walk(value) as T
}
