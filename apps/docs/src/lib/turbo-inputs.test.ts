import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Glob } from 'bun'
import { fakeEnvironment } from '../testing/environment'
import { REPO_ROOT } from './config'
import { linkedFiles, parseMarkdown } from './markdown'
import { collectPages } from './pages'
import { repositoryEnvironment } from './site'

const ROOT_PREFIX = '$TURBO_ROOT$/'
const TASKS = ['transit', 'build', 'test', 'test:coverage', 'generate:check'] as const

interface TurboFile {
  tasks: Record<string, { inputs: string[] }>
}

const turbo = JSON.parse(
  readFileSync(join(import.meta.dir, '../../turbo.json'), 'utf8')
) as TurboFile

/**
 * The repository files, outside `docs/`, that the pages link to: the renderer's own resolution
 * of every link and image (`linkedFiles`), so the guard and the build read the same links. A
 * page reads them to check that a link resolves (and, for Markdown, its anchors), so a change to
 * one has to invalidate the cached tasks.
 */
let linked: string[] | undefined
function linkedOutsideDocs(): string[] {
  if (linked !== undefined) {
    return linked
  }
  const environment = repositoryEnvironment(collectPages(), new Map(), '/')
  const found = new Set<string>()
  for (const page of collectPages()) {
    const doc = parseMarkdown(page.file, readFileSync(join(REPO_ROOT, page.file), 'utf8'))
    for (const file of linkedFiles(doc, environment)) {
      if (!file.startsWith('docs/')) {
        found.add(file)
      }
    }
  }
  linked = [...found].sort()
  return linked
}

function covers(inputs: string[], path: string, isDirectory: (path: string) => boolean): boolean {
  const probe = isDirectory(path) ? `${path}/x` : path
  return inputs
    .filter((input) => input.startsWith(ROOT_PREFIX))
    .some((input) => new Glob(input.slice(ROOT_PREFIX.length)).match(probe))
}

/** The targets no input of the task matches. */
function uncovered(
  inputs: string[],
  targets: string[],
  isDirectory: (path: string) => boolean
): string[] {
  return targets.filter((path) => !covers(inputs, path, isDirectory))
}

const isDirectory = (path: string) => statSync(join(REPO_ROOT, path)).isDirectory()

describe("the docs app's cache inputs", () => {
  test('the repository files the docs link to exist', () => {
    for (const path of linkedOutsideDocs()) {
      expect(existsSync(join(REPO_ROOT, path)), path).toBe(true)
    }
  })

  test('every task names the same inputs', () => {
    expect(Object.keys(turbo.tasks).sort()).toEqual([...TASKS].sort())
    const first = turbo.tasks.transit?.inputs
    for (const task of TASKS) {
      expect(turbo.tasks[task]?.inputs, task).toEqual(first)
    }
  })

  test('every file outside docs/ that a page links to is an input of every task', () => {
    const targets = linkedOutsideDocs()
    expect(targets.length).toBeGreaterThan(0)
    for (const task of TASKS) {
      const inputs = turbo.tasks[task]?.inputs ?? []
      for (const path of targets) {
        expect(
          uncovered(inputs, [path], isDirectory),
          `${path} is not an input of ${task}`
        ).toEqual([])
      }
    }
  })

  test('the guard fails for a link the inputs do not match, whatever its syntax', () => {
    const fixture = fakeEnvironment({
      'docs/a.md': new Set(['t']),
      'packages/zzz/src/a.ts': null,
      'packages/zzz/src/b.ts': null,
    })
    const doc = parseMarkdown(
      'docs/a.md',
      "# T\n\n[x]\n\n<a href='../packages/zzz/src/b.ts'>y</a>\n\n[x]: ../packages/zzz/src/a.ts\n"
    )
    const targets = linkedFiles(doc, fixture)
    expect([...targets].sort()).toEqual(['packages/zzz/src/a.ts', 'packages/zzz/src/b.ts'])
    const inputs = turbo.tasks.transit?.inputs ?? []
    expect(uncovered(inputs, targets, () => false)).toEqual(targets)
  })
})
