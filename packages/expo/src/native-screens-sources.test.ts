import { describe, expect, test } from 'bun:test'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { THEME_TOKENS } from '@tula/contract/theme'
import {
  SCREENS_MESSAGES,
  SCREENS_MODULE_NAME,
  SCREENS_OPTION_TYPES,
  SCREENS_VIEW_NAMES,
  SESSION_EVENT,
} from './native-screens-core'
import { NATIVE_SCREENS_MIN_SDK } from './plugin'

// The native module's Swift and Kotlin sources, read as text and held to the JavaScript
// that talks to them. No job of `verify` has a Swift or a Kotlin toolchain, and nothing
// here compiles either: what these tests show is that the names the two sides exchange
// (the module, its views, functions, events, props, options and codes) are the same
// names, and that the package ships what it says. What was compiled, and with what, is in
// `docs/plans/phase-2-unverified.md`, "Step 2.16".

const root = join(import.meta.dir, '..')
const read = (path: string) => Bun.file(join(root, path)).text()

const SWIFT = 'ios/TulaExpoScreens'
const KOTLIN = 'android/src/main/java/dev/tula/expo/screens'

async function sourcesIn(directory: string, extension: string): Promise<string> {
  const names = (await readdir(join(root, directory))).filter((name) => name.endsWith(extension))
  expect(names.length).toBeGreaterThan(0)
  return (await Promise.all(names.sort().map((name) => read(`${directory}/${name}`)))).join('\n')
}

const swift = await sourcesIn(SWIFT, '.swift')
const kotlin = await sourcesIn(KOTLIN, '.kt')
const BOTH: [string, string][] = [
  ['Swift', swift],
  ['Kotlin', kotlin],
]

/** Every string literal of a source that has no interpolation and no escape in it. */
function literals(source: string): string[] {
  return [...source.matchAll(/"([^"\\\n]*)"/g)].map((match) => match[1] as string)
}

