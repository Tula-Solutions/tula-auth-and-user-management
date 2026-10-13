import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

// Bun's `toMatchObject` does not compare a value whose state is not in its own enumerable
// properties (TULA-65; seen on Bun 1.4.2). Upstream: https://github.com/oven-sh/bun/issues/44405,
// open when this was written; its fix, https://github.com/oven-sh/bun/pull/44497, was a draft
// that says 1.4.3 still has it:
//
//   expect({ at: new Date(1) }).toMatchObject({ at: new Date(2) })   // passes
//
// The same holds, at any depth and beside asymmetric matchers, for a `Map`, a `Set`, a
// `RegExp`, an `Error`, a function, `URLSearchParams`, `Headers`, an `ArrayBuffer` and the
// length of a typed array. `toEqual`, `toStrictEqual`, `toHaveProperty`, `toContainEqual`,
// `toHaveBeenCalledWith` and `expect.objectContaining` compare all of them. An assertion about
// an expiry, a revocation or a retry time written as a date inside `toMatchObject` therefore
// passes whatever the code did.
//
// This test reads every source Bun's test runner can load and fails for a `toMatchObject(…)`
// whose argument, as written, holds such a value and is not passed, with the received value,
// through `comparable()` (`apps/api/src/testing/comparable.ts`: dates become ISO strings).
// It spawns nothing.
//
// What it cannot see, because it reads the call's text and nothing else:
//   - a date that arrives through a name: `toMatchObject(expected)`, `{ ...row }`,
//     `{ session: stored }`, the result of a function other than the ones in `DATE_CALLS`;
//   - a date under a key that does not read like a time (`{ deadline: later(5) }`,
//     `{ when }`): `TIME_KEY` is a list of spellings, not a type;
//   - a matcher reached without the words `expect(` … `.toMatchObject(` (an alias, a helper
//     that takes the expected object and calls the matcher itself);
//   - whether a value under a time key really is a `Date`: a variable holding an ISO string
//     is reported too, and wrapping both sides in `comparable()` is right for either.
// When the audit of TULA-65 was made every call was also watched while the suites ran (all
// but the twelve of the `*.integration.ts` files, which were read): 31 of 1,853 calls held a
// date, all in `apps/api`, none hid a wrong value, and none held another of the kinds above.

const root = resolve(import.meta.dir, '../..')

/** Directories whose TypeScript Bun's test runner loads. `e2e/tests` is Playwright's. */
const ROOTS = ['apps', 'packages', 'e2e', 'scripts', 'examples', 'native', '.claude/hooks']
const NOT_BUN = ['e2e/tests/']
const SKIPPED = new Set(['node_modules', 'dist', '.next', '.git', '.turbo', 'test-results'])

/** A key that names a time: `revokedAt`, `expiresAt`, `failingSince`, `lockedUntil`, `expires`. */
const TIME_KEY = `(?:[A-Za-z0-9_$]*(?:At|Until|Since)|expires[A-Za-z0-9_$]*|notBefore|notAfter)`

/** What may stand under a time key: these are compared. A string is `''` once blanked. */
const COMPARED = String.raw`(?:null\b|undefined\b|true\b|false\b|expect\s*\.|['"\`]|-?\d)`

/**
 * Calls that answer a `Date` in this repository's tests, where one is the whole value of a
 * property or an element: `{ x: deps.clock.now() }`, not `seconds(deps.clock.now())` and not
 * `deps.clock.now().toISOString()`, which are a number and a string.
 */
const DATE_CALLS = String.raw`[:\[,]\s*(?:(?:[A-Za-z0-9_$.]*\.)?clock\.now\(\)\s*(?=[,}\]]|$)|(?:later|earlier)\()`

/** Classes whose instances `toMatchObject` does not compare, or (typed arrays) not wholly. */
const UNCOMPARED_CLASS = `(?:Date|Map|Set|WeakMap|WeakSet|RegExp|URLSearchParams|Headers|ArrayBuffer|SharedArrayBuffer|DataView|[A-Za-z]*Error|(?:Ui|I)nt(?:8|16|32)Array|Uint8ClampedArray|Float(?:32|64)Array|Big(?:Ui|I)nt64Array)`

