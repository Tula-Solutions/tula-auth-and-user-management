import { describe, expect, test } from 'bun:test'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { THEME_TOKENS } from '@tula-tech/contract/theme'
import { VENDORED_ANDROID_MODULES, VENDORED_SWIFT_LIBRARIES } from '../scripts/vendor'
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
    expect(ignored).toContain('packages/expo-screens/ios/vendor/')
    expect(ignored).toContain('packages/expo-screens/android/vendor/')
    const gradle = await read('android/build.gradle')
    // What the build compiles is what the script copies (`scripts/vendor.ts`, with tests of
    // its own), module for module.
    expect([...gradle.matchAll(/'vendor\/([\w-]+)'/g)].map((match) => match[1])).toEqual([
      ...VENDORED_ANDROID_MODULES,
    ])
    expect([...VENDORED_SWIFT_LIBRARIES]).toEqual(['TulaAuth', 'TulaAuthUI'])
    for (const library of VENDORED_SWIFT_LIBRARIES) {
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
    const indexed = [...source.matchAll(/(?:options\[|flag\()"(\w+)"[\])]/g)].map(
      (match) => match[1] as string
    )
    expect(indexed.length).toBeGreaterThan(0)
    expect(indexed.filter((name) => !known.includes(name))).toEqual([])
    // Never by a name worked out at run time, but in the one helper that is handed a name.
    expect(source.match(/options\[[^"\]]+\]/g) ?? []).toEqual(
      source === swift ? ['options[name]'] : []
    )
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
    // One fixed sentence is all an error says: not even the code is written into it.
    expect(source.match(/"Tula: [^"\n]*"/g)).toEqual(['"Tula: the call failed."'])
    // Kotlin builds no string from a value at all. Swift builds one, a view's identity
    // (the mode's word and the redirect URL), which is never sent anywhere.
    expect(source.match(/\$\{|\$[a-zA-Z_]/g) ?? []).toEqual([])
    expect((source.match(/\\\(/g) ?? []).length).toBe(source === swift ? 2 : 0)
    expect(source).not.toMatch(/localizedDescription|\.message\b|stackTrace|String\(describing:/)
  })

  test('no word of a token is a key of anything it sends', () => {
    const named = literals(source).filter((literal) =>
      /token|secret|password|refresh/i.test(literal)
    )
    expect(named).toEqual(['getToken'])
  })
})

// --- Wiring -------------------------------------------------------------------------------
//
// The tests above hold names. A name can be right and in the wrong place: `background`
// read into `surface`, the `light` overrides laid over the dark scheme, `passkeys` deciding
// whether a device key is kept. `wiringProblems` reads each pairing out of the source and
// says what is not paired with itself; the table after it changes a copy of the source one
// pairing at a time and expects the check to say so. Still text, and still not compiled.

type Language = 'Swift' | 'Kotlin'

/** Every line of `lines` that `source` does not hold, as a problem. */
function missing(source: string, what: string, lines: readonly string[]): string[] {
  return lines.filter((line) => !source.includes(line)).map((line) => `${what}: no \`${line}\``)
}

/** The codes of the native clients' own that a call of the module can fail with. */
const CLIENT_CODE_NAMES: Record<Language, readonly string[]> = {
  Swift: [
    'networkFailed',
    'networkTimeout',
    'responseInvalid',
    'storageFailed',
    'flowBusy',
    'deviceKeyFailed',
    'passkeyUnsupported',
    'passkeyAlreadyOnDevice',
    'passkeyFailed',
    'providerUnsupported',
    'providerFailed',
  ],
  Kotlin: [
    'NETWORK_FAILED',
    'NETWORK_TIMEOUT',
    'RESPONSE_INVALID',
    'STORAGE_FAILED',
    'FLOW_BUSY',
    'DEVICE_KEY_FAILED',
    'PASSKEY_UNSUPPORTED',
    'PASSKEY_ALREADY_ON_DEVICE',
    'PASSKEY_FAILED',
    'PROVIDER_UNSUPPORTED',
    'PROVIDER_FAILED',
  ],
}

function themeProblems(language: Language, source: string): string[] {
  const problems: string[] = []
  const tokens = (scope: 'scheme' | 'shared') =>
    THEME_TOKENS.filter((token) => token.scope === scope).map((token) => token.key)
  // Each token is read under its own key into its own field (and, in Kotlin, falls back to
  // its own default), from the map of its own scope.
  const reads =
    language === 'Swift'
      ? [...source.matchAll(/^( +)set\(\\\.(\w+), "(\w+)"\)$/gm)].map((match) => ({
          scope: (match[1] as string).length > 4 ? 'scheme' : 'shared',
          names: [match[2], match[3]],
        }))
      : [...source.matchAll(/^ +(\w+) = text\((\w+), "(\w+)", (\w+)\.(\w+)\),$/gm)].map(
          (match) => ({
            scope:
              match[2] === 'given' && match[4] === 'from'
                ? 'scheme'
                : match[2] === 'overrides' && match[4] === 'base'
                  ? 'shared'
                  : `${match[2]}/${match[4]}`,
            names: [match[1], match[3], match[5]],
          })
        )
  for (const read of reads) {
    if (new Set(read.names).size !== 1) {
      problems.push(`theme: ${read.names.join(' / ')} are not one token`)
    }
  }
  for (const scope of ['scheme', 'shared'] as const) {
    const found = reads.filter((read) => read.scope === scope).map((read) => read.names[0])
    if (found.join() !== tokens(scope).join()) {
      problems.push(`theme: the ${scope} tokens read are ${found.join()}`)
    }
  }
  if (reads.some((read) => read.scope !== 'scheme' && read.scope !== 'shared')) {
    problems.push('theme: a token is read from a map that is not its own')
  }
  // The light overrides are laid over the light scheme, the dark over the dark.
  const schemes = [
    ...source.matchAll(
      language === 'Swift'
        ? /theme\.(\w+) = scheme\(theme\.(\w+), overrides\["(\w+)"\]\)/g
        : /^ +(\w+) = scheme\(base\.(\w+), overrides\["(\w+)"\]\),$/gm
    ),
  ].map((match) => match.slice(1, 4))
  if (schemes.map((names) => names[0]).join() !== 'light,dark') {
    problems.push(`theme: the schemes built are ${schemes.map((names) => names[0]).join()}`)
  }
  for (const names of schemes) {
    if (new Set(names).size !== 1) {
      problems.push(`theme: ${names.join(' / ')} are not one scheme`)
    }
  }
  return problems
}

function optionProblems(language: Language, source: string): string[] {
  const problems: string[] = []
  // Each option is read by its own name, as its own type, into a value of that name.
  const reads =
    language === 'Swift'
      ? [
          ...source.matchAll(
            /^ +(?:let|guard\n +let) (\w+) = (?:options\["(\w+)"\] as\? (String)|(flag)\("(\w+)"\))/gm
          ),
        ].map((match) => ({
          local: match[1] as string,
          option: (match[2] ?? match[5]) as string,
          type: match[3] === 'String' ? 'string' : 'boolean',
        }))
      : [...source.matchAll(/^ +val (\w+) = options\["(\w+)"\] (as\? String|== true)$/gm)].map(
          (match) => ({
            local: match[1] as string,
            option: match[2] as string,
            type: match[3] === 'as? String' ? 'string' : 'boolean',
          })
        )
  const renamed: Record<string, string> =
    language === 'Swift' ? { baseUrl: 'baseURL' } : { browser: 'withBrowser' }
  const platformOnly = language === 'Swift' ? 'googleWebClientId' : 'apple'
  const expected = Object.entries(SCREENS_OPTION_TYPES)
    .filter(([option]) => option !== platformOnly)
    .map(([option, type]) => `${renamed[option] ?? option} = ${option}: ${type}`)
  const found = reads.map((read) => `${read.local} = ${read.option}: ${read.type}`)
  if ([...found].sort().join('\n') !== [...expected].sort().join('\n')) {
    problems.push(`options: read as ${found.join(', ')}`)
  }
  // And each value decides its own part of the client, and no other.
  problems.push(
    ...missing(
      source,
      'options',
      language === 'Swift'
        ? [
            'func flag(_ name: String) -> Bool {',
            'options[name] as? Bool == true',
            'publishableKey: publishableKey,',
            'baseURL: baseURL,',
            'sessionProfile: sessionProfile,',
            'deviceKeys: deviceBinding ? KeychainDeviceKeyStore() : nil,',
            'passkeys: passkeys ? SystemPasskeySheet(anchor: { tulaAnchor() }) : nil,',
            'apple: apple ? SystemAppleSheet(anchor: { tulaAnchor() }) : nil,',
            'browser: browser ? SystemBrowserSession(anchor: { tulaAnchor() }) : nil',
          ]
        : [
            'publishableKey = publishableKey,',
            'baseUrl = baseUrl,',
            'sessionProfile = sessionProfile,',
            'passkeys = if (passkeys) CredentialManagerPasskeySheet(activities.read) else null,',
            'google = googleWebClientId?.let { CredentialManagerGoogleSheet(it, activities.read) },',
            'val tabs = if (withBrowser) CustomTabsBrowserSession(activities.read) else null',
            'browser = tabs,',
            'deviceKeys = if (deviceBinding) KeystoreDeviceKeyStore() else null,',
          ]
    )
  )
  return problems
}

function modeProblems(language: Language, source: string): string[] {
  // The JavaScript sends 'sign-up' or 'sign-in'; anything else is a sign-in.
  return missing(
    source,
    'mode',
    language === 'Swift'
      ? [
          'view.mode = mode == "sign-up" ? .signUp : .signIn',
          'identity: "\\(mode == .signUp ? "sign-up" : "sign-in")\\n\\(redirectURL ?? "")",',
        ]
      : ['view.mode.value = if (mode == "sign-up") TulaAuthMode.SIGN_UP else TulaAuthMode.SIGN_IN']
  )
}

function codeProblems(language: Language, source: string): string[] {
  const problems: string[] = []
  const clientCodes = [
    ...source.matchAll(
      language === 'Swift' ? /TulaClientErrorCode\.(\w+)/g : /ClientErrorCodes\.(\w+)/g
    ),
  ].map((match) => match[1])
  if ([...clientCodes].sort().join() !== [...CLIENT_CODE_NAMES[language]].sort().join()) {
    problems.push(`codes: the client's codes named are ${clientCodes.join()}`)
  }
  if (language === 'Swift') {
    // A failure's code is set in two places, and both go through the closed set.
    const set = [...source.matchAll(/^ +code = (.*)$/gm)].map((match) => match[1] as string)
    if (set.length !== 2 || !set.every((to) => to.startsWith('TulaScreensCode.crossing('))) {
      problems.push(`codes: a failure's code is set to ${set.join(' and ')}`)
    }
    // And only a failure is ever made into what JavaScript catches.
    const made = [...source.matchAll(/\bException\(([^\n]*)\)$/gm)].map((match) => match[1])
    if (
      made.join('\n') !==
      'name: "TulaScreensException", description: "Tula: the call failed.", code: TulaScreensFailure(error).code'
    ) {
      problems.push(`codes: an exception is made with ${made.join(' and ')}`)
    }
    problems.push(
      ...missing(source, 'codes', [
        'if own.contains(raw) || client.contains(raw) {',
        'if case .unknown = ErrorCode(rawValue: raw) {',
        'return `internal`',
      ])
    )
    const thrown = [...source.matchAll(/\bthrow (\S+)/g)].map((match) => match[1] as string)
    const allowed = /^(crossing\(error\)|TulaScreensFailure\(code:)$/
    if (thrown.length === 0 || !thrown.every((what) => allowed.test(what))) {
      problems.push(`codes: thrown are ${thrown.join(', ')}`)
    }
  } else {
    // The one exception that crosses is made in one place, from a code of the closed set.
    const made = [...source.matchAll(/CodedException\(([^)]*\)?[^)]*)\)/g)].map((match) => match[1])
    if (made.join('\n') !== 'crossing(code), "Tula: the call failed.", null') {
      problems.push(`codes: an exception is made with ${made.join(' and ')}`)
    }
    problems.push(
      ...missing(source, 'codes', [
        'internal class Refusal(code: String) : CodedException(crossing(code), "Tula: the call failed.", null)',
        'if (raw in OWN_CODES || raw in CLIENT_CODES) {',
        'if (ErrorCode.of(raw) is ErrorCode.Unknown) ScreensCode.INTERNAL else raw',
        '} catch (refused: Refusal) {',
        'throw Refusal(failed.code)',
        'throw Refusal(ScreensCode.INTERNAL)',
      ])
    )
    const thrown = [...source.matchAll(/\bthrow (\S+)/g)].map((match) => match[1] as string)
    const allowed = /^(cancelled|refused|Refusal\((failed\.code|ScreensCode\.\w+)\))$/
    if (thrown.length === 0 || !thrown.every((what) => allowed.test(what))) {
      problems.push(`codes: thrown are ${thrown.join(', ')}`)
    }
    // Every function of the module runs inside the guard, `configure` included.
    const functions = [
      ...source.matchAll(/^ +(?:Async)?Function\("(\w+)"\) (?:Coroutine )?\{[^\n]*\n +(\w+)/gm),
    ].map((match) => `${match[1]}: ${match[2]}`)
    const guarded = ['configure', 'load', 'getState', 'getToken', 'signOut'].map(
      (name) => `${name}: guarded`
    )
    if (functions.join() !== guarded.join()) {
      problems.push(`codes: the functions begin with ${functions.join(', ')}`)
    }
  }
  return problems
}

function lifetimeProblems(language: Language, source: string): string[] {
  if (language === 'Swift') {
    // Sheets and the browser look for the window when they are shown, and the task that
    // watches the session ends with the module.
    return [
      ...missing(source, 'lifetime', ['private func tulaAnchor() -> ASPresentationAnchor {']),
      ...(/OnDestroy \{\n +self\.watching\?\.cancel\(\)\n +self\.watching = nil\n +\}/.test(source)
        ? []
        : ['lifetime: the module does not end its watching when it is destroyed']),
    ]
  }
  const problems = missing(source, 'lifetime', [
    'private val activities = Latest<Activity>()',
    'activities.replace(activity)',
  ])
  // The activity's provider is taken before `configure` can leave, by any way.
  const body = source.slice(source.indexOf('fun configure('))
  const taken = body.indexOf('activities.replace(activity)')
  const leaves = [body.indexOf('return'), body.indexOf('throw ')].filter((at) => at !== -1)
  if (taken === -1 || leaves.length !== 2 || leaves.some((at) => at < taken)) {
    problems.push('lifetime: `configure` can leave before it took the activity provider')
  }
  // No sheet is handed the provider of the call that happened to make the client.
  const handed = [
    ...source.matchAll(
      /\b(?:CustomTabsBrowserSession|CredentialManagerPasskeySheet|CredentialManagerGoogleSheet)\(([^)]*)\)/g
    ),
  ].map((match) => match[1] as string)
  if (handed.length !== 3 || !handed.every((argument) => argument.endsWith('activities.read'))) {
    problems.push(`lifetime: the sheets are handed ${handed.join(' and ')}`)
  }
  // `Latest` is plain Kotlin that asks its newest provider at each call.
  const latest = source.slice(source.indexOf('internal class Latest<'))
  problems.push(
    ...missing(latest.slice(0, latest.indexOf('\n}\n') + 3), 'lifetime', [
      '@Volatile\n    private var provider: () -> T? = { null }',
      'provider = next',
      'val read: () -> T? = { provider() }',
    ])
  )
  if (!/OnDestroy \{\n +scope\.cancel\(\)\n +\}/.test(source)) {
    problems.push('lifetime: the module does not end its watching when it is destroyed')
  }
  return problems
}

function wiringProblems(language: Language, source: string): string[] {
  return [
    ...themeProblems(language, source),
    ...optionProblems(language, source),
    ...modeProblems(language, source),
    ...codeProblems(language, source),
    ...lifetimeProblems(language, source),
  ]
}

/** `source` with its one `from` replaced by `to`. Throws when `from` is not there once. */
function changed(source: string, from: string, to: string): string {
  if (source.split(from).length !== 2) {
    throw new Error(`the source does not hold \`${from}\` exactly once`)
  }
  return source.replace(from, () => to)
}

describe('each thing is wired to itself', () => {
  test.each(BOTH)('%s: nothing is crossed', (language, source) => {
    expect(wiringProblems(language as Language, source)).toEqual([])
  })

  test('`Latest` names nothing of Android or Expo, so it could be run anywhere', async () => {
    const latest = await read(`${KOTLIN}/Latest.kt`)
    expect(latest.match(/^import .*$/gm) ?? []).toEqual([])
  })

  // One row a mutation: the source with one pairing changed, and the word the check must
  // say. A row whose text is no longer in the source throws, so a row cannot pass by
  // changing nothing.
  const mutations: [string, Language, string, string, string][] = [
    [
      'two theme tokens swapped (the key)',
      'Swift',
      'set(\\.background, "background")',
      'set(\\.background, "surface")',
      'theme: background / surface are not one token',
    ],
    [
      'two theme tokens swapped (the field)',
      'Swift',
      'set(\\.textMuted, "textMuted")',
      'set(\\.text, "textMuted")',
      'theme: text / textMuted are not one token',
    ],
    [
      'a shared token read under another name',
      'Swift',
      'set(\\.radius, "radius")',
      'set(\\.radius, "radiusSmall")',
      'theme: radius / radiusSmall are not one token',
    ],
    [
      'a theme token left out',
      'Swift',
      '        set(\\.overlay, "overlay")\n',
      '',
      'theme: the scheme tokens read are',
    ],
    [
      '`light` and `dark` swapped',
      'Swift',
      'theme.light = scheme(theme.light, overrides["light"])',
      'theme.light = scheme(theme.light, overrides["dark"])',
      'theme: light / light / dark are not one scheme',
    ],
    [
      'the dark overrides laid over the light scheme',
      'Swift',
      'theme.dark = scheme(theme.dark, overrides["dark"])',
      'theme.dark = scheme(theme.light, overrides["dark"])',
      'theme: dark / light / dark are not one scheme',
    ],
    [
      'two theme tokens swapped (the key)',
      'Kotlin',
      'background = text(given, "background", from.background),',
      'background = text(given, "surface", from.background),',
      'theme: background / surface / background are not one token',
    ],
    [
      'two theme tokens swapped (the default)',
      'Kotlin',
      'danger = text(given, "danger", from.danger),',
      'danger = text(given, "danger", from.dangerSurface),',
      'theme: danger / danger / dangerSurface are not one token',
    ],
    [
      'a scheme token read from the shared map',
      'Kotlin',
      'link = text(given, "link", from.link),',
      'link = text(overrides, "link", from.link),',
      'theme: a token is read from a map that is not its own',
    ],
    [
      '`light` and `dark` swapped',
      'Kotlin',
      'light = scheme(base.light, overrides["light"]),',
      'light = scheme(base.light, overrides["dark"]),',
      'theme: light / light / dark are not one scheme',
    ],
    [
      'the dark overrides laid over the light scheme',
      'Kotlin',
      'dark = scheme(base.dark, overrides["dark"]),',
      'dark = scheme(base.light, overrides["dark"]),',
      'theme: dark / light / dark are not one scheme',
    ],
    [
      'two option flags read under each other’s name',
      'Swift',
      'let deviceBinding = flag("deviceBinding")',
      'let deviceBinding = flag("passkeys")',
      'options: read as',
    ],
    [
      'an option flag deciding another part of the client',
      'Swift',
      'deviceKeys: deviceBinding ? KeychainDeviceKeyStore() : nil,',
      'deviceKeys: passkeys ? KeychainDeviceKeyStore() : nil,',
      'options: no `deviceKeys: deviceBinding',
    ],
    [
      'the browser switched on by Apple’s flag',
      'Swift',
      'browser: browser ? SystemBrowserSession',
      'browser: apple ? SystemBrowserSession',
      'options: no `browser: browser',
    ],
    [
      'two option flags read under each other’s name',
      'Kotlin',
      'val passkeys = options["passkeys"] == true',
      'val passkeys = options["deviceBinding"] == true',
      'options: read as',
    ],
    [
      'an option flag deciding another part of the client',
      'Kotlin',
      'deviceKeys = if (deviceBinding) KeystoreDeviceKeyStore() else null,',
      'deviceKeys = if (passkeys) KeystoreDeviceKeyStore() else null,',
      'options: no `deviceKeys = if (deviceBinding)',
    ],
    [
      'the browser switched on by the passkey flag',
      'Kotlin',
      'val tabs = if (withBrowser) CustomTabsBrowserSession',
      'val tabs = if (passkeys) CustomTabsBrowserSession',
      'options: no `val tabs = if (withBrowser)',
    ],
    [
      'an option read as the wrong type',
      'Kotlin',
      'val googleWebClientId = options["googleWebClientId"] as? String',
      'val googleWebClientId = options["googleWebClientId"] == true',
      'options: read as',
    ],
    [
      'an option read as the wrong type',
      'Swift',
      'let sessionProfile = options["sessionProfile"] as? String',
      'let sessionProfile = flag("sessionProfile")',
      'options: read as',
    ],
    [
      'the mode’s mapping turned round',
      'Swift',
      'mode == "sign-up" ? .signUp : .signIn',
      'mode == "sign-up" ? .signIn : .signUp',
      'mode: no `view.mode = mode == "sign-up" ? .signUp : .signIn`',
    ],
    [
      'the mode read by another word',
      'Swift',
      'view.mode = mode == "sign-up"',
      'view.mode = mode == "sign-in"',
      'mode: no `view.mode = mode == "sign-up" ? .signUp : .signIn`',
    ],
    [
      'the mode’s mapping turned round',
      'Kotlin',
      'TulaAuthMode.SIGN_UP else TulaAuthMode.SIGN_IN',
      'TulaAuthMode.SIGN_IN else TulaAuthMode.SIGN_UP',
      'mode: no `view.mode.value = if (mode == "sign-up")',
    ],
    [
      'a server’s code crossing as it came',
      'Swift',
      '?? TulaScreensCode.internal\n        code = TulaScreensCode.crossing(raw)',
      '?? TulaScreensCode.internal\n        code = raw',
      'codes: a failure’s code is set to',
    ],
    [
      'the code written into the sentence',
      'Swift',
      'description: "Tula: the call failed.", code: TulaScreensFailure(error).code',
      'description: "Tula: the call failed (" + TulaScreensFailure(error).code + ").", code: TulaScreensFailure(error).code',
      'codes: an exception is made with',
    ],
    [
      'a code the contract does not know let through',
      'Swift',
      'if case .unknown = ErrorCode(rawValue: raw) {',
      'if raw.isEmpty {',
      'codes: no `if case .unknown = ErrorCode(rawValue: raw) {`',
    ],
    [
      'a server’s code crossing as it came',
      'Kotlin',
      ': CodedException(crossing(code), "Tula: the call failed.", null)',
      ': CodedException(code, "Tula: the call failed.", null)',
      'codes: an exception is made with',
    ],
    [
      'a code the contract does not know let through',
      'Kotlin',
      'if (ErrorCode.of(raw) is ErrorCode.Unknown) ScreensCode.INTERNAL else raw',
      'raw',
      'codes: no `if (ErrorCode.of(raw) is ErrorCode.Unknown)',
    ],
    [
      'Expo’s own exceptions passed on',
      'Kotlin',
      '} catch (refused: Refusal) {',
      '} catch (refused: CodedException) {',
      'codes: no `} catch (refused: Refusal) {`',
    ],
    [
      '`configure` outside the guard',
      'Kotlin',
      'guarded { TulaScreensHost.configure(',
      'run { TulaScreensHost.configure(',
      'codes: the functions begin with configure: run',
    ],
    [
      'a sheet handed the provider of the call that made the client',
      'Kotlin',
      'CredentialManagerPasskeySheet(activities.read)',
      'CredentialManagerPasskeySheet(activity)',
      'lifetime: the sheets are handed',
    ],
    [
      'the same options again leaving before the provider is taken',
      'Kotlin',
      '        activities.replace(activity)\n',
      '',
      'lifetime: no `activities.replace(activity)`',
    ],
    [
      'the provider read once, when the holder is made',
      'Kotlin',
      'val read: () -> T? = { provider() }',
      'val read: () -> T? = provider',
      'lifetime: no `val read: () -> T? = { provider() }`',
    ],
    [
      'the watching task left running',
      'Swift',
      'OnDestroy {\n            self.watching?.cancel()',
      'OnDestroy {\n            _ = self.watching',
      'lifetime: the module does not end its watching when it is destroyed',
    ],
  ]

  test.each(mutations)('%s (%s) is found', (_name, language, from, to, said) => {
    const source = language === 'Swift' ? swift : kotlin
    expect(wiringProblems(language, source)).toEqual([])
    const problems = wiringProblems(language, changed(source, from, to))
    expect(problems.join('\n').replaceAll('’', "'")).toContain(said.replaceAll('’', "'"))
  })

  test('the provider is taken first even when the same options come again', () => {
    // The row above removes the line; this one moves it below the early return, which is
    // the fault that was there: a JavaScript reload's `configure` changed nothing.
    const moved = changed(kotlin, '        activities.replace(activity)\n', '').replace(
      '        browser = tabs\n',
      '        browser = tabs\n        activities.replace(activity)\n'
    )
    expect(moved).toContain('browser = tabs\n        activities.replace(activity)')
    expect(wiringProblems('Kotlin', moved)).toEqual([
      'lifetime: `configure` can leave before it took the activity provider',
    ])
  })
})

describe('the lowest Android version', () => {
  test('the module refuses below the version the plugin raises the project to', () => {
    expect(NATIVE_SCREENS_MIN_SDK).toBe(28)
    // Android 9 is API 28, `Build.VERSION_CODES.P`.
    expect(kotlin).toContain('Build.VERSION.SDK_INT < Build.VERSION_CODES.P')
  })
})