describe('the package ships its native module', () => {
  test('the manifest lists the native directories and the module file beside the build output', async () => {
    const manifest = (await Bun.file(join(root, 'package.json')).json()) as {
      files: string[]
      scripts: Record<string, string>
    }
    expect(manifest.files).toEqual(['dist', 'android', 'ios', 'expo-module.config.json'])
    // The native SDKs' sources are copied in before every build: a packed package holds
    // what its native module is compiled from.
    expect(manifest.scripts.prebuild).toBe('bun run scripts/vendor-native.ts')
  })

  test('Expo is told the module of each platform, and each is a class of the sources', async () => {
    const config = (await Bun.file(join(root, 'expo-module.config.json')).json()) as object
    expect(config).toEqual({
      platforms: ['apple', 'android'],
      apple: { modules: ['TulaScreensModule'] },
      android: { modules: ['dev.tula.expo.screens.TulaScreensModule'] },
    })
    expect(swift).toMatch(/public final class TulaScreensModule: Module \{/)
    expect(kotlin).toMatch(/^package dev\.tula\.expo\.screens$/m)
    expect(kotlin).toMatch(/^class TulaScreensModule : Module\(\) \{/m)
  })

  test('the copies of the native SDKs are made by the build and never committed', async () => {
    const ignored = await Bun.file(join(root, '..', '..', '.gitignore')).text()
    expect(ignored).toContain('packages/expo/ios/vendor/')
    expect(ignored).toContain('packages/expo/android/vendor/')
    const script = await read('scripts/vendor-native.ts')
    const gradle = await read('android/build.gradle')
    for (const module of ['tula-auth', 'tula-auth-ui', 'tula-auth-android', 'tula-auth-compose']) {
      expect(script).toContain(`'${module}'`)
      expect(gradle).toContain(`'vendor/${module}'`)
    }
    for (const library of ['TulaAuth', 'TulaAuthUI']) {
      expect(script).toContain(`to: 'ios/vendor/${library}'`)
      expect(await read(`ios/${library}.podspec`)).toContain(
        `s.source_files = 'vendor/${library}/**/*.swift'`
      )
    }
  })

  test('the Android module adds no library beyond what the SDK is written on', async () => {
    const gradle = await read('android/build.gradle')
    const libraries = [...gradle.matchAll(/implementation "([^":]+:[^":]+):[^"]+"/g)].map(
      (match) => match[1]
    )
    expect(libraries).toEqual([
      'org.jetbrains.kotlinx:kotlinx-serialization-json',
      'org.jetbrains.kotlinx:kotlinx-coroutines-android',
      'androidx.compose.ui:ui',
      'androidx.compose.foundation:foundation',
      'androidx.activity:activity-compose',
      'androidx.credentials:credentials',
      'androidx.credentials:credentials-play-services-auth',
      'com.google.android.libraries.identity.googleid:googleid',
    ])
  })

  test('the iOS module depends on Expo and the two libraries, and on nothing else', async () => {
    const podspec = await read('ios/TulaExpoScreens.podspec')
    expect([...podspec.matchAll(/s\.dependency '([^']+)'/g)].map((match) => match[1])).toEqual([
      'ExpoModulesCore',
      'TulaAuth',
      'TulaAuthUI',
    ])
    for (const library of ['TulaAuth', 'TulaAuthUI']) {
      const own = await read(`ios/${library}.podspec`)
      expect([...own.matchAll(/s\.dependency '([^']+)'/g)].map((match) => match[1])).toEqual(
        library === 'TulaAuthUI' ? ['TulaAuth'] : []
      )
    }
  })
})

describe.each(BOTH)('the %s module and the JavaScript use the same names', (_language, source) => {
  test('the module', () => {
    expect(source).toContain(`Name("${SCREENS_MODULE_NAME}")`)
  })

  test('the two views, named as their classes are', () => {
    const views = [...source.matchAll(/^\s*View\((\w+)(?:\.self|::class)\) \{/gm)].map(
      (match) => match[1]
    )
    expect(views).toEqual([SCREENS_VIEW_NAMES.auth, SCREENS_VIEW_NAMES.account])
    for (const view of views) {
      expect(source).toMatch(new RegExp(`class ${view}\\b`))
    }
  })

  test('the functions', () => {
    const functions = [...source.matchAll(/^\s*(?:Async)?Function\("(\w+)"\)/gm)].map(
      (match) => match[1]
    )
    expect(functions).toEqual(['configure', 'load', 'getState', 'getToken', 'signOut'])
  })

  test('the events, and nothing else is ever sent', () => {
    expect(literals(source)).toContain(SESSION_EVENT)
    const events = [...source.matchAll(/^\s*Events\(("?\w+"?)\)/gm)].map((match) => match[1])
    expect(events).toHaveLength(3)
    expect(events.slice(1)).toEqual(['"onSignedIn"', '"onSignedOut"'])
    // The module's event is sent with the state's body; a view's event with nothing.
    const sent = [...source.matchAll(/sendEvent\(([^)]*\))/g)].map((match) => match[1])
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatch(/^\w+, (tulaStateBody\(state\)|stateBody\(it\))$/)
    const told = [...source.matchAll(/\b(?:told|onSignedIn|onSignedOut)\(([^)]*)\)/g)]
      .map((match) => match[1])
      .filter((argument) => argument !== undefined && argument !== '')
    expect(new Set(told)).toEqual(new Set([source === swift ? '[:]' : 'emptyMap(']))
  })

  test('the props of each view', () => {
    const props = [...source.matchAll(/^\s*Prop\("(\w+)"\)/gm)].map((match) => match[1])
    expect(props).toEqual(['mode', 'theme', 'redirectUrl', 'theme'])
    expect(literals(source)).toContain('sign-up')
  })

  test('the state is a status and two ids, in the words the JavaScript reads', () => {
    for (const word of ['status', 'loading', 'signed-out', 'signed-in', 'sessionId', 'userId']) {
      expect(literals(source)).toContain(word)
    }
  })

  test('every option it reads is an option the JavaScript hands over', () => {
    const known = Object.keys(SCREENS_OPTION_TYPES)
    const read = literals(source).filter((literal) => known.includes(literal))
    const platformOnly = source === swift ? ['googleWebClientId'] : ['apple']
    expect([...new Set(read)].sort()).toEqual(
      known.filter((name) => !platformOnly.includes(name)).sort()
    )
    // And it indexes the options by no other name.
    const indexed = [...source.matchAll(/options\["(\w+)"\]/g)].map((match) => match[1] as string)
    expect(indexed.every((name) => known.includes(name))).toBe(true)
  })

  test('every code of its own has a sentence on this side', () => {
    const codes = [...new Set(literals(source).filter((literal) => literal.startsWith('screens.')))]
    const expected = Object.keys(SCREENS_MESSAGES).filter(
      // Only the Kotlin client has a lowest version of the system it refuses below.
      (code) => source === kotlin || code !== 'screens.unsupported'
    )
    expect(codes.sort()).toEqual(expected.sort())
    expect(literals(source)).toContain('internal')
  })

  test('every token of the theme has its place', () => {
    for (const token of THEME_TOKENS) {
      expect(literals(source), token.key).toContain(token.key)
    }
    expect(literals(source)).toContain('light')
    expect(literals(source)).toContain('dark')
  })

  test('nothing is logged, and no error keeps what was thrown', () => {
    expect(source).not.toMatch(
      /\b(print|debugPrint|NSLog|os_log|println)\(|\bLogger\(|\bLog\.[a-z]\(/
    )
    // One fixed sentence around the code is all an error says.
    const sentences = source.match(/"Tula: [^"\n]*"/g)
    expect(sentences).toEqual([
      source === swift ? '"Tula: the call failed (\\(code))."' : '"Tula: the call failed ($code)."',
    ])
    expect(source).not.toMatch(/localizedDescription|\.message\b|stackTrace|String\(describing:/)
  })

  test('no word of a token is a key of anything it sends', () => {
    const named = literals(source).filter((literal) =>
      /token|secret|password|refresh/i.test(literal)
    )
    expect(named).toEqual(['getToken'])
  })
})

describe('the lowest Android version', () => {
  test('the module refuses below the version the plugin raises the project to', () => {
    expect(NATIVE_SCREENS_MIN_SDK).toBe(28)
    // Android 9 is API 28, `Build.VERSION_CODES.P`.
    expect(kotlin).toContain('Build.VERSION.SDK_INT < Build.VERSION_CODES.P')
  })
})
