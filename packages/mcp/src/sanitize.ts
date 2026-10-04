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

// C0 and C1 control characters (an escape sequence, a newline that would break a field out of
// its line) become a space; characters that reorder or hide text are removed.
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is removed
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g
const INVISIBLE = /[​-‏‪-‮⁠-⁩﻿]/g

/**
 * Shapes that are secrets wherever they turn up: a Tula secret key, a JWT, a password hash,
 * an authenticator URI or its `secret=`, a PEM block. The projection already drops every field
 * that could hold one; this is for a secret that arrives inside a field that is kept (a user
 * who pasted a key into their name, an API that one day answers differently).
 */
const SECRET_SHAPES: readonly RegExp[] = [
  /tula_sk_[a-z]+_[A-Za-z0-9_-]{8,}/g,
  /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g,
  /\$(?:argon2(?:id|i|d)|2[aby]|scrypt)\$[^\s"']+/g,
  /otpauth:\/\/[^\s"']+/g,
  /-----BEGIN [A-Z ]+-----[\s\S]*?(?:-----END [A-Z ]+-----|$)/g,
]

/**
 * Text from the API made safe to hand to a model: no control or invisible characters,
 * secret-shaped values replaced, and bounded.
 *
 * @param value - The text.
 * @param max - The longest text kept.
 * @returns The cleaned text.
 *
 * @example
 * ```ts
 * cleanText('Maya\u001b[2J') // 'Maya [2J'
 * ```
 */
export function cleanText(value: string, max: number = MAX_STRING_CHARS): string {
  // Secret shapes first: a PEM block spans lines, which the next step flattens.
  let text = value
  for (const shape of SECRET_SHAPES) {
    text = text.replace(shape, REDACTED)
  }
  text = text.replace(CONTROL, ' ').replace(INVISIBLE, '')
  return text.length > max ? `${text.slice(0, max)}…` : text
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
