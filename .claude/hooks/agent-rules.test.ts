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

  /** The globs of a rules file's front matter, or none when it has no well-formed one. */
  function pathsOf(name: string): string[] {
    const text = readFileSync(join(rules, name), 'utf8')
    const frontMatter = /^---\npaths:\n((?: {2}- "[^"\n]+"\n)+)---\n/.exec(text)?.[1] ?? ''
    return [...frontMatter.matchAll(/"([^"]+)"/g)].map((match) => match[1] as string)
  }

  test.each(files)(
    '%s says which paths it is for, so it is not loaded for every change',
    (name) => {
      expect(pathsOf(name).length).toBeGreaterThan(0)
    }
  )

  // A glob that matches nothing loads its rules for nobody: `Dockerfile` did, while the one
  // Dockerfile is `apps/api/Dockerfile`, so whoever changed the image never read its rules.
  test('every path of every area file matches a file the repository tracks', () => {
    const listed = Bun.spawnSync(['git', 'ls-files'], { cwd: root, timeout: 20_000 })
    expect(listed.exitCode).toBe(0)
    const tracked = listed.stdout.toString().split('\n').filter(Boolean)
    expect(tracked.length).toBeGreaterThan(1000)
    const idle: string[] = []
    for (const name of files) {
      for (const pattern of pathsOf(name)) {
        const glob = new Bun.Glob(pattern)
        if (!tracked.some((file) => glob.match(file))) {
          idle.push(`${name}: ${pattern}`)
        }
      }
    }
    expect(idle).toEqual([])
  })

  /** The files the "Area rules" table of a document names: its rows' last cells, nothing else. */
  function tabled(document: string): string[] {
    const start = document.indexOf('\n### Area rules\n')
    const section = document.slice(start + 1, document.indexOf('\n### ', start + 1))
    const named: string[] = []
    for (const row of section.split('\n').filter((line) => line.startsWith('| '))) {
      const cell = row.split(/(?<!\\)\|/).at(-2) ?? ''
      for (const match of cell.matchAll(/`\.claude\/rules\/([a-z0-9-]+)\.md`/g)) {
        named.push(`${match[1]}.md`)
      }
      for (const match of cell.matchAll(/`\.claude\/rules\/\{([a-z0-9,-]+)\}\.md`/g)) {
        named.push(...(match[1] as string).split(',').map((each) => `${each}.md`))
      }
    }
    return named
  }

  test('every area file has a row in the table of AGENTS.md, so an agent that loads no rules finds it', () => {
    const named = new Set(tabled(agents))
    expect(named.size).toBeGreaterThan(30)
    expect(files.filter((name) => !named.has(name))).toEqual([])
    // And the other way round: a row for a file that is gone sends a reader nowhere.
    expect([...named].filter((name) => !files.includes(name)).sort()).toEqual([])
  })

  test('a file named in prose only, outside the table, does not count as listed', () => {
    const document = [
      'See `.claude/rules/ghost.md`.',
      '',
      '### Area rules',
      '',
      'Also `.claude/rules/prose.md`, in a sentence.',
      '',
      '| Section | File |',
      '| --- | --- |',
      '| Webhooks | `.claude/rules/webhooks.md` |',
      '| General | `.claude/rules/{api,sdk}.md` |',
      '',
      '### Next',
      '',
      '| Later | `.claude/rules/later.md` |',
    ].join('\n')
    expect(tabled(document)).toEqual(['webhooks.md', 'api.md', 'sdk.md'])
  })

  test('a section lives in one place: no heading of an area file is a heading of AGENTS.md', () => {
    const own = new Set([...agents.matchAll(/^#{2,3} (.+)$/gm)].map((match) => match[1]))
    // An area file names, by the heading it had, the section its bullets came from.
    const shared = new Set([
      'Publishable packages (see ADR 0020)',
      'Security rules (non-negotiable)',
      'Testing',
    ])
    const twice: string[] = []
    for (const name of files) {
      for (const match of readFileSync(join(rules, name), 'utf8').matchAll(/^## (.+)$/gm)) {
        if (own.has(match[1] as string) && !shared.has(match[1] as string)) {
          twice.push(`${name}: ${match[1]}`)
        }
      }
    }
    expect(twice).toEqual([])
  })

  // "Webhooks" above, in a file that no longer holds a section of that name, sends a reader
  // looking for it. A section that moved is named with where it is.
  test('AGENTS.md names no section as above or below that it does not hold', () => {
    const own = new Set(
      [...agents.matchAll(/^#{2,3} (.+)$/gm)].map((match) =>
        (match[1] as string).replace(/ \(.*$/, '')
      )
    )
    const lost: string[] = []
    for (const match of agents.matchAll(/"([^"\n]{3,60})"\s+(?:above|below)\b/g)) {
      if (!own.has(match[1] as string)) {
        lost.push(match[1] as string)
      }
    }
    expect(lost).toEqual([])
  })
})
