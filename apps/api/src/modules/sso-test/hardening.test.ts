import { describe, expect, test } from 'bun:test'
import { Glob } from 'bun'

const CALL = 'SsoTests.start('

/**
 * The top-level arguments of every `SsoTests.start(` call in a source text.
 *
 * Commas count only at depth zero of (), [] and {}, so `{ a, b }` or `f(x, y)` is one argument.
 * shortcut: string and comment contents are not skipped; no caller writes a bracket in a string.
 */
function startArguments(text: string): string[][] {
  const calls: string[][] = []
  for (let at = text.indexOf(CALL); at !== -1; at = text.indexOf(CALL, at + CALL.length)) {
    const args: string[] = []
    let depth = 0
    let from = at + CALL.length
    for (let i = from; i < text.length; i++) {
      const char = text[i]
      if ('([{'.includes(char as string)) {
        depth++
      } else if (')]}'.includes(char as string)) {
        if (depth === 0) {
          args.push(text.slice(from, i))
          break
        }
        depth--
      } else if (char === ',' && depth === 0) {
        args.push(text.slice(from, i))
        from = i + 1
      }
    }
    calls.push(args.map((arg) => arg.replace(/\s+/g, ' ').trim()).filter((arg) => arg !== ''))
  }
  return calls
}

describe('startArguments', () => {
  test('finds every call and splits only at the call’s own depth', () => {
    const text = `a(SsoTests.start(d, { x, y }, f(1, 2), [p, q], u, true))
      b(SsoTests.start(d, e, g, h, i, redirectUrl === undefined,))`
    expect(startArguments(text)).toEqual([
      ['d', '{ x, y }', 'f(1, 2)', '[p, q]', 'u', 'true'],
      ['d', 'e', 'g', 'h', 'i', 'redirectUrl === undefined'],
    ])
  })
})

/**
 * H-019: `serverBuilt` skips the environment's redirect-URL list, so it may only be set where the
 * address is the server's own. Pinned by reading the sources: a new caller that passes it fails here.
 */
describe('SsoTests.start serverBuilt (H-019)', () => {
  test('only the setup portal and the admin route with no address sent pass it', async () => {
    const root = `${import.meta.dir}/../..`
    const passing: Record<string, string> = {}
    for await (const file of new Glob('**/*.ts').scan(root)) {
      if (file.endsWith('.test.ts')) {
        continue
      }
      const calls = startArguments(await Bun.file(`${root}/${file}`).text())
      calls.forEach((args, index) => {
        if (args.length > 5) {
          passing[`${file}#${index}`] = args.slice(5).join(', ')
        }
      })
    }
    expect(passing).toEqual({
      'modules/setup-link/portal.ts#0': 'true',
      'modules/sso-connection/router.ts#0': 'redirectUrl === undefined',
    })
  })
})
