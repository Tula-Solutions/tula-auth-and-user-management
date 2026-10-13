import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// `AGENTS.md` is read whole at the start of every session of every agent. At 422 KB it was
// most of a context window before any work began, and an agent that read a second large
// file died of it. So it holds what every change has to know, and the rules of one area are
// in that area's file under `.claude/rules/`, loaded when a matching file is touched. This
// test keeps the first small and the second findable. It spawns nothing.

const root = resolve(import.meta.dir, '../..')
const rules = join(root, '.claude/rules')

/** The most `AGENTS.md` may weigh. A rule that does not fit belongs in its area's file. */
const AGENTS_MAX_BYTES = 70_000

/** The most one area's file may weigh: it is loaded whole too, when its paths are touched. */
const AREA_MAX_BYTES = 65_000

const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8')
const files = readdirSync(rules)
  .filter((name) => name.endsWith('.md'))
  .sort()

describe('the standards document and the area rules', () => {
  test('AGENTS.md stays small enough to be read at the start of every session', () => {
    expect(Buffer.byteLength(agents)).toBeLessThanOrEqual(AGENTS_MAX_BYTES)
  })

  test('there are area rules to check', () => {
    expect(files.length).toBeGreaterThan(30)
  })

  test.each(files)('%s is small enough to be loaded with the files it is about', (name) => {
    expect(Buffer.byteLength(readFileSync(join(rules, name)))).toBeLessThanOrEqual(AREA_MAX_BYTES)
  })

  test.each(files)(
    '%s says which paths it is for, so it is not loaded for every change',
    (name) => {
      const text = readFileSync(join(rules, name), 'utf8')
      const frontMatter = /^---\npaths:\n((?: {2}- "[^"\n]+"\n)+)---\n/.exec(text)?.[1]
      expect(frontMatter).toBeDefined()
    }
  )

  test('every area file is named in AGENTS.md, so an agent that loads no rules finds it', () => {
    const named = new Set<string>()
    for (const match of agents.matchAll(/`\.claude\/rules\/([a-z0-9-]+)\.md`/g)) {
      named.add(`${match[1]}.md`)
    }
    for (const match of agents.matchAll(/`\.claude\/rules\/\{([a-z0-9,-]+)\}\.md`/g)) {
      for (const name of (match[1] as string).split(',')) {
        named.add(`${name}.md`)
      }
    }
    expect(files.filter((name) => !named.has(name))).toEqual([])
    // And the other way round: a row for a file that is gone sends a reader nowhere.
    expect([...named].filter((name) => !files.includes(name)).sort()).toEqual([])
  })

  test('a section lives in one place: no heading of an area file is a heading of AGENTS.md', () => {
    const own = new Set([...agents.matchAll(/^#{2,3} (.+)$/gm)].map((match) => match[1]))
    const twice: string[] = []
    for (const name of files) {
      for (const match of readFileSync(join(rules, name), 'utf8').matchAll(/^## (.+)$/gm)) {
        // An area file names the section its bullets came from ("Security rules …").
        if (
          own.has(match[1] as string) &&
          !/^(Security rules|Testing|Publishable packages)/.test(match[1] as string)
        ) {
          twice.push(`${name}: ${match[1]}`)
        }
      }
    }
    expect(twice).toEqual([])
  })
})
