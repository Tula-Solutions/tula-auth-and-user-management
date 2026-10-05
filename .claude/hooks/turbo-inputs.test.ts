import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { Glob } from 'bun'

// Turborepo caches a task by the files of the package it runs in. A package whose sources or
// tests reach a file of another package (a relative import, a tsconfig path, a path it reads)
// is therefore served a stale "passed" when only that other file changed: `verify` was green
// on a branch whose `@tula/cli` tests no longer compiled, because they import `apps/api/src`
// and nothing told Turborepo so.
//
// Two things make a file outside a package part of its cache key, and this test holds that
// every such file has one of them:
//
// 1. it belongs to a workspace package the importer depends on (directly or through others),
//    and the cached tasks depend on `transit`, which depends on `^transit`: a change in a
//    dependency then changes the hash of everything downstream;
// 2. the importer's own `turbo.json` names it in the `inputs` of each cached task.

const root = join(import.meta.dir, '..', '..')
const read = <T>(path: string) => Bun.file(join(root, path)).json() as Promise<T>

/** The tasks whose result is cached and depends on what a package's files reach. */
const CACHED_TASKS = ['typecheck', 'test', 'test:coverage', 'generate:check'] as const
/** The task that carries a dependency's change to its dependants (it has no script). */
const TRANSIT = 'transit'

interface TaskConfig {
  dependsOn?: string[]
  inputs?: string[]
  cache?: boolean
}
interface TurboConfig {
  extends?: string[]
  tasks?: Record<string, TaskConfig>
}
interface Manifest {
  name: string
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}
interface Workspace {
  dir: string
  manifest: Manifest
  turbo: TurboConfig | null
}

const posix = (path: string) => path.split(sep).join('/')

async function workspaces(): Promise<Workspace[]> {
  const { workspaces: patterns } = await read<{ workspaces: string[] }>('package.json')
  const found: Workspace[] = []
  for (const pattern of patterns) {
    const group = pattern.replace(/\/\*$/, '')
    for (const entry of readdirSync(join(root, group), { withFileTypes: true })) {
      const dir = `${group}/${entry.name}`
      if (entry.isDirectory() && existsSync(join(root, dir, 'package.json'))) {
        found.push({
          dir,
          manifest: await read<Manifest>(`${dir}/package.json`),
          turbo: existsSync(join(root, dir, 'turbo.json'))
            ? await read<TurboConfig>(`${dir}/turbo.json`)
            : null,
        })
      }
    }
  }
  return found
}

/** Directories of a package that hold nothing it wrote: installed, built or generated. */
const SKIPPED =
  /(^|\/)(node_modules|dist|out|coverage|\.next|\.turbo|test-results|playwright-report)\//

/**
 * A string literal that is a relative path: `./x` or `../x`. Covers `import`, `export … from`,
 * `import()`, `require()`, tsconfig `paths`/`extends`/`include`, and a path joined to
 * `import.meta.dir`. A path built from separate `'..'` arguments is {@link climbsOut}'s.
 */
