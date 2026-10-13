import { describe, expect, test } from 'bun:test'
import defaultExport, {
  type ExpoConfigLike,
  NATIVE_SCREENS_MIN_SDK,
  withRaisedMinSdk,
  withTulaScreens,
} from './plugin'

// The config plugin is a function over a plain object, so it is tested on plain objects:
// `@expo/config-plugins` is not installed here, and no prebuild was run with this plugin
// since it became this package's own (`docs/plans/phase-2-unverified.md`, "Step 2.16").

const APP: ExpoConfigLike = {
  name: 'Example',
  slug: 'example',
  ios: { bundleIdentifier: 'com.example.app' },
  android: { package: 'com.example.app' },
}

describe('withTulaScreens', () => {
  /** A mod, as Expo runs one. */
  type Mod = (config: Record<string, unknown>) => Promise<Record<string, unknown>>
  const modOf = (config: ExpoConfigLike) => config.mods?.android?.gradleProperties as Mod
  const property = (key: string, value: string) => ({ type: 'property', key, value })
  const MIN = property('android.minSdkVersion', '28')

  test('the lowest Android version is what the Kotlin client is written for', () => {
    expect(NATIVE_SCREENS_MIN_SDK).toBe(28)
  })

  test('Expo reaches it as the default export', () => {
    expect(defaultExport).toBe(withTulaScreens)
  })

  test('everything the configuration holds is kept, and the object it was given is not changed', () => {
    const before = structuredClone(APP)
    const config = withTulaScreens(APP)
    const { mods: _mods, ...rest } = config
    expect(rest).toEqual(APP)
    expect(APP).toEqual(before)
  })

  test('the one mod raises the Gradle property and keeps every other line', async () => {
    const config = withTulaScreens(APP)
    expect(Object.keys(config.mods ?? {})).toEqual(['android'])
    expect(Object.keys(config.mods?.android ?? {})).toEqual(['gradleProperties'])
    const lines = [
      { type: 'comment', value: 'Project-wide Gradle settings.' },
      property('android.useAndroidX', 'true'),
      { type: 'empty' },
    ]
    const request = { projectRoot: '/app' }
    const result = await modOf(config)({ name: 'Example', modRequest: request, modResults: lines })
    expect(result).toEqual({
      name: 'Example',
      modRequest: request,
      modResults: [...lines, MIN],
    })
    // What it was handed is not changed.
    expect(lines).toHaveLength(3)
  })

  test.each([
    ['21', '28'],
    ['24', '28'],
    ['27', '28'],
    ['28', '28'],
    ['29', '29'],
    ['35', '35'],
    // Not a version this function can read: it is replaced, never trusted.
    ['', '28'],
    ['latest', '28'],
    ['28.5', '28'],
    ['-1', '28'],
    ['1e9', '28'],
    ['9999', '28'],
  ])('a version of %j that is there becomes %j, in its place', (held, expected) => {
    const lines = [property('a', '1'), property('android.minSdkVersion', held), property('b', '2')]
    expect(withRaisedMinSdk(lines)).toEqual([
      property('a', '1'),
      property('android.minSdkVersion', expected),
      property('b', '2'),
    ])
  })

  test('a higher version the project already has is left alone, the line itself', () => {
    const higher = property('android.minSdkVersion', '31')
    const lines = [property('a', '1'), higher]
    const result = withRaisedMinSdk(lines)
    expect(result).toEqual([property('a', '1'), property('android.minSdkVersion', '31')])
    // Not a copy with the same value: the line that was handed over, and nothing added.
    expect(result[1]).toBe(higher)
    expect(result).toHaveLength(2)
  })

  test('a lower version is raised, which changes a value the project had: the one such change', () => {
    const lower = property('android.minSdkVersion', '24')
    const result = withRaisedMinSdk([lower])
    expect(result).toEqual([property('android.minSdkVersion', '28')])
    // The line that was handed over is not written to.
    expect(lower).toEqual(property('android.minSdkVersion', '24'))
  })

  test.each([[undefined], [null], ['android.minSdkVersion=21'], [{}]])(
    'lines of %j are no list: the property alone',
    (lines) => {
      expect(withRaisedMinSdk(lines)).toEqual([MIN])
    }
  )

  test('a line that is no property of that name is left as it is', () => {
    const lines = [
      null,
      'text',
      { type: 'comment', key: 'android.minSdkVersion', value: '21' },
      property('android.minSdkVersionX', '21'),
    ]
    expect(withRaisedMinSdk(lines)).toEqual([...lines, MIN])
  })

  test('a mod that was there runs after it, on its result, as Expo chains mods', async () => {
    const seen: unknown[] = []
    const earlier: Mod = async (config) => {
      seen.push(config.modResults)
      return {
        ...config,
        modResults: [...(config.modResults as unknown[]), property('later', 'x')],
      }
    }
    const config = withTulaScreens(
      {
        ...APP,
        mods: { android: { gradleProperties: earlier, manifest: earlier }, ios: { x: 1 } },
      },
      {}
    )
    // Every other mod is kept as it was.
    expect(config.mods?.android?.manifest).toBe(earlier)
    expect(config.mods?.ios).toEqual({ x: 1 })
    const result = await modOf(config)({ modResults: [] })
    expect(seen).toEqual([[MIN]])
    expect(result.modResults).toEqual([MIN, property('later', 'x')])
  })

  test('applying it again adds nothing: the same mod, and the property once', async () => {
    const once = withTulaScreens(APP)
    const twice = withTulaScreens(once)
    expect(modOf(twice)).toBe(modOf(once))
    const result = await modOf(twice)({ modResults: [] })
    expect(result.modResults).toEqual([MIN])
    // And the configuration it was given has no mod.
    expect(APP.mods).toBeUndefined()
  })

  test('an empty object of options is no option', () => {
    expect(Object.keys(withTulaScreens(APP, {}).mods?.android ?? {})).toEqual(['gradleProperties'])
  })

  test.each([
    ['yes'],
    [1],
    [null],
    [true],
    [['canary-value']],
    [{ nativeScreens: true }],
    [{ minSdkVersion: 'canary-value' }],
  ])('options of %j are refused, in a fixed sentence that repeats nothing', (props) => {
    let thrown: unknown
    try {
      withTulaScreens(APP, props as never)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(TypeError)
    expect((thrown as TypeError).message).toBe(
      '@tula/expo-screens/plugin: `props` must be left out: it takes no options'
    )
  })
})
