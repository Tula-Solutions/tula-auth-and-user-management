import { cp, lstat, mkdir, readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

// Copies the sources of the native SDKs into this package, so that the packed package holds
// everything its native module is compiled from (ADR 0063). Nothing of Tula's native SDKs is
// published anywhere: an Expo app cannot ask CocoaPods or Maven for them, and a pod's sources
// have to be inside the pod. The copies are made when the package is built (`bun run build`),
// are ignored by git, and are never edited: change the source under `native/`, then build.
//
//   native/swift/Sources/TulaAuth                      → ios/vendor/TulaAuth
//   native/swift/Sources/TulaAuthUI                    → ios/vendor/TulaAuthUI
//   native/android/<module>/src/main/kotlin            → android/vendor/<module>
//
// Only `.swift` and `.kt` files are taken, and a symbolic link anywhere under a source stops
// the run: a link leads somewhere else, and its target would end up in a published package.

const packageRoot = resolve(import.meta.dir, '..')
const repositoryRoot = resolve(packageRoot, '..', '..')

/** One directory of sources and where its copy goes, inside this package. */
interface Vendored {
  /** The source, from the repository's root. */
  readonly from: string
  /** The copy, from this package's root. */
  readonly to: string
  /** The one file extension that is taken. */
  readonly extension: '.swift' | '.kt'
}

const VENDORED: readonly Vendored[] = [
  { from: 'native/swift/Sources/TulaAuth', to: 'ios/vendor/TulaAuth', extension: '.swift' },
  { from: 'native/swift/Sources/TulaAuthUI', to: 'ios/vendor/TulaAuthUI', extension: '.swift' },
  ...(['tula-auth', 'tula-auth-ui', 'tula-auth-android', 'tula-auth-compose'] as const).map(
    (module): Vendored => ({
      from: `native/android/${module}/src/main/kotlin`,
      to: `android/vendor/${module}`,
      extension: '.kt',
    })
  ),
]

/** Every file under `directory`, as paths from it. Stops for a symbolic link. */
async function filesUnder(directory: string, prefix = ''): Promise<string[]> {
  const found: string[] = []
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name)
    const entry = await lstat(path)
    if (entry.isSymbolicLink()) {
      throw new Error(`vendor-native: a symbolic link under ${directory} is not copied`)
    }
    if (entry.isDirectory()) {
      found.push(...(await filesUnder(path, `${prefix}${name}/`)))
    } else if (entry.isFile()) {
      found.push(`${prefix}${name}`)
    }
  }
  return found
}

let copied = 0
for (const { from, to, extension } of VENDORED) {
  const source = join(repositoryRoot, from)
  const target = join(packageRoot, to)
  await rm(target, { recursive: true, force: true })
  for (const file of await filesUnder(source)) {
    if (file.endsWith(extension)) {
      await mkdir(join(target, file, '..'), { recursive: true })
      await cp(join(source, file), join(target, file))
      copied += 1
    }
  }
}
process.stdout.write(
  `vendor-native: ${copied} source files copied into ios/vendor and android/vendor\n`
)
