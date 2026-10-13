import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

// The Android half of `@tula/expo/native-screens` compiles a copy of the Kotlin SDK's
// sources against libraries it names itself (`packages/expo/android/build.gradle`), not
// against the SDK's catalog (`native/android/gradle/libs.versions.toml`). An Expo app
// brings its own Kotlin, and Expo SDK 57's cannot read what the catalog's versions are
// published with. So the two lists differ, and this test is what keeps the difference from
// being an accident or going unsaid: every library the two share has the catalog's version
// or an entry here that says which version it has instead and why. Nothing here compiles
// anything; what was compiled is in docs/plans/phase-2-unverified.md, "Step 2.16".

const root = join(import.meta.dir, '..', '..')
const MODULE = 'packages/expo/android/build.gradle'
const CATALOG = 'native/android/gradle/libs.versions.toml'

/** A library the module compiles against in another version than the SDK is tested on. */
interface Drift {
  /** The version the module names. */
  readonly module: string
  /** The version the SDK's catalog names. */
  readonly catalog: string
  /** Why the module does not have the catalog's. */
  readonly reason: string
}

// Tried on 2026-10-13 in an Expo SDK 57 app (Kotlin 2.1.20, Android Gradle plugin 8.12.0):
// with all eight libraries at the catalog's versions `compileDebugKotlin` failed with "Class
// 'kotlin.Unit' was compiled with an incompatible version of Kotlin. The actual metadata
// version is 2.3.0, but the compiler version 2.1.0 can read versions up to 2.2.0"; with only
// Credential Manager and googleid at the catalog's versions it failed the same way on
// googleid's own classes.
//
// Read on 2026-10-13 from the published artifacts in a Gradle cache (the `mv` of a class's
// `kotlin.Metadata`), which is what the compiler compares: kotlinx-serialization-json 1.11.0
// is 2.3.0 and googleid 1.2.1 is 2.4.0, both past what Kotlin 2.1 reads; kotlinx-coroutines
// 1.11.0 is 2.2.0, and Compose 1.11.4, activity-compose 1.13.0 and Credential Manager 1.6.0
// are 2.1.0, which Kotlin 2.1 reads. So for those six the reason is what was tried (all
// together), not a fact about each: none was tried alone, and whether one of them alone
// compiles in an Expo SDK 57 app (its standard library, its minimum compileSdk) is not known.
const TOGETHER =
  'tried with every library at the catalog’s version: the build then brings a Kotlin 2.3 standard library, whose metadata Expo SDK 57’s Kotlin 2.1 compiler cannot read; not tried alone'
const OWN_METADATA =
  'tried at the catalog’s version beside Credential Manager’s: its own classes are published with Kotlin 2.4 metadata, which Expo SDK 57’s Kotlin 2.1 compiler cannot read'
const WITH_GOOGLEID =
  'tried at the catalog’s version only together with googleid 1.2.1, which failed; not tried alone, and kept at the version googleid 1.1.1 was tried with'

const ALLOWED: Record<string, Drift> = {
  'org.jetbrains.kotlinx:kotlinx-serialization-json': {
    module: '1.8.1',
    catalog: '1.11.0',
    reason: TOGETHER,
  },
  'org.jetbrains.kotlinx:kotlinx-coroutines-android': {
    module: '1.10.2',
    catalog: '1.11.0',
    reason: TOGETHER,
  },
  'androidx.compose.ui:ui': { module: '1.8.3', catalog: '1.11.4', reason: TOGETHER },
  'androidx.compose.foundation:foundation': {
    module: '1.8.3',
    catalog: '1.11.4',
    reason: TOGETHER,
  },
  'androidx.activity:activity-compose': {
    module: '1.10.1',
    catalog: '1.13.0',
    reason: TOGETHER,
  },
  'androidx.credentials:credentials': {
    module: '1.5.0',
    catalog: '1.6.0',
    reason: WITH_GOOGLEID,
  },
  'androidx.credentials:credentials-play-services-auth': {
    module: '1.5.0',
    catalog: '1.6.0',
    reason: WITH_GOOGLEID,
  },
  'com.google.android.libraries.identity.googleid:googleid': {
    module: '1.1.1',
    catalog: '1.2.1',
    reason: OWN_METADATA,
  },
}

/**
 * The libraries a Gradle build file compiles against, by `group:artifact`.
 *
 * @param text - The build file.
 * @returns Each library's version, as written.
 */
function moduleLibraries(text: string): Map<string, string> {
  const found = new Map<string, string>()
  for (const match of text.matchAll(/^\s*(?:implementation|api)\s+"([^":]+:[^":]+):([^"]+)"$/gm)) {
    found.set(match[1] as string, match[2] as string)
  }
  return found
}

/**
 * The libraries of a version catalog, by `group:artifact`.
 *
 * @param text - The catalog, in the one form this repository writes it:
 *   `name = { module = "g:a", version.ref = "key" }` under `[libraries]`.
 * @returns Each library's version, from `[versions]`.
 */