/** What `blanked` leaves where a regular expression literal began. */
const REGEXP_MARK = '\u0000'

const RULES: { why: string; pattern: RegExp }[] = [
  {
    why: 'an instance toMatchObject does not compare',
    pattern: new RegExp(String.raw`\bnew\s+${UNCOMPARED_CLASS}\s*\(`),
  },
  { why: 'a call that answers a Date', pattern: new RegExp(DATE_CALLS) },
  {
    why: 'a time-valued key',
    // A value written out as `….toISOString()` is a string, and compared.
    pattern: new RegExp(
      String.raw`(?<![A-Za-z0-9_$.])${TIME_KEY}\s*:\s*(?!\s|${COMPARED}|[^,}\n]*\.toISOString\(\)\s*(?:[,}\n]|$))`
    ),
  },
  {
    why: 'a time-valued key (shorthand)',
    pattern: new RegExp(String.raw`[{,]\s*${TIME_KEY}\s*(?=[,}])`),
  },
  { why: 'a function (any function matches any other)', pattern: /=>|\bfunction\b/ },
  // As a value or an element; inside `expect.stringMatching(/…/)` it is the matcher's.
  { why: 'a regular expression', pattern: new RegExp(String.raw`[:\[,]\s*${REGEXP_MARK}`) },
]

/**
 * Source text with the inside of every string, template, comment and regular expression
 * literal replaced by spaces, so that brackets and words in them are not read as code. A
 * regular expression literal is replaced by one NUL and spaces: it is a value the matcher
 * does not compare. Lengths and line breaks are kept.
 *
 * A `/` is taken for the start of a regular expression where an expression may begin (after
 * an operator, an opening bracket, a comma, a keyword such as `return`, or nothing): a
 * heuristic, wrong for a division written after a closing brace.
 *
 * @param source - TypeScript source.
 * @returns Text of the same length.
 */
export function blanked(source: string): string {
  const out = source.split('')
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) {
      if (out[k] !== '\n') {
        out[k] = ' '
      }
    }
  }
  /** The index after a quoted string that opens at `at`. */
  const quoted = (at: number): number => {
    const quote = source[at]
    let k = at + 1
    while (k < source.length && source[k] !== quote && source[k] !== '\n') {
      k += source[k] === '\\' ? 2 : 1
    }
    blank(at + 1, k)
    return k + 1
  }
  /** The index after a template literal that opens at `at`; its `${…}` parts stay code. */
  const template = (at: number): number => {
    let k = at + 1
    let from = k
    while (k < source.length && source[k] !== '`') {
      if (source[k] === '\\') {
        k += 2
      } else if (source[k] === '$' && source[k + 1] === '{') {
        blank(from, k)
        k = code(k + 2, '}')
        from = k
      } else {
        k += 1
      }
    }
    blank(from, k)
    return k + 1
  }
  /** Whether a `/` at `at` can start a regular expression. */
  const startsRegExp = (at: number): boolean => {
    let k = at - 1
    while (k >= 0 && (source[k] === ' ' || source[k] === '\t' || source[k] === '\n')) {
      k -= 1
    }
    if (k < 0) {
      return true
    }
    if ('(,=:[!&|?{};+-*%<>~^'.includes(source[k] as string)) {
      return true
    }
    const word = source.slice(Math.max(0, k - 9), k + 1).match(/[A-Za-z]+$/)?.[0]
    return word !== undefined && ['return', 'typeof', 'case', 'in', 'of', 'void'].includes(word)
  }
  /** The index after a regular expression literal that opens at `at`. */
  const regExp = (at: number): number => {
    let k = at + 1
    let inClass = false
    while (k < source.length && source[k] !== '\n' && (inClass || source[k] !== '/')) {
      if (source[k] === '\\') {
        k += 1
      } else if (source[k] === '[') {
        inClass = true
      } else if (source[k] === ']') {
        inClass = false
      }
      k += 1
    }
    blank(at, k + 1)
    out[at] = REGEXP_MARK
    return k + 1
  }
  /** Walks code from `at` until the closing character of a `${`, or the end. */
  function code(at: number, until?: string): number {
    let k = at
    let depth = 0
    while (k < source.length) {
      const char = source[k]
      if (char === until && depth === 0) {
        return k + 1
      }
      if (char === '{') {
        depth += 1
      } else if (char === '}') {
        depth -= 1
      }
      if (char === "'" || char === '"') {
        k = quoted(k)
      } else if (char === '`') {
        k = template(k)
      } else if (char === '/' && source[k + 1] === '/') {
        const end = source.indexOf('\n', k)
        const stop = end === -1 ? source.length : end
        blank(k, stop)
        k = stop
      } else if (char === '/' && source[k + 1] === '*') {
        const end = source.indexOf('*/', k + 2)
        const stop = end === -1 ? source.length : end + 2
        blank(k, stop)
        k = stop
      } else if (char === '/' && startsRegExp(k)) {
        k = regExp(k)
      } else {
        k += 1
      }
    }
    return k
  }
  code(0)
  return out.join('')
}

