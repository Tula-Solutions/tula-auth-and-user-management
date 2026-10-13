import { cp, lstat, mkdir, readdir, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'

// What `vendor-native.ts` runs: the copy of the native SDKs' sources into this package
// (ADR 0063), as functions over two roots, so that it is tested on a tree of its own.

/** One directory of sources and where its copy goes. */
export interface Vendored {
  /** The source, from the repository's root. */
  readonly from: string
  /** The copy, from this package's root. */
  readonly to: string
  /** The one file extension that is taken. */
  readonly extension: '.swift' | '.kt'
}

/** The four modules of `native/android` the Android half is compiled from. */
export const VENDORED_ANDROID_MODULES = [
  'tula-auth',
  'tula-auth-ui',
  'tula-auth-android',
  'tula-auth-compose',
] as const

/** The two libraries of `native/swift` the iOS half is compiled from. */
export const VENDORED_SWIFT_LIBRARIES = ['TulaAuth', 'TulaAuthUI'] as const

/** Everything that is copied, and where to. */
export const VENDORED: readonly Vendored[] = [
  ...VENDORED_SWIFT_LIBRARIES.map(
    (library): Vendored => ({
      from: `native/swift/Sources/${library}`,
      to: `ios/vendor/${library}`,
      extension: '.swift',
    })
  ),
  ...VENDORED_ANDROID_MODULES.map(
    (module): Vendored => ({
      from: `native/android/${module}/src/main/kotlin`,
      to: `android/vendor/${module}`,
      extension: '.kt',
    })
  ),
]

function codeOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
}

/**
 * Why a directory cannot be copied from, or into: it, or a directory above it up to `root`,
 * is a symbolic link or no directory.
 *
 * A link leads somewhere else. Followed as a source, a stranger's files would end up in a
 * published package; followed as a target, the copy (and the removal before it) would land
 * outside this package. Each part of the path is asked with `lstat`, and the real path is
 * compared at the end. It is the rule `packages/core/scripts/native/tree.ts` holds the
 * generated directories to, stated here again because a missing directory means something
 * else in each place: there "nothing generated yet", here a source that must exist.
 *
 * @param root - The directory the path starts from. It is taken as it is.
 * @param directory - The path from `root`, of plain names separated by `/`.
 * @param mustExist - `true` for a source; a target that is not there yet is made later.
 * @returns A fixed sentence that names the path from `root`, or `undefined`.
 *
 * @example
 * ```ts
 * await directoryProblem(repositoryRoot, 'native/swift/Sources/TulaAuth', true)
 * // 'native/swift is a symbolic link' when it is one
 * ```
 */
export async function directoryProblem(
  root: string,
  directory: string,
  mustExist: boolean
): Promise<string | undefined> {
  const parts = directory.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    return `${directory} is not a path of plain names`
  }
  for (let depth = 1; depth <= parts.length; depth++) {
    const path = parts.slice(0, depth).join('/')
    const found = await lstat(join(root, path)).catch((error: unknown) => {
      if (codeOf(error) === 'ENOENT') {
        return undefined
      }
      throw error
    })
    if (found === undefined) {
      return mustExist ? `${path} does not exist` : undefined
    }
    if (found.isSymbolicLink()) {
      return `${path} is a symbolic link`
    }
    if (!found.isDirectory()) {
      return `${path} is not a directory`
    }
  }
  if ((await realpath(join(root, directory))) !== join(await realpath(root), directory)) {
    return `${directory} is somewhere else than its name says`
  }
  return undefined
}

/** Every file under `directory`, as paths from it. Stops for a symbolic link. */
async function filesUnder(directory: string, named: string, prefix = ''): Promise<string[]> {
  const found: string[] = []
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name)
    const entry = await lstat(path)
    if (entry.isSymbolicLink()) {
      throw new Error(`vendor-native: ${named}/${prefix}${name} is a symbolic link`)
    }
    if (entry.isDirectory()) {
      found.push(...(await filesUnder(path, named, `${prefix}${name}/`)))
    } else if (entry.isFile()) {
      found.push(`${prefix}${name}`)
    }
  }
  return found
}

/**
 * Copy the native SDKs' sources into the package.
 *
 * Only `.swift` and `.kt` files are taken. **Before anything is removed or written**, every
 * source and every target is held to {@link directoryProblem}, from its own root down: a
 * symbolic link at a source's root, above it or anywhere under it stops the run, and so
 * does one at or above a target.
 *
 * @param repositoryRoot - Where the sources are read from.
 * @param packageRoot - Where the copies go.
 * @param vendored - What is copied; {@link VENDORED} unless a test says otherwise.
 * @returns How many files were copied.
 * @throws Error with a fixed sentence and the path from its root when a directory is not a
 *   real one. Nothing has been removed or written by then.
 *
 * @example
 * ```ts
 * await vendor(repositoryRoot, packageRoot)
 * ```
 */
export async function vendor(
  repositoryRoot: string,
  packageRoot: string,
  vendored: readonly Vendored[] = VENDORED
): Promise<number> {
  for (const { from, to } of vendored) {
    const problem =
      (await directoryProblem(repositoryRoot, from, true)) ??
      (await directoryProblem(packageRoot, to, false))
    if (problem !== undefined) {
      throw new Error(`vendor-native: ${problem}: nothing was copied`)
    }
  }
  // Every source is walked before the first removal: a link deep inside the last one must
  // not leave the package with half of its copies replaced.
  const plans: { source: string; target: string; files: string[] }[] = []
  for (const { from, to, extension } of vendored) {
    const source = join(repositoryRoot, from)
    const files = (await filesUnder(source, from)).filter((file) => file.endsWith(extension))
    plans.push({ source, target: join(packageRoot, to), files })
  }
  let copied = 0
  for (const { source, target, files } of plans) {
    await rm(target, { recursive: true, force: true })
    for (const file of files) {
      await mkdir(join(target, file, '..'), { recursive: true })
      await cp(join(source, file), join(target, file))
      copied += 1
    }
  }
  return copied
}
