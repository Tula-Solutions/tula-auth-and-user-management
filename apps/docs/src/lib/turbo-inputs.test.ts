import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'
import { Glob } from 'bun'
import { REPO_ROOT } from './config'
import { collectPages } from './pages'

const ROOT_PREFIX = '$TURBO_ROOT$/'
const TASKS = ['transit', 'build', 'test', 'test:coverage', 'generate:check'] as const

interface TurboFile {
  tasks: Record<string, { inputs: string[] }>
}

const turbo = JSON.parse(
  readFileSync(join(import.meta.dir, '../../turbo.json'), 'utf8')
) as TurboFile

/**
 * The repository files, outside `docs/`, that the Markdown of the site links to: a page reads
 * them to check that a link resolves (and, for Markdown, its anchors), so a change to one has to
 * invalidate the cached tasks.
 */
function linkedOutsideDocs(): string[] {
  const found = new Set<string>()
  for (const page of collectPages()) {
    const source = readFileSync(join(REPO_ROOT, page.file), 'utf8')
    for (const match of source.matchAll(/\]\(([^)\s]+)\)|(?:href|src)="([^"]+)"/g)) {
      const target = (match[1] ?? match[2]) as string
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) {
        continue
      }
      const path = normalize(join(dirname(page.file), target.split('#')[0]?.split('?')[0] ?? ''))
      if (path !== '' && !path.startsWith('docs/') && !path.startsWith('..')) {
        found.add(path.replace(/\/$/, ''))
      }
    }
  }
  return [...found].sort()
}

function covers(inputs: string[], path: string): boolean {
  const probe = statSync(join(REPO_ROOT, path)).isDirectory() ? `${path}/x` : path
  return inputs
    .filter((input) => input.startsWith(ROOT_PREFIX))
    .some((input) => new Glob(input.slice(ROOT_PREFIX.length)).match(probe))
}

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
        expect(covers(inputs, path), `${path} is not an input of ${task}`).toBe(true)
      }
    }
  })
})
