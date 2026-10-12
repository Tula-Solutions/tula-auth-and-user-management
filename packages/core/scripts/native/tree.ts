/**
 * The generated directories on disk: reading what is there, and making it what the generator
 * writes. The only module of the native generator that touches the file system.
 *
 * A generated directory is generated **whole**: whatever is in it that the generator does not
 * write is a stray, whatever it is (a file put there by hand, a `.DS_Store`, a directory, a
 * symbolic link). The check reports it and the generator removes it.
 *
 * That rule is only safe where the directory is the one that was named. A generated
 * directory that is a symbolic link, or that is under one, is somewhere else, and "everything
 * here is a stray" would then remove a stranger's files. So the generated directories and
 * every directory above them, up to the root, are real directories or nothing is touched.
 */
// The default export, so that a test can stand in for one call (a failure the file system
// gives only under conditions a test cannot arrange).
import fs from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { nativeDrift } from './index'

/** What every refusal of a directory ends with. */
const REAL_DIRECTORY_RULE =
  'a generated directory and every directory above it must be a real directory'

/** The error code of a rejection of the file system, when it has one. */
function codeOf(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code
}

/**
 * Why the generated directories cannot be read or written safely.
 *
 * Every part of each path from the root down is looked at without following it (`lstat`):
 * it must be a directory, or not exist yet (what is under it then does not exist either).
 * A directory that exists must also resolve to where its name says (the root's own real
 * path, then the same names), as a second look by another route.
 * The root itself may be reached through a link: it is the caller's own choice of place.
 *
 * This is asked once, before anything is read. A directory swapped for a link while a run
 * is under way is not defended against.
 *
 * @param root - The repository's root.
 * @param directories - The generated directories, from the root.
 * @returns One fixed sentence per directory that cannot be used, naming the path from the
 *   root; empty when all can.
 *
 * @example
 * ```ts
 * await directoryProblems(root, ['native/a/Generated'])
 * // ['native/a is a symbolic link: a generated directory and every directory above it must be a real directory']
 * ```
 */
export async function directoryProblems(
  root: string,
  directories: readonly string[]
): Promise<string[]> {
  const problems: string[] = []
  for (const directory of directories) {
    const problem = await directoryProblem(root, directory)
    if (problem !== undefined) {
      problems.push(`${problem}: ${REAL_DIRECTORY_RULE}`)
    }
  }
  return problems
}

async function directoryProblem(root: string, directory: string): Promise<string | undefined> {
  const parts = directory.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    return `${directory} is not a path of plain names`
  }
  for (let depth = 1; depth <= parts.length; depth++) {
    const path = parts.slice(0, depth).join('/')
    const found = await fs.lstat(join(root, path)).catch((error: unknown) => {
      if (codeOf(error) === 'ENOENT') {
        return undefined
      }
      throw error
    })
    if (found === undefined) {
      // Nothing here yet, so nothing under it: the generator makes the rest itself.
      return undefined
    }
    if (found.isSymbolicLink()) {
      return `${path} is a symbolic link`
    }
    if (!found.isDirectory()) {
      return `${path} is not a directory`
    }
  }
  if ((await fs.realpath(join(root, directory))) !== join(await fs.realpath(root), directory)) {
    return `${directory} is somewhere else than its name says`
  }
  return undefined
}

/**
 * What is in the generated directories.
 *
 * @param root - The repository's root.
 * @param directories - The generated directories, from the root.
 * @returns By path from the root: a file's text, or `null` for anything that is not a regular
 *   file (a directory, a symbolic link, a pipe), which is never opened or followed. A
 *   directory that does not exist holds nothing.
 * @throws Error with the first of {@link directoryProblems} when a generated directory, or
 *   one above it, is not a real directory: nothing is read through a link.
 *
 * @example
 * ```ts
 * await readGenerated(root, [SWIFT_DIRECTORY, KOTLIN_DIRECTORY])
 * ```
 */
export async function readGenerated(
  root: string,
  directories: readonly string[]
): Promise<Record<string, string | null>> {
  const [problem] = await directoryProblems(root, directories)
  if (problem !== undefined) {
    throw new Error(problem)
  }
  const found: Record<string, string | null> = {}
  for (const directory of directories) {
    const entries = await fs
      .readdir(join(root, directory), { withFileTypes: true })
      .catch((error: unknown) => {
        if (codeOf(error) === 'ENOENT') {
          return []
        }
        throw error
      })
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = `${directory}/${entry.name}`
      found[path] = entry.isFile() ? await Bun.file(join(root, path)).text() : null
    }
  }
  return found
}

/** What {@link syncGenerated} did or found. */
export interface SyncResult {
  /** `false` only in check mode, when the tree is not what the generator writes. */
  readonly ok: boolean
  /** What to print, a line each. */
  readonly lines: readonly string[]
}

/**
 * Hold the generated directories to the generated files.
 *
 * `'check'` changes nothing and reports every difference. `'write'` removes what does not
 * belong (a directory with everything in it; a symbolic link itself, never its target) and
 * then writes the files that are missing or out of date.
 *
 * Before anything is read, **every** generated directory is held to
 * {@link directoryProblems}: one that is a symbolic link, or under one, stops both modes
 * with nothing read, removed or written in any of them.
 *
 * @param root - The repository's root.
 * @param directories - The generated directories, from the root.
 * @param files - The generated files' texts, by path from the root.
 * @param mode - `'check'` or `'write'`.
 * @returns Whether the tree is (now) up to date, and what to say.
 * @throws Error when a generated file is not directly in one of `directories`: nothing is
 *   written or removed anywhere else. In `'write'` mode also with the first of
 *   {@link directoryProblems}; `'check'` reports those as its lines instead.
 *
 * @example
 * ```ts
 * const { ok, lines } = await syncGenerated(root, [SWIFT_DIRECTORY], files, 'check')
 * ```
 */
export async function syncGenerated(
  root: string,
  directories: readonly string[],
  files: Readonly<Record<string, string>>,
  mode: 'check' | 'write'
): Promise<SyncResult> {
  for (const path of Object.keys(files)) {
    const name = path.slice(path.lastIndexOf('/') + 1)
    if (!directories.includes(path.slice(0, path.lastIndexOf('/'))) || name === '..') {
      throw new Error(`${path} is not in a generated directory`)
    }
  }
  const refused = await directoryProblems(root, directories)
  if (refused.length > 0) {
    if (mode === 'check') {
      return { ok: false, lines: refused }
    }
    throw new Error(refused[0])
  }
  const existing = await readGenerated(root, directories)
  const drift = nativeDrift(files, existing)
  if (mode === 'check') {
    return drift.length === 0
      ? { ok: true, lines: [`${Object.keys(files).length} generated native files are up to date`] }
      : { ok: false, lines: [...drift, 'run `bun run native:generate`'] }
  }
  const lines: string[] = []
  // Removals first: a directory or a link where a file belongs has to go before the file is
  // written, so that nothing is ever written into one or through one.
  for (const [path, text] of Object.entries(existing)) {
    if (text === null || !Object.hasOwn(files, path)) {
      await fs.rm(join(root, path), { recursive: true, force: true })
      lines.push(`removed ${path}`)
    }
  }
  for (const [path, text] of Object.entries(files)) {
    if (!Object.hasOwn(existing, path) || existing[path] !== text) {
      await fs.mkdir(dirname(join(root, path)), { recursive: true })
      await Bun.write(join(root, path), text)
      lines.push(`wrote ${path}`)
    }
  }
  return {
    ok: true,
    lines:
      lines.length === 0 ? ['the generated native files were already up to date'] : lines.sort(),
  }
}
