import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { Glob } from 'bun'

// H-247: a parity suite only catches scoping drift if both adapters of its port run it. A new
// `*.suite.ts` that only the memory adapter imports (or that nobody imports) is dead weight.
const dir = import.meta.dir
const suites = [...new Glob('*.suite.ts').scanSync(dir)].sort()
const tests = [...new Glob('**/*.{test,integration}.ts').scanSync(dir)]
  .filter((file) => file !== 'suites.test.ts')
  .map((file) => ({ file, source: readFileSync(`${dir}/${file}`, 'utf8') }))

/** The test files that import `suite` (`~/adapters/<name>.suite`). */
function importers(suite: string): string[] {
  const name = suite.replace(/\.ts$/, '')
  return tests.filter(({ source }) => source.includes(`/${name}'`)).map(({ file }) => file)
}

describe('adapter suites run on more than one adapter (H-247)', () => {
  test('there are suites to check', () => {
    expect(suites.length).toBeGreaterThan(20)
  })

  test.each(suites)('%s is run by the memory adapter and by another one', (suite) => {
    const files = importers(suite)
    expect(files.some((file) => file.startsWith('memory/'))).toBe(true)
    expect(files.some((file) => !file.startsWith('memory/'))).toBe(true)
  })
})
