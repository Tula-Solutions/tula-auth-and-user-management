import { existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// Where the build reads from and writes to. This file is also imported by `vite.config.ts`,
// which runs under Node: it uses no Bun API and imports nothing of the site.

const APP_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const REPO = resolve(APP_ROOT, '../..')

/** The environment variables the two resolvers read. */
export type PathEnvironment = Record<string, string | undefined>

/**
 * A path with its symbolic links resolved, though it may not exist yet: the deepest existing
 * ancestor is resolved and the rest is appended.
 */
function real(path: string): string {
  let existing = path
  const rest: string[] = []
  while (!existsSync(existing)) {
    rest.unshift(basename(existing))
    const parent = dirname(existing)
    if (parent === existing) {
      break
    }
    existing = parent
  }
  return join(realpathSync(existing), ...rest)
}

function strictlyInside(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path !== '' && !path.startsWith('..') && !isAbsolute(path) && path.split(sep)[0] !== '..'
}

/** An absolute path from a variable that is allowed only inside the temporary directory. */
function inTemporaryDirectory(name: string, value: string): string {
  if (!isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path (got "${value}")`)
  }
  const resolved = real(resolve(value))
  if (!strictlyInside(realpathSync(tmpdir()), resolved)) {
    throw new Error(
      `${name} is for the build script's tests and must be a directory inside ${tmpdir()} (got "${value}")`
    )
  }
  return resolved
}

/**
 * The directory the site is built into, and the one the build empties.
 *
 * `DOCS_OUT_DIR` is for the build script's own test. Because Vite empties its output directory,
 * a stray value would delete whatever it names, so a value is accepted only as an absolute path
 * strictly inside the temporary directory (links resolved), and anything else throws before a
 * file is written or deleted.
 *
 * @param env - The environment; `process.env` by default.
 * @returns `apps/docs/dist` when `DOCS_OUT_DIR` is unset, else the absolute path it names.
 * @throws Error when the variable names a relative path, or one outside the temporary directory.
 */
export function resolveOutDir(env: PathEnvironment = process.env): string {
  const value = env.DOCS_OUT_DIR
  if (value === undefined || value === '') {
    return join(APP_ROOT, 'dist')
  }
  return inTemporaryDirectory('DOCS_OUT_DIR', value)
}

/**
 * The repository the site reads `docs/` and the files its links lead to from.
 *
 * `DOCS_REPO_ROOT` is for the build script's own test (a throwaway repository). It is accepted
 * only as an absolute path that is this repository's root or strictly inside the temporary
 * directory.
 *
 * @param env - The environment; `process.env` by default.
 * @returns The repository root.
 * @throws Error when the variable names anything else.
 */
export function resolveRepoRoot(env: PathEnvironment = process.env): string {
  const value = env.DOCS_REPO_ROOT
  if (value === undefined || value === '') {
    return REPO
  }
  if (isAbsolute(value) && real(resolve(value)) === realpathSync(REPO)) {
    return REPO
  }
  return inTemporaryDirectory('DOCS_REPO_ROOT', value)
}
