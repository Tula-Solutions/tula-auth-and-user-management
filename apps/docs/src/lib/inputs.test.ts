import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fakeEnvironment } from '../testing/environment'
import { CACHED_TASKS, checkCacheInputs, covers, TURBO_FILE, uncovered } from './inputs'
import { createCodeHighlighter, parseMarkdown, RenderError, renderMarkdown } from './markdown'

// The real file is read, so that the guard is tried against the inputs the app runs with; the
// links of the real pages are checked against it by the build (`generate:check`).
const turbo = readFileSync(join(import.meta.dir, '../../turbo.json'), 'utf8')
const inputsOf = (task: string) =>
  (JSON.parse(turbo) as { tasks: Record<string, { inputs: string[] }> }).tasks[task]?.inputs ?? []

/** A `turbo.json` whose tasks all name `inputs`, or the given ones. */
function turboWith(
  inputs: string[],
  override: Record<string, string[]> = {},
  tasks: readonly string[] = CACHED_TASKS
): string {
  return JSON.stringify({
    tasks: Object.fromEntries(tasks.map((task) => [task, { inputs: override[task] ?? inputs }])),
  })
}

const notADirectory = () => false

describe('covers and uncovered', () => {
  test('a glob relative to the repository matches a file, and a directory by what is under it', () => {
    const inputs = ['$TURBO_DEFAULT$', '$TURBO_ROOT$/packages/*/README.md', '$TURBO_ROOT$/docs/**']
    expect(covers(inputs, 'packages/core/README.md', notADirectory)).toBe(true)
    expect(covers(inputs, 'packages/core/src/a.ts', notADirectory)).toBe(false)
    expect(covers(inputs, 'docs/guides', () => true)).toBe(true)
    expect(covers(inputs, 'packages/core', () => true)).toBe(false)
    expect(uncovered(inputs, ['docs/a.md', 'apps/x/y.ts'], notADirectory)).toEqual(['apps/x/y.ts'])
  })

  test('an input that is not relative to the repository covers nothing outside the app', () => {
    expect(covers(['$TURBO_DEFAULT$', 'src/**'], 'packages/core/README.md', notADirectory)).toBe(
      false
    )
  })
})

describe('checkCacheInputs', () => {
  const inputs = ['$TURBO_DEFAULT$', '$TURBO_ROOT$/*.md', '$TURBO_ROOT$/packages/*/README.md']

  test('passes when every task matches every file outside docs/ that a page links to', () => {
    expect(() =>
      checkCacheInputs(
        turboWith(inputs),
        ['README.md', 'packages/core/README.md', 'docs/a.md'],
        notADirectory
      )
    ).not.toThrow()
  })

  test('fails, naming the file and the task, for a link no input matches', () => {
    expect(() =>
      checkCacheInputs(turboWith(inputs), ['packages/zzz/src/a.ts'], notADirectory)
    ).toThrow(`${TURBO_FILE}: no input of task transit matches packages/zzz/src/a.ts`)
  })

  test('fails for a task whose list lacks the glob the others have', () => {
    const lacking = { 'test:coverage': ['$TURBO_DEFAULT$', '$TURBO_ROOT$/*.md'] }
    expect(() =>
      checkCacheInputs(turboWith(inputs, lacking), ['README.md'], notADirectory)
    ).toThrow('task test:coverage names other inputs than transit')
  })

  test('fails for a file that is not the five cached tasks', () => {
    expect(() =>
      checkCacheInputs(turboWith(inputs, {}, ['transit', 'build']), [], notADirectory)
    ).toThrow(RenderError)
    expect(() => checkCacheInputs('{ not json', [], notADirectory)).toThrow('cannot be read')
  })

  test('a directory is matched by what is under it', () => {
    const only = ['$TURBO_ROOT$/packages/zzz/**']
    expect(() => checkCacheInputs(turboWith(only), ['packages/zzz'], () => true)).not.toThrow()
    expect(() => checkCacheInputs(turboWith(only), ['packages/yyy'], () => true)).toThrow(
      'packages/yyy'
    )
  })

  test('the real file names the same inputs for every cached task', () => {
    const first = inputsOf('transit')
    expect(first.length).toBeGreaterThan(0)
    for (const task of CACHED_TASKS) {
      expect(inputsOf(task), task).toEqual(first)
    }
    expect(() => checkCacheInputs(turbo, [], notADirectory)).not.toThrow()
  })

  test('catches a link the renderer reads in any syntax the inputs do not match', async () => {
    const fixture = fakeEnvironment({
      'docs/a.md': new Set(['t']),
      'packages/zzz/src/a.ts': null,
      'packages/zzz/src/b.ts': null,
    })
    const doc = parseMarkdown(
      'docs/a.md',
      "# T\n\n[x]\n\n<a href='../packages/zzz/src/b.ts'>y</a>\n\n[x]: ../packages/zzz/src/a.ts\n"
    )
    const { files } = renderMarkdown(doc, fixture, await createCodeHighlighter())
    expect([...new Set(files)].sort()).toEqual(['packages/zzz/src/a.ts', 'packages/zzz/src/b.ts'])
    expect(() => checkCacheInputs(turbo, files, notADirectory)).toThrow(
      'packages/zzz/src/a.ts, packages/zzz/src/b.ts'
    )
  })
})
