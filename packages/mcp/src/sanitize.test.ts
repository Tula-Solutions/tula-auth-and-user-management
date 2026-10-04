import { describe, expect, test } from 'bun:test'
import {
  bound,
  cleanText,
  inputWindow,
  MAX_COMBINING_MARKS,
  MAX_OUTPUT_CHARS,
  MAX_STRING_CHARS,
  project,
  REDACTED,
  redactor,
  S,
} from './sanitize'
import { ALL_HIDDEN, forbiddenCodePoints, HIDDEN, LEGITIMATE } from './testing/hidden'

describe('cleanText', () => {
  test.each([
    ['control characters become spaces', 'a\u0000b\u001b[2Jc\nd\u0085e', 'a b [2Jc d e'],
    [
      'bidirectional overrides and zero-width characters are removed',
      'a\u{202E}b\u{200B}c\u{2066}d\u{FEFF}',
      'abcd',
    ],
    ['ordinary text is kept', 'Maya Lin — ünïcode', 'Maya Lin — ünïcode'],
  ])('%s', (_name, input, expected) => {
    expect(cleanText(input, 100)).toBe(expected)
  })

  test('a long string is cut at the cap and says so', () => {
    const text = cleanText('x'.repeat(MAX_STRING_CHARS + 50))
    expect(text.length).toBeLessThanOrEqual(MAX_STRING_CHARS + 1)
    expect(text.endsWith('…')).toBe(true)
  })

  test('the cut never leaves half a surrogate pair', () => {
    const text = cleanText(`${'x'.repeat(9)}😀😀`, 10)
    expect(forbiddenCodePoints(text)).toEqual([])
    expect(text).toBe(`${'x'.repeat(9)}…`)
  })

  test.each([
    ['a secret key', `tula_sk_live_${'a'.repeat(32)}`],
    ['a secret key inside text', `key is tula_sk_dev_${'b'.repeat(20)} ok`],
    ['a JWT', 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlLXNpZ25hdHVyZQ'],
    ['a JWT glued to other text', 'token_eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlLXNp'],
    ['a JWT after a short lookalike', 'eyJ.eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlLXNp'],
    ['an argon2 hash', '$argon2id$v=19$m=65536,t=2,p=1$c2FsdA$aGFzaA'],
    ['an otpauth URI', 'otpauth://totp/App:maya?secret=JBSWY3DPEHPK3PXP'],
    ['a PEM block', '-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----'],
  ])('%s is replaced, whatever field it arrived in', (_name, input) => {
    const text = cleanText(input, 500)
    expect(text).toContain(REDACTED)
    expect(text).not.toContain('aaaaaaaa')
    expect(text).not.toContain('bbbbbbbb')
    expect(text).not.toContain('JBSWY3DPEHPK3PXP')
    expect(text).not.toContain('MIIB')
    expect(text).not.toContain('c2lnbmF0dXJl')
    expect(text).not.toContain('aGFzaA')
    expect(text).not.toContain('eyJzdWIi')
  })

  test('text that only looks like the start of a JWT is kept', () => {
    expect(cleanText('eyJ is how a JWT starts. a.b.c')).toBe('eyJ is how a JWT starts. a.b.c')
    expect(cleanText('eyJhbGciOiJ.short.x')).toBe('eyJhbGciOiJ.short.x')
  })
})

describe('characters a reader cannot see', () => {
  test.each(HIDDEN)('%s is not returned by cleanText', (_name, hidden) => {
    const text = cleanText(`Ma${hidden}ya`)
    expect(forbiddenCodePoints(text)).toEqual([])
    // What was around it is still there (a separator becomes a space, like a newline).
    expect(text.replaceAll(' ', '')).toBe('Maya')
  })

  test.each(HIDDEN)(
    '%s is not returned by a projection of a user or a session',
    (_name, hidden) => {
      const user = project(
        { id: 'u1', firstName: `Ma${hidden}ya`, lastName: `${hidden}Lin${hidden}` },
        S.object({ id: S.string(64), firstName: S.string(), lastName: S.string() })
      ) as { firstName: string; lastName: string }
      const session = project(
        { userAgent: `Mozilla/5.0 ${hidden}(Macintosh)${hidden}` },
        S.object({ userAgent: S.string(256) })
      ) as { userAgent: string }
      expect(forbiddenCodePoints(JSON.stringify([user, session]))).toEqual([])
      expect(user.firstName.replaceAll(' ', '')).toBe('Maya')
      expect(user.lastName.trim()).toBe('Lin')
      expect(session.userAgent.replaceAll(' ', '')).toBe('Mozilla/5.0(Macintosh)')
    }
  )

  test('every hidden character at once, in a record’s key too', () => {
    const all = ALL_HIDDEN
    const out = project(
      { [`we${all}b`]: { ttl: `60${all}s` } },
      S.record(S.object({ ttl: S.string() }), 5)
    )
    expect(forbiddenCodePoints(JSON.stringify(out))).toEqual([])
  })

  test.each(LEGITIMATE)('%s survive unchanged', (_name, input) => {
    expect(cleanText(input)).toBe(input)
    expect(forbiddenCodePoints(cleanText(input))).toEqual([])
  })

  test.each([
    ['a family joined by zero-width joiners comes apart', '👨\u{200D}👩\u{200D}👧', '👨👩👧'],
    ['an emoji-style heart loses its selector', '\u{2764}\u{FE0F}', '\u{2764}'],
    ['a keycap keeps its digit and its cap', '1\u{FE0F}\u{20E3}', '1\u{20E3}'],
    ['a flag made of tags keeps only its base', '🏴\u{E0067}\u{E0062}\u{E007F}', '🏴'],
    ['right-to-left text keeps its letters and loses the mark', 'אב\u{200F}ג', 'אבג'],
  ])('%s', (_name, input, expected) => {
    expect(cleanText(input)).toBe(expected)
  })

  test('a flood of combining marks is capped; the letter and the first marks stay', () => {
    const flooded = `a${'\u{301}'.repeat(200)}b${'\u{489}\u{338}'.repeat(100)}`
    const text = cleanText(flooded)
    expect(text).toBe(
      `a${'\u{301}'.repeat(MAX_COMBINING_MARKS)}b${'\u{489}\u{338}'.repeat(MAX_COMBINING_MARKS / 2)}`
    )
    // A stack as tall as real text uses is untouched.
    const stacked = `e${'\u{301}\u{323}\u{302}\u{308}'}`
    expect(cleanText(stacked)).toBe(stacked)
  })
})

describe('a secret split by characters a reader cannot see', () => {
  const KEY_BODY = 'abcdefghijklmnopqrstuvwxyz012345'
  const SPLITTERS: readonly (readonly [string, string])[] = [
    ['a zero-width space', '\u{200B}'],
    ['a tag character', '\u{E0041}'],
    ['a soft hyphen', '\u{AD}'],
    ['a variation selector', '\u{FE0F}'],
    ['a braille blank', '\u{2800}'],
    ['a Khmer inherent vowel', '\u{17B4}'],
  ]
  const split = (text: string, at: number, splitter: string) =>
    `${text.slice(0, at)}${splitter}${text.slice(at)}`

  describe.each(SPLITTERS)('by %s', (_name, splitter) => {
    test.each([
      ['a secret key, in its body', split(`tula_sk_live_${KEY_BODY}`, 16, splitter)],
      ['a secret key, in its prefix', split(`tula_sk_live_${KEY_BODY}`, 4, splitter)],
      [
        'a JWT',
        split('eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlLXNpZ25hdHVyZQ', 28, splitter),
      ],
      [
        'a JWT, between every character',
        Array.from('eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlLXNpZ25hdHVyZQ').join(
          splitter
        ),
      ],
      [
        'a PEM block, in its header',
        split(
          '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----',
          14,
          splitter
        ),
      ],
      [
        'a PEM block, in its footer',
        split(
          '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----',
          50,
          splitter
        ),
      ],
    ])('%s is redacted with no remainder', (_what, input) => {
      expect(cleanText(input)).toBe(REDACTED)
    })
  })
})

describe('a secret split by a control character or a line separator', () => {
  const KEY = `tula_sk_live_${'abcdefghijklmnopqrstuvwxyz012345'}`
  const JWT = 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlLXNpZ25hdHVyZQ'
  const PEM = '-----BEGIN PRIVATE KEY----- MIIEvQIBADANBg -----END PRIVATE KEY-----'
  const SPLITTERS: readonly (readonly [string, string])[] = [
    ['a control character', '\u{0001}'],
    ['a newline', '\n'],
    ['a line separator', '\u{2028}'],
  ]
  const split = (text: string, at: number, splitter: string) =>
    `${text.slice(0, at)}${splitter}${text.slice(at)}`

  describe.each(SPLITTERS)('by %s', (_name, splitter) => {
    test.each([
      ['a secret key, early in its body', split(KEY, 16, splitter)],
      ['a secret key, late in its body', split(KEY, 30, splitter)],
      ['a secret key, in its prefix', split(KEY, 4, splitter)],
      ['a secret key, between every character', Array.from(KEY).join(splitter)],
      ['a JWT, in its first part', split(JWT, 8, splitter)],
      ['a JWT, in its signature', split(JWT, 50, splitter)],
      ['a PEM block, in its opening dashes', split(PEM, 2, splitter)],
      ['a PEM block, in its body', split(PEM, 34, splitter)],
    ])('%s is redacted with no remainder', (_what, input) => {
      expect(cleanText(input)).toBe(REDACTED)
    })

    test('only the secret goes: the words around it stay', () => {
      expect(cleanText(`key ${split(KEY, 30, splitter)} for Maya`)).toBe(`key ${REDACTED} for Maya`)
    })

    test('a key the window cut, split before the cut, is not returned', () => {
      const window = inputWindow(MAX_STRING_CHARS)
      const text = cleanText(
        `Maya ${'\u{200B}'.repeat(window - 5 - 14)}tula_${splitter}sk_live_kkkkkkkk`
      )
      expect(text).not.toContain('sk_')
      expect(text.startsWith('Maya ')).toBe(true)
    })
  })

  test.each([
    [
      'lines of a note',
      'Dear Maya,\nyour order has shipped.\r\nThanks',
      'Dear Maya, your order has shipped.  Thanks',
    ],
    ['a tab between words', 'first\tsecond', 'first second'],
    ['a line separator between sentences', 'One.\u{2028}Two.', 'One. Two.'],
    [
      'words that only together look like a prefix',
      'tula_\nsk_ is how a key starts',
      'tula_ sk_ is how a key starts',
    ],
  ])('%s with no secret change only by the control-to-space rule', (_name, input, expected) => {
    expect(cleanText(input)).toBe(expected)
  })
})

describe('the work is bounded', () => {
  const PATHOLOGICAL: readonly (readonly [string, string])[] = [
    ['the start of a JWT, repeated', 'eyJ'.repeat(200_000)],
    ['JWT segments that never finish', 'eyJaaaaa.'.repeat(70_000).replaceAll('.', '!')],
    ['the start of a secret key, repeated', 'tula_sk_a'.repeat(70_000)],
    ['a secret key’s prefix with no end', `tula_sk_${'a'.repeat(600_000)}`],
    ['the start of a hash, repeated', '$argon2id$2b'.repeat(50_000)],
    ['the start of an authenticator URI, repeated', 'otpauth://'.repeat(60_000)],
    ['PEM headers that never close', '-----BEGIN A'.repeat(50_000)],
    [
      'a PEM block with footers that never close',
      `-----BEGIN A-----${'-----END A'.repeat(60_000)}`,
    ],
    ['a flood of combining marks', `a${'\u{301}'.repeat(600_000)}`],
    ['a flood of zero-width characters', '\u{200B}'.repeat(600_000)],
    ['a flood of lone surrogates', '\uD83D'.repeat(600_000)],
    ['a flood of control characters', '\u{0001}'.repeat(600_000)],
    ['the start of a secret key, split by newlines, repeated', 'tula_\nsk_a'.repeat(60_000)],
    ['the start of a JWT, split by controls, repeated', 'e\u{0001}yJ.'.repeat(120_000)],
    ['PEM headers split by newlines that never close', '---\n--BEGIN A'.repeat(50_000)],
  ]

  /** The fastest of three runs: a pause of the garbage collector is not the code's time. */
  function fastest(work: () => void): number {
    let best = Number.POSITIVE_INFINITY
    for (let run = 0; run < 3 && best >= 100; run += 1) {
      const started = performance.now()
      work()
      best = Math.min(best, performance.now() - started)
    }
    return best
  }

  /** The fastest of five runs, all of them taken: for comparing two sizes with each other. */
  function quickest(work: () => void): number {
    let best = Number.POSITIVE_INFINITY
    for (let run = 0; run < 5; run += 1) {
      const started = performance.now()
      work()
      best = Math.min(best, performance.now() - started)
    }
    return best
  }

  test.each(PATHOLOGICAL)('%s is cleaned in under 100 ms', (_name, input) => {
    expect(fastest(() => cleanText(input))).toBeLessThan(100)
    expect(cleanText(input).length).toBeLessThanOrEqual(MAX_STRING_CHARS + 1)
  })

  // With a cap so large that the window does not cut: each pattern is linear by itself, and
  // does not depend on the window to be fast.
  //
  // Measured as a ratio, not against the clock: a runner under coverage is forty times slower
  // than a laptop, and that says nothing about the pattern. Thirty-two times the input costs
  // thirty-two times the work when the pattern is linear and a thousand when it is quadratic;
  // the limit sits a factor of ten from both, because a runner's ratio is itself noisy (a
  // linear pattern has measured seven times its own on one).
  test.each(PATHOLOGICAL)(
    '%s costs time in proportion to its length, not its square',
    (_name, input) => {
      const large = input.slice(0, 400_000)
      const small = large.slice(0, Math.floor(large.length / 32))
      // A floor of a millisecond: below it the timer's own noise is the measurement.
      const base = Math.max(
        quickest(() => cleanText(small, 1_000_000)),
        1
      )
      expect(quickest(() => cleanText(large, 1_000_000))).toBeLessThan(base * 320)
    }
  )

  test('the window is four times the cap, and never under 4096 characters', () => {
    expect(inputWindow(MAX_STRING_CHARS)).toBe(4096)
    expect(inputWindow(64)).toBe(4096)
    expect(inputWindow(2000)).toBe(8000)
  })

  test('what lies past the window is dropped, and the result says it was cut', () => {
    const window = inputWindow(MAX_STRING_CHARS)
    const text = cleanText(
      `${'\u{200B}'.repeat(window - 4)}Maya and a tail that is past the window`
    )
    expect(text).toBe('Maya…')
  })

  const KEY = `tula_sk_live_${'k'.repeat(40)}`
  const JWT = 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ1c2VyIn0.c2lnbmF0dXJlc2lnbmF0dXJl'
  const PEM =
    '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----'

  test.each([
    ['a secret key cut in its body', KEY, 17, ['kkk']],
    ['a secret key cut after its body began to match', KEY, 30, ['kkk']],
    ['a JWT cut in its first segment', JWT, 12, ['hbGci']],
    ['a JWT cut in its second segment', JWT, 30, ['hbGci', 'zdWIi']],
    ['a JWT cut in its signature', JWT, 44, ['hbGci', 'zdWIi', 'c2ln']],
    ['a PEM block cut in its body', PEM, 40, ['MIIE']],
    [
      'a hash cut in the middle',
      '$argon2id$v=19$m=65536,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2g',
      48,
      ['c2FsdHNhbHQ'],
    ],
    [
      'an authenticator URI cut in its secret',
      'otpauth://totp/App:maya?secret=JBSWY3DPEHPK3PXP',
      38,
      ['JBSW'],
    ],
  ])('%s by the window’s edge is not returned', (_name, secret, kept, pieces) => {
    const window = inputWindow(MAX_STRING_CHARS)
    // Invisible padding, so that the cleaned text is short and its end would be returned.
    const input = `Maya ${'\u{200B}'.repeat(window - 5 - kept)}${secret}`
    const text = cleanText(input)
    for (const piece of pieces) {
      expect(text).not.toContain(piece)
    }
    expect(text.startsWith('Maya ')).toBe(true)
    expect(text.endsWith('…')).toBe(true)
  })
})

describe('project', () => {
  const shape = S.object({
    id: S.string(),
    count: S.number,
    on: S.boolean,
    tags: S.array(S.string(10), 2),
    inner: S.object({ name: S.string() }),
    byName: S.record(S.object({ ttl: S.string() }), 2),
  })

  test('named fields are kept, everything else is dropped', () => {
    expect(
      project(
        {
          id: 'a',
          count: 2,
          on: true,
          tags: ['x', 'y', 'z'],
          inner: { name: 'n', secret: 's' },
          byName: { web: { ttl: '60s', extra: 1 }, mobile: { ttl: '5m' }, third: { ttl: '1h' } },
          passwordHash: 'h',
        },
        shape
      )
    ).toEqual({
      id: 'a',
      count: 2,
      on: true,
      tags: ['x', 'y'],
      inner: { name: 'n' },
      byName: { web: { ttl: '60s' }, mobile: { ttl: '5m' } },
    })
  })

  test('null is kept; a value of the wrong type is dropped, never passed through', () => {
    expect(
      project({ id: null, count: '7', on: 'yes', tags: 'x', inner: ['a'], byName: null }, shape)
    ).toEqual({ id: null, byName: null })
  })

  test('an array drops entries of the wrong type', () => {
    expect(project(['a', { b: 1 }, 3, 'c'], S.array(S.string()))).toEqual(['a', 'c'])
  })

  test('a number that is not finite is dropped', () => {
    expect(project({ count: Number.NaN }, S.object({ count: S.number }))).toEqual({})
  })

  test('a record key is cleaned like any other text and a prototype key is refused', () => {
    const value = JSON.parse('{"__proto__": {"ttl": "x"}, "we\\u0000b": {"ttl": "1"}}')
    const out = project(value, S.record(S.object({ ttl: S.string() }), 5)) as Record<
      string,
      unknown
    >
    expect(out).toEqual({ 'we b': { ttl: '1' }, truncated: true })
  })

  const PROFILES = S.record(S.object({ ttl: S.string() }), 5)

  test.each([
    ['__proto__', '__pro\u{200B}to__'],
    ['constructor', 'constr\u{200B}uctor'],
    ['prototype', 'proto\u{E0041}type'],
  ])('a key that is %s only once it is cleaned is refused, and the record says so', (name, key) => {
    const out = project({ [key]: { ttl: 'x' }, web: { ttl: '60s' } }, PROFILES) as Record<
      string,
      unknown
    >
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect(Object.hasOwn(out, name)).toBe(false)
    // Nothing reached the prototype: a field of the refused entry is not readable through it.
    expect((out as { ttl?: unknown }).ttl).toBeUndefined()
    expect(out).toEqual({ web: { ttl: '60s' }, truncated: true })
    expect(JSON.parse(JSON.stringify(out))).toEqual({ web: { ttl: '60s' }, truncated: true })
  })

  test('two keys that are the same once cleaned: the first is kept and the record says so', () => {
    const prefix = 'p'.repeat(64)
    const out = project(
      {
        [`${prefix}-first`]: { ttl: '1' },
        [`${prefix}-second`]: { ttl: '2' },
        'we\u{200B}b': { ttl: '3' },
        web: { ttl: '4' },
        mobile: { ttl: '5' },
      },
      PROFILES
    )
    expect(out).toEqual({
      [`${prefix}…`]: { ttl: '1' },
      web: { ttl: '3' },
      mobile: { ttl: '5' },
      truncated: true,
    })
  })

  test('a record that lost no key carries no mark, and the mark’s own name is not a key', () => {
    expect(project({ web: { ttl: '1' } }, PROFILES)).toEqual({ web: { ttl: '1' } })
    expect(project({ truncated: { ttl: '1' }, web: { ttl: '2' } }, PROFILES)).toEqual({
      web: { ttl: '2' },
      truncated: true,
    })
  })

  test('a key dropped for its name does not use up a place', () => {
    const out = project(
      { a: { ttl: '1' }, 'a\u{200B}': { ttl: '2' }, b: { ttl: '3' } },
      S.record(S.object({ ttl: S.string() }), 2)
    )
    expect(out).toEqual({ a: { ttl: '1' }, b: { ttl: '3' }, truncated: true })
  })

  test('something that is not an object projects to nothing', () => {
    expect(project('text', shape)).toBeUndefined()
    expect(project(undefined, shape)).toBeUndefined()
  })
})

describe('bound', () => {
  test('a small output is returned as it is', () => {
    const output = { data: [{ id: '1' }] }
    expect(bound(output)).toEqual(output)
  })

  test('a list too large for the cap loses entries from the end and says so', () => {
    const data = Array.from({ length: 400 }, (_, index) => ({
      id: String(index),
      text: 'x'.repeat(400),
    }))
    const out = bound({ meta: { page: 1 }, data })
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS)
    expect(out.truncated).toBe(true)
    const kept = out.data as { id: string }[]
    expect(kept.length).toBeGreaterThan(0)
    expect(kept.length).toBeLessThan(400)
    expect(kept[0]?.id).toBe('0')
  })

  test('an output with no list that is still too large is replaced by an error', () => {
    const out = bound({ big: 'x'.repeat(MAX_OUTPUT_CHARS + 10) })
    expect(out).toEqual({
      error: { code: 'output.too_large', message: expect.any(String) },
    })
  })
})

