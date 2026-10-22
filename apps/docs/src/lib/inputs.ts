import { Glob } from 'bun'
import { RenderError } from './markdown'

/** What a Turborepo input starts with when it is relative to the repository, not the package. */
const ROOT_PREFIX = '$TURBO_ROOT$/'

/**
 * The cached tasks of the docs app. All of them read the pages, and the files the pages link to,
 * so all of them name the same inputs (`.claude/rules/turbo-inputs.md`).
 */
export const CACHED_TASKS = ['transit', 'build', 'test', 'test:coverage', 'generate:check'] as const

/** The file of those inputs, as the error messages name it. */
export const TURBO_FILE = 'apps/docs/turbo.json'

/**
 * Whether one of the inputs of a task matches a repository path.
 *
 * @param inputs - The task's `inputs`; only the ones relative to the repository root count.
 * @param path - A file or directory, from the repository root.
 * @param isDirectory - Whether `path` is a directory; a directory is matched by what is under it.
 * @returns True when an input matches.
 */
export function covers(
  inputs: readonly string[],
  path: string,
  isDirectory: (path: string) => boolean
): boolean {
  const probe = isDirectory(path) ? `${path}/x` : path
  return inputs
    .filter((input) => input.startsWith(ROOT_PREFIX))
    .some((input) => new Glob(input.slice(ROOT_PREFIX.length)).match(probe))
}

/**
 * The targets no input of a task matches.
 *
 * @param inputs - The task's `inputs`.
 * @param targets - Repository paths.
 * @param isDirectory - Whether a path is a directory.
 * @returns The targets that are not covered, in the order given.
 */
export function uncovered(
  inputs: readonly string[],
  targets: readonly string[],
  isDirectory: (path: string) => boolean
): string[] {
  return targets.filter((path) => !covers(inputs, path, isDirectory))
}

/**
 * Fail unless the cached tasks of the docs app are keyed on everything the pages read.
 *
 * A page reads each file outside `docs/` that it links to (to check that the link resolves and,
 * for Markdown, its anchors). If a task's inputs leave one out, Turborepo serves the site from
 * its cache after that file changes. The check lives in the build because it needs every page
 * rendered, which is too slow for a unit test on a loaded runner; the guard itself
 * (`covers`, `uncovered`, this function) is tested on its own.
 *
 * @param turbo - The text of `apps/docs/turbo.json`.
 * @param linked - The repository files and directories the pages link to or show.
 * @param isDirectory - Whether a path is a directory.
 * @throws RenderError when the file is not what is expected, the tasks differ in their inputs, or
 *   an input of a task does not match a file outside `docs/` that a page links to.
 */
export function checkCacheInputs(
  turbo: string,
  linked: readonly string[],
  isDirectory: (path: string) => boolean
): void {
  let tasks: Record<string, { inputs?: string[] } | undefined>
  try {
    tasks = (JSON.parse(turbo) as { tasks: typeof tasks }).tasks
  } catch (error) {
    throw new RenderError(TURBO_FILE, `cannot be read: ${(error as Error).message}`)
  }
  const named = Object.keys(tasks ?? {}).sort()
  if (named.join() !== [...CACHED_TASKS].sort().join()) {
    throw new RenderError(
      TURBO_FILE,
      `has the tasks ${named.join(', ')}, and the docs app caches ${CACHED_TASKS.join(', ')}`
    )
  }
  const first = tasks.transit?.inputs ?? []
  const targets = [...new Set(linked.filter((file) => !file.startsWith('docs/')))].sort()
  for (const task of CACHED_TASKS) {
    const inputs = tasks[task]?.inputs ?? []
    if (JSON.stringify(inputs) !== JSON.stringify(first)) {
      throw new RenderError(
        TURBO_FILE,
        `task ${task} names other inputs than transit: the tasks cache the same pages, so they name the same inputs`
      )
    }
    const missing = uncovered(inputs, targets, isDirectory)
    if (missing.length > 0) {
      throw new RenderError(
        TURBO_FILE,
        `no input of task ${task} matches ${missing.join(', ')}, which a page links to: add its glob to the inputs of all ${CACHED_TASKS.length} tasks, or the site is served from the cache when that file changes`
      )
    }
  }
}