/** The index of the bracket that closes the one at `open`, or -1. */
function closing(text: string, open: number): number {
  let depth = 0
  for (let k = open; k < text.length; k++) {
    if (text[k] === '(') {
      depth += 1
    } else if (text[k] === ')') {
      depth -= 1
      if (depth === 0) {
        return k
      }
    }
  }
  return -1
}

/** The index of the bracket that opens the one closed at `close`, or -1. */
function opening(text: string, close: number): number {
  let depth = 0
  for (let k = close; k >= 0; k--) {
    if (text[k] === ')') {
      depth += 1
    } else if (text[k] === '(') {
      depth -= 1
      if (depth === 0) {
        return k
      }
    }
  }
  return -1
}

/** One `toMatchObject` call that holds a value the matcher does not compare. */
export interface Unprotected {
  /** The line of `.toMatchObject(`, from 1. */
  line: number
  /** Which rule found it. */
  why: string
}

/**
 * The `toMatchObject` calls of a source whose argument holds, as written, a value the
 * matcher does not compare, and that do not pass both sides through `comparable()`.
 *
 * @param source - TypeScript source.
 * @returns A finding per call, in order.
 */
export function unprotected(source: string): Unprotected[] {
  const text = blanked(source)
  const found: Unprotected[] = []
  for (const match of text.matchAll(/\.toMatchObject\s*\(/g)) {
    const at = match.index
    const open = at + match[0].length - 1
    const close = closing(text, open)
    if (close === -1) {
      continue
    }
    const argument = text.slice(open + 1, close).trim()
    const line = text.slice(0, at).split('\n').length
    // The received value: back over `.not`, `.resolves`, `.rejects` to `expect( … )`.
    const before = text.slice(0, at).replace(/(?:\s*\.\s*(?:not|resolves|rejects))+\s*$/, '')
    const end = before.trimEnd().length - 1
    const start = before[end] === ')' ? opening(before, end) : -1
    const received =
      start !== -1 && /\bexpect\s*$/.test(before.slice(0, start))
        ? before.slice(start + 1, end).trim()
        : null
    const wraps = (side: string) => /^comparable\s*\(/.test(side)
    if (wraps(argument)) {
      if (received === null || !wraps(received)) {
        found.push({ line, why: 'comparable() on the expected side only' })
      }
      continue
    }
    const rule = RULES.find((candidate) => candidate.pattern.test(argument))
    if (rule) {
      found.push({ line, why: rule.why })
    }
  }
  return found
}

/** Every file under a directory that Bun's runner can load, sorted. */
function sources(dir: string): string[] {
  if (!existsSync(dir)) {
    return []
  }
  const files: string[] = []
  for (const entry of readdirSync(dir).sort()) {
    if (SKIPPED.has(entry)) {
      continue
    }
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      files.push(...sources(path))
    } else if (/\.tsx?$/.test(entry) && !entry.endsWith('.d.ts')) {
      files.push(path)
    }
  }
  return files
}

describe('the scan', () => {
  const call = (expected: string, received = 'row') =>
    `expect(${received}).toMatchObject(${expected})`

  test.each([
    ['a date made in place', call('{ at: new Date(2) }'), 'an instance'],
    ['a nested date', call('{ session: { user: [{ at: new Date(2) }] } }'), 'an instance'],
    ['the clock', call('{ revokedAt: deps.clock.now() }'), 'a call that answers a Date'],
    ['a helper that answers a date', call('{ x: later(5_000) }'), 'a call that answers a Date'],
    ['a time key with a name under it', call('{ revokedAt: now }'), 'a time-valued key'],
    ['a time key, shorthand', call('{ id, expiresAt }'), 'shorthand'],
    ['a time key after a matcher', call('{ id: expect.any(String), failingSince: t }'), 'time'],
    ['a map', call('{ byId: new Map([[1, 2]]) }'), 'an instance'],
    ['a set', call('{ ids: new Set([1]) }'), 'an instance'],
    ['an error', call('{ cause: new TypeError("x") }'), 'an instance'],
    ['a typed array', call('{ bytes: new Uint8Array(2) }'), 'an instance'],
    ['a regular expression', call('{ pattern: /a+/u }'), 'a regular expression'],
    ['a function', call('{ send: () => 1 }'), 'a function'],
    ['over lines', 'expect(\n  await find(id)\n).toMatchObject({\n  usedAt: at(2),\n})', 'time'],
    ['through resolves', 'await expect(find()).resolves.toMatchObject({ usedAt: t })', 'time'],
    ['negated', 'expect(row).not.toMatchObject({ usedAt: t })', 'time'],
    [
      'only the expected side wrapped',
      call('comparable({ usedAt: t })'),
      'on the expected side only',
    ],
  ])('finds %s', (_name, source, why) => {
    const found = unprotected(source)
    expect(found).toHaveLength(1)
    expect(found[0]?.why).toContain(why)
  })

  test.each([
    ['both sides through comparable()', call('comparable({ usedAt: t })', 'comparable(row)')],
    [
      'both sides, over lines',
      'expect(\n  comparable(await find(id))\n).toMatchObject(\n  comparable({ usedAt: new Date(2) })\n)',
    ],
    ['no time', call("{ status: 'approved', count: 2, ok: true }")],
    ['a time that is not set', call('{ revokedAt: null, usedAt: undefined }')],
    ['a time as a string', call("{ expiresAt: '2026-01-01T00:00:00.000Z', at: `x` }")],
    ['a time behind a matcher', call('{ createdAt: expect.any(String) }')],
    ['a time as a number', call('{ issuedAt: 1700000000, notBefore: -1 }')],
    ['a word that only ends like a key', call('{ format: x, concat: y, treat: z }')],
    ['a date inside a string', call("{ note: 'new Date(2) at revokedAt: now' }")],
    ['a date inside a comment', call('{\n  // revokedAt: new Date(2)\n  id,\n}')],
    ['a regular expression in the received value', call('{ id }', 'text.replace(/a(/, "")')],
    ['a property read that ends like a key', call('{ id: row.createdAt.id }')],
    ['the clock as a string', call('{ at: deps.clock.now().toISOString() }')],
    ['a time key with an ISO string made in place', call('{ usedAt: now().toISOString(), id }')],
    ['the clock inside a number', call('{ iat: Math.floor(deps.clock.now().getTime() / 1000) }')],
    ['a pattern handed to a matcher', call('{ token: expect.stringMatching(/^tula_at_/) }')],
    ['another matcher with a date', 'expect(row).toEqual({ at: new Date(2) })'],
    ['the matcher named in a string', "const name = 'x.toMatchObject({ at: new Date(2) })'"],
  ])('passes %s', (_name, source) => {
    expect(unprotected(source)).toEqual([])
  })

  test('reports the line of the call, and every call of a file', () => {
    const source = [
      'expect(a).toMatchObject({ id })',
      'expect(',
      '  b',
      ').toMatchObject({ usedAt: t })',
      'expect(c).toMatchObject({ at: new Date(1) })',
    ].join('\n')
    expect(unprotected(source).map((finding) => finding.line)).toEqual([4, 5])
  })

  test('a quote inside a regular expression does not hide the calls after it', () => {
    const source = `const cleaned = text.replace(/['"]/g, '')\n${call('{ usedAt: t }')}`
    expect(unprotected(source)).toHaveLength(1)
  })

  test('code inside a template is still read', () => {
    const source = `const line = \`\${JSON.stringify({ a: 1 })} it's\`\n${call('{ usedAt: t }')}`
    expect(unprotected(source)).toHaveLength(1)
  })
})

describe('what the matcher compares on this Bun', () => {
  const matches = (received: unknown, expected: unknown): boolean => {
    try {
      expect({ value: received }).toMatchObject({ value: expected })
      return true
    } catch {
      return false
    }
  }

  // The reason for the guard. When a row here starts to fail, Bun compares that kind: take
  // it out of the rules above (and, once dates are compared, decide whether the guard and
  // `comparable()` are still needed).
  test.each([
    ['two dates', new Date(1), new Date(2)],
    ['two maps', new Map([['a', 1]]), new Map([['a', 2]])],
    ['two sets', new Set([1]), new Set([2])],
    ['two regular expressions', /a/, /b/],
    ['two errors', new Error('a'), new Error('b')],
    ['two functions', () => 1, () => 2],
    ['two sets of search parameters', new URLSearchParams('a=1'), new URLSearchParams('a=2')],
    ['two sets of headers', new Headers({ a: '1' }), new Headers({ a: '2' })],
    ['two buffers', new Uint8Array([1]).buffer, new Uint8Array([2]).buffer],
    ['typed arrays of two lengths', new Uint8Array([1, 2]), new Uint8Array([1])],
  ])('%s that differ match', (_name, received, expected) => {
    expect(matches(received, expected)).toBe(true)
    expect(() => expect({ value: received }).toEqual({ value: expected })).toThrow()
  })

  test.each([
    ['a date and a string', new Date(1), '1970-01-01T00:00:00.001Z'],
    ['a string and a date', '1970-01-01T00:00:00.001Z', new Date(1)],
    ['nothing and a date', null, new Date(1)],
    ['two addresses', new URL('https://a.example/'), new URL('https://b.example/')],
    ['typed arrays of one length', new Uint8Array([1, 2]), new Uint8Array([3, 4])],
    ['two big integers', 1n, 2n],
    ['two ISO strings', new Date(1).toISOString(), new Date(2).toISOString()],
  ])('%s that differ do not match', (_name, received, expected) => {
    expect(matches(received, expected)).toBe(false)
  })
})

describe('the repository', () => {
  test('no toMatchObject holds a value it does not compare', () => {
    const findings: string[] = []
    let calls = 0
    for (const dir of ROOTS) {
      for (const path of sources(join(root, dir))) {
        const name = relative(root, path)
        if (NOT_BUN.some((prefix) => name.startsWith(prefix))) {
          continue
        }
        const source = readFileSync(path, 'utf8')
        calls += source.split('.toMatchObject(').length - 1
        for (const finding of unprotected(source)) {
          findings.push(`${name}:${finding.line}  ${finding.why}`)
        }
      }
    }
    // The scan found the calls at all: a walk that reads nothing would pass for ever.
    expect(calls).toBeGreaterThan(1000)
    expect(
      findings,
      'Bun does not compare these inside toMatchObject. Pass both sides through comparable() ' +
        '(apps/api/src/testing/comparable.ts), use toEqual, or assert on the time itself.'
    ).toEqual([])
  })
})