describe('redactor', () => {
  test('a key named for the prototype stays an own key and leaves the prototype alone', () => {
    const redact = redactor(['hunter2hunter2'])
    const out: Record<string, unknown> = redact(
      JSON.parse('{"__proto__": {"a": "hunter2hunter2"}}')
    )
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect(Object.hasOwn(out, '__proto__')).toBe(true)
    expect(JSON.stringify(out)).toBe(`{"__proto__":{"a":"${REDACTED}"}}`)
  })

  test('a key that holds a configured secret is redacted too', () => {
    const redact = redactor(['hunter2hunter2'])
    const out: Record<string, unknown> = redact({ 'profile-hunter2hunter2': { ttl: '60s' } })
    expect(out).toEqual({ [`profile-${REDACTED}`]: { ttl: '60s' } })
  })

  test('every configured secret is replaced wherever it appears, at any depth', () => {
    const redact = redactor(['hunter2hunter2', '', 'tok'])
    expect(
      redact({ a: 'x hunter2hunter2 y', b: [{ c: 'hunter2hunter2' }], d: 3, e: null, f: 'tok' })
    ).toEqual({ a: `x ${REDACTED} y`, b: [{ c: REDACTED }], d: 3, e: null, f: 'tok' })
  })

  test('many secrets over a large value stay fast', () => {
    const redact = redactor(Array.from({ length: 4 }, (_, index) => `secret-${index}-value`))
    const value = { a: 'secret-0-valu'.repeat(MAX_OUTPUT_CHARS / 13) }
    const started = performance.now()
    redact(value)
    expect(performance.now() - started).toBeLessThan(100)
  })
})
