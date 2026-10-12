/**
 * The generated directories on disk: reading what is there, and making it what the generator
 * writes. The only module of the native generator that touches the file system.
 *
 * A generated directory is generated **whole**: whatever is in it that the generator does not
 * write is a stray, whatever it is (a file put there by hand, a `.DS_Store`, a directory, a
 * symbolic link). The check reports it and the generator removes it.
 */
import { mkdir, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { nativeDrift } from './index'

/**
 * What is in the generated directories.
 *
 * @param root - The repository's root.
 * @param directories - The generated directories, from the root.
 * @returns By path from the root: a file's text, or `null` for anything that is not a regular
 *   file (a directory, a symbolic link, a pipe), which is never opened or followed. A
 *   directory that does not exist holds nothing.
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
  const found: Record<string, string | null> = {}
  for (const directory of directories) {
    const entries = await readdir(join(root, directory), { withFileTypes: true }).catch(
      (error: unknown) => {
        if ((error as { code?: string }).code === 'ENOENT') {
          return []
        }
        throw error
      }
    )
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
 * @param root - The repository's root.
 * @param directories - The generated directories, from the root.
 * @param files - The generated files' texts, by path from the root.
 * @param mode - `'check'` or `'write'`.
 * @returns Whether the tree is (now) up to date, and what to say.
 * @throws Error when a generated file is not directly in one of `directories`: nothing is
 *   written or removed anywhere else.
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
      await rm(join(root, path), { recursive: true, force: true })
      lines.push(`removed ${path}`)
    }
  }
  for (const [path, text] of Object.entries(files)) {
    if (!Object.hasOwn(existing, path) || existing[path] !== text) {
      await mkdir(dirname(join(root, path)), { recursive: true })
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