function catalogLibraries(text: string): Map<string, string> {
  const section = (name: string) => {
    const from = text.indexOf(`[${name}]\n`)
    if (from === -1) {
      throw new Error(`no [${name}] section`)
    }
    const rest = text.slice(from + name.length + 3)
    const next = rest.search(/^\[/m)
    return next === -1 ? rest : rest.slice(0, next)
  }
  const versions = new Map<string, string>()
  for (const match of section('versions').matchAll(/^([\w-]+) = "([^"]+)"$/gm)) {
    versions.set(match[1] as string, match[2] as string)
  }
  const found = new Map<string, string>()
  for (const line of section('libraries').split('\n')) {
    if (line.trim() === '' || line.startsWith('#')) {
      continue
    }
    const match = /^[\w-]+ = \{ module = "([^"]+)", version\.ref = "([\w-]+)" \}$/.exec(line)
    const version = match === null ? undefined : versions.get(match[2] as string)
    if (match === null || version === undefined) {
      throw new Error(`a line of [libraries] this test cannot read: ${line}`)
    }
    found.set(match[1] as string, version)
  }
  return found
}

/**
 * What is wrong between the module's libraries and the catalog's, given what is allowed.
 *
 * @param module - The module's libraries.
 * @param catalog - The catalog's libraries.
 * @param allowed - The differences that are written down.
 * @returns A sentence a problem; none when every shared library is equal or allowed as it is.
 */
function driftProblems(
  module: Map<string, string>,
  catalog: Map<string, string>,
  allowed: Record<string, Drift>
): string[] {
  const problems: string[] = []
  for (const [library, version] of module) {
    const tested = catalog.get(library)
    if (tested === undefined) {
      problems.push(`${library} is not a library of the SDK's catalog`)
      continue
    }
    const entry = Object.hasOwn(allowed, library) ? allowed[library] : undefined
    if (version === tested) {
      if (entry !== undefined) {
        problems.push(`${library} is at the catalog's version: take its entry out of the list`)
      }
      continue
    }
    if (entry === undefined) {
      problems.push(`${library} is ${version} here and ${tested} in the catalog, with no reason`)
    } else if (entry.module !== version || entry.catalog !== tested) {
      problems.push(
        `${library} is ${version} here and ${tested} in the catalog; the list says ${entry.module} and ${entry.catalog}: was the new pair tried in an Expo app?`
      )
    } else if (entry.reason.trim().length < 40) {
      problems.push(`${library} has no written reason`)
    }
  }
  for (const library of Object.keys(allowed)) {
    if (!module.has(library)) {
      problems.push(`${library} is in the list and not in the module`)
    }
  }
  return problems
}

const moduleText = await Bun.file(join(root, MODULE)).text()
const catalogText = await Bun.file(join(root, CATALOG)).text()

describe('the libraries the Expo module compiles the vendored Kotlin SDK against', () => {
  test('each has the version the SDK is tested on, or a written reason for another', () => {
    const module = moduleLibraries(moduleText)
    expect(module.size).toBe(8)
    expect(driftProblems(module, catalogLibraries(catalogText), ALLOWED)).toEqual([])
  })

  test('every one of them differs today, and the build file says so in plain words', () => {
    // If this stops being true the sentence in the build file, in docs/expo.md and in
    // ADR 0063 is to be rewritten, not only the list.
    expect(Object.keys(ALLOWED)).toHaveLength(moduleLibraries(moduleText).size)
    expect(moduleText).toContain(
      '// THE LIBRARIES BELOW ARE OLDER THAN THE ONES THE SDK IS TESTED ON, every one of them, on'
    )
  })

  test('the catalog is read whole', () => {
    const catalog = catalogLibraries(catalogText)
    expect(catalog.get('androidx.credentials:credentials')).toBe('1.6.0')
    expect(catalog.size).toBeGreaterThanOrEqual(8)
  })

  const module = new Map([
    ['g:same', '1.0.0'],
    ['g:older', '1.0.0'],
  ])
  const catalog = new Map([
    ['g:same', '1.0.0'],
    ['g:older', '2.0.0'],
  ])
  const reason = 'a reason that is long enough to be a sentence somebody wrote down'
  const rows: [string, Map<string, string>, Record<string, Drift>, string[]][] = [
    [
      'a difference with its reason',
      module,
      { 'g:older': { module: '1.0.0', catalog: '2.0.0', reason } },
      [],
    ],
    [
      'a difference nobody wrote down',
      module,
      {},
      ['g:older is 1.0.0 here and 2.0.0 in the catalog, with no reason'],
    ],
    [
      'a version bumped on one side after the reason was written',
      new Map([...module, ['g:older', '1.5.0']]),
      { 'g:older': { module: '1.0.0', catalog: '2.0.0', reason } },
      [
        'g:older is 1.5.0 here and 2.0.0 in the catalog; the list says 1.0.0 and 2.0.0: was the new pair tried in an Expo app?',
      ],
    ],
    [
      'a reason that says nothing',
      module,
      { 'g:older': { module: '1.0.0', catalog: '2.0.0', reason: 'older' } },
      ['g:older has no written reason'],
    ],
    [
      'an entry kept for a library that caught up',
      module,
      {
        'g:older': { module: '1.0.0', catalog: '2.0.0', reason },
        'g:same': { module: '0.9.0', catalog: '1.0.0', reason },
      },
      ["g:same is at the catalog's version: take its entry out of the list"],
    ],
    [
      'a library the SDK is not written on',
      new Map([...module, ['g:extra', '1.0.0']]),
      { 'g:older': { module: '1.0.0', catalog: '2.0.0', reason } },
      ["g:extra is not a library of the SDK's catalog"],
    ],
    [
      'an entry for a library the module no longer has',
      new Map([['g:same', '1.0.0']]),
      { 'g:older': { module: '1.0.0', catalog: '2.0.0', reason } },
      ['g:older is in the list and not in the module'],
    ],
  ]

  test.each(rows)('%s', (_name, has, allowed, problems) => {
    expect(driftProblems(has, catalog, allowed)).toEqual(problems)
  })
})
