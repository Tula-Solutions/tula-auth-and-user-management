import { resolve } from 'node:path'
import { vendor } from './vendor'

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
// Only `.swift` and `.kt` files are taken. A symbolic link at a source, above it up to the
// repository's root or anywhere under it stops the run before anything is removed or written,
// and so does one at or above a target: a link leads somewhere else (`vendor.ts`).

const packageRoot = resolve(import.meta.dir, '..')
const repositoryRoot = resolve(packageRoot, '..', '..')

const copied = await vendor(repositoryRoot, packageRoot)
process.stdout.write(
  `vendor-native: ${copied} source files copied into ios/vendor and android/vendor\n`
)