const RELATIVE_LITERAL = /(['"`])(\.\.?\/[^'"`\n$]*)\1/g

/** The file or directory a relative literal names, if it exists, as a path from the root. */
function target(fromFile: string, literal: string): string | null {
  const base = resolve(root, dirname(fromFile), literal.replace(/\*+.*$/, ''))
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.json`]) {
    if (existsSync(candidate)) {
      const path = posix(relative(root, candidate))
      return path.startsWith('..') ? null : path
    }
  }
  return null
}

/** Every existing path outside `workspace` that one of its own files names relatively. */
async function outsideReferences(workspace: Workspace): Promise<Map<string, string>> {
  const references = new Map<string, string>()
  for await (const file of new Glob('**/*.{ts,tsx,mts,cts,json}').scan({
    cwd: join(root, workspace.dir),
    dot: false,
  })) {
    if (SKIPPED.test(`${file}`) || SKIPPED.test(`/${file}`)) {
      continue
    }
    const from = `${workspace.dir}/${file}`
    const source = await Bun.file(join(root, from)).text()
    const named = [...source.matchAll(RELATIVE_LITERAL)].map(([, , literal]) =>
      target(from, literal as string)
    )
    // A file that climbs out with separate `'..'` arguments names nothing this scan can
    // follow: what it reaches is written down in `CLIMBERS`, and checked like the rest.
    const climbed = climbsOut(file, source) ? (CLIMBERS[from] ?? [UNLISTED_CLIMB]) : []
    for (const path of [...named, ...climbed]) {
      if (
        path !== null &&
        path !== '' &&
        path !== workspace.dir &&
        !path.startsWith(`${workspace.dir}/`) &&
        !path.includes('node_modules/') &&
        !references.has(path)
      ) {
        references.set(path, from)
      }
    }
  }
  return references
}

/**
 * What each file that builds a path out of its package from separate `'..'` arguments goes
 * on to read, from the repository root. A new such file is refused until it is listed here
 * (an empty list for one that reads nothing through that path).
 */
const CLIMBERS: Record<string, string[]> = {
  'packages/create-tula/scripts/sync-templates.ts': [
    'examples/react-vite',
    'examples/nextjs-app-router',
    'package.json',
  ],
  'packages/mcp/scripts/sync-scaffolds.ts': ['packages/create-tula/templates'],
  'packages/mcp/src/scaffold.test.ts': ['examples/react-vite', 'examples/nextjs-app-router'],
  // Points the bundler at the workspace root; reads nothing through it itself.
  'examples/nextjs-app-router/next.config.ts': [],
}
/** Stands for "somewhere outside, nobody said where": covered by no dependency and no input. */
const UNLISTED_CLIMB = 'a path built from separate ".." arguments: list the file in CLIMBERS'

const CLIMB = /\b(?:join|resolve)\(\s*([\w.$]+)\s*((?:,\s*(['"])\.\.\3\s*)+)/g

/**
 * Whether a file builds a path that leaves its package out of separate `'..'` arguments.
 * From the file's own directory that takes more steps up than the file is deep; from any
 * other base, where the base is not known here, one step is enough to be asked about.
 */
function climbsOut(file: string, source: string): boolean {
  const depth = file.split('/').length - 1
  for (const [, base, ups] of source.matchAll(CLIMB)) {
    const steps = (ups as string).split(',').length - 1
    const ownDirectory = /^(import\.meta\.(dir|dirname)|__dirname)$/.test(base as string)
    if (ownDirectory ? steps > depth : steps > 0) {
      return true
    }
  }
  return false
}

/** The workspace packages `workspace` depends on, directly or through its dependencies. */
function dependenciesOf(workspace: Workspace, all: Workspace[]): Set<string> {
  const byName = new Map(all.map((one) => [one.manifest.name, one]))
  const seen = new Set<string>()
  const queue = [workspace]
  for (let next = queue.pop(); next; next = queue.pop()) {
    const { dependencies, devDependencies, peerDependencies } = next.manifest
    for (const name of Object.keys({ ...dependencies, ...devDependencies, ...peerDependencies })) {
      const dependency = byName.get(name)
      if (dependency && !seen.has(dependency.dir)) {
        seen.add(dependency.dir)
        queue.push(dependency)
      }
    }
  }
  return seen
}

/** Whether a task's `inputs` keep the package's own files and also name `path`. */
function inputsCover(inputs: string[] | undefined, path: string): boolean {
  if (!inputs?.includes('$TURBO_DEFAULT$')) {
    return false
  }
  const isDirectory = existsSync(join(root, path)) && statSync(join(root, path)).isDirectory()
  return inputs
    .filter((input) => input.startsWith('$TURBO_ROOT$/'))
    .map((input) => input.slice('$TURBO_ROOT$/'.length))
    .some((pattern) =>
      isDirectory
        ? // A directory is covered by a pattern that takes everything under it.
          pattern.endsWith('/**') && `${path}/`.startsWith(pattern.slice(0, -2))
        : new Glob(pattern).match(path)
    )
}

/** The tasks of `workspace` whose cache key has to include what it reaches. */
function cachedTasksOf(workspace: Workspace): string[] {
  const scripts = workspace.manifest.scripts ?? {}
  return [...CACHED_TASKS.filter((task) => task in scripts), TRANSIT]
}

/**
 * What `workspace` reaches outside itself that would not invalidate its cached tasks.
 *
 * @returns One line per reference and task, empty when everything is covered.
 */
async function uncovered(workspace: Workspace, all: Workspace[]): Promise<string[]> {
  const dependencies = dependenciesOf(workspace, all)
  const problems: string[] = []
  for (const [path, from] of await outsideReferences(workspace)) {
    const owner = all.find((one) => path === one.dir || path.startsWith(`${one.dir}/`))
    if (owner && dependencies.has(owner.dir)) {
      continue
    }
    for (const task of cachedTasksOf(workspace)) {
      if (!inputsCover(workspace.turbo?.tasks?.[task]?.inputs, path)) {
        problems.push(`${task}: ${path} (named in ${from})`)
      }
    }
  }
  return problems.sort()
}

const all = await workspaces()

describe('a cached task is invalidated by every file it reaches', () => {
  test('there are workspaces to check', () => {
    expect(all.length).toBeGreaterThan(10)
    expect(all.map((one) => one.dir)).toContain('packages/cli')
  })

  test('a change in a dependency reaches its dependants: the cached tasks depend on transit', async () => {
    const { tasks = {} } = await read<TurboConfig>('turbo.json')
    expect(tasks[TRANSIT]).toEqual({ dependsOn: [`^${TRANSIT}`] })
    for (const task of CACHED_TASKS) {
      expect({ task, dependsOn: tasks[task]?.dependsOn }).toEqual({
        task,
        dependsOn: expect.arrayContaining([TRANSIT]),
      })
    }
  })

  test.each(all.map((one) => one.dir))(
    '%s: nothing it names outside itself is missing from its cache key',
    async (dir) => {
      const workspace = all.find((one) => one.dir === dir) as Workspace
      expect(await uncovered(workspace, all)).toEqual([])
    }
  )

  test.each(all.filter((one) => one.turbo).map((one) => one.dir))(
    '%s/turbo.json extends the root and keeps the package’s own files in every inputs list',
    async (dir) => {
      const { turbo } = all.find((one) => one.dir === dir) as Workspace
      expect(turbo?.extends).toEqual(['//'])
      for (const [task, config] of Object.entries(turbo?.tasks ?? {})) {
        if (config.inputs) {
          expect({ task, inputs: config.inputs }).toEqual({
            task,
            inputs: expect.arrayContaining(['$TURBO_DEFAULT$']),
          })
        }
      }
    }
  )

  // The check itself, on a package that is not on disk: what it must and must not accept.
  describe('the check', () => {
    const cli = () => all.find((one) => one.dir === 'packages/cli') as Workspace
    const api = 'apps/api/src/index.ts'

    test('a file of a package that is not a dependency needs inputs for every cached task', async () => {
      const stranger: Workspace = {
        ...cli(),
        manifest: { name: '@tula/cli', scripts: cli().manifest.scripts },
        turbo: null,
      }
      const problems = await uncovered(stranger, all)
      expect(problems.some((line) => line.startsWith('typecheck: apps/api/src/'))).toBe(true)
      expect(problems.some((line) => line.startsWith('test:coverage: apps/api/src/'))).toBe(true)
      expect(problems.some((line) => line.startsWith('transit: apps/api/src/'))).toBe(true)
    })

    test('inputs cover a file only with the package’s own files kept and a root pattern that matches', () => {
      const covering = ['$TURBO_DEFAULT$', '$TURBO_ROOT$/apps/api/src/**']
      expect(inputsCover(covering, api)).toBe(true)
      expect(inputsCover(covering, 'apps/api/src')).toBe(true)
      expect(inputsCover(covering, 'apps/api/package.json')).toBe(false)
      expect(inputsCover(['$TURBO_ROOT$/apps/api/src/**'], api)).toBe(false)
      expect(inputsCover(['$TURBO_DEFAULT$', 'apps/api/src/**'], api)).toBe(false)
      expect(
        inputsCover(['$TURBO_DEFAULT$', '$TURBO_ROOT$/apps/api/src/*.ts'], 'apps/api/src')
      ).toBe(false)
      expect(inputsCover(undefined, api)).toBe(false)
    })
  })
})
