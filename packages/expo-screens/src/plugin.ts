// `@tula/expo-screens/plugin`: the Expo config plugin of the native screens. It runs in Node
// while an app's configuration is read (`expo prebuild`, EAS Build), never in the app, and
// imports nothing: it is a function from one configuration object to another, so it needs
// no `@expo/config-plugins` and is tested on plain objects. It is built as CommonJS, which
// is how Expo loads a plugin (`require`), and as a module beside it for an `import`.
//
// It is apart from `@tula/expo/plugin` on purpose (ADR 0063): an app on the headless client
// lists that one and never this one, and an app that draws the native screens lists this
// one, with or without the other.

/**
 * The options of the plugin: there are none. Listing the plugin is the whole request.
 *
 * @example
 * ```ts
 * // app.config.ts
 * export default { name: 'Example', slug: 'example', plugins: ['@tula/expo-screens/plugin'] }
 * ```
 */
export type TulaScreensPluginProps = Readonly<Record<string, never>>

/**
 * As much of an Expo configuration as the plugin reads or writes. Everything else is kept
 * as it is.
 */
export interface ExpoConfigLike {
  /**
   * The functions Expo runs over the native project when it generates one. This plugin
   * sets one: `mods.android.gradleProperties`.
   */
  mods?: { readonly android?: Readonly<Record<string, unknown>>; readonly [key: string]: unknown }
  [key: string]: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The lowest Android API level the native screens run on (`tula-auth-android`, ADR 0054). */
export const NATIVE_SCREENS_MIN_SDK = 28

/** The Gradle property an Expo project reads its `minSdkVersion` from. */
const MIN_SDK_PROPERTY = 'android.minSdkVersion'

/** What marks this plugin's own function among a configuration's mods. */
const RAISES_MIN_SDK = 'tulaRaisesMinSdk'

/**
 * The lines of `gradle.properties`, as Expo hands them to a mod, with the lowest Android
 * version raised to what the native screens need.
 *
 * This is the one place the plugin changes a value that is already there: it adds the
 * property where there is none, and **raises** one that is lower (or that is not a number
 * of one to three digits, which it cannot read as a version). It never lowers: a value of
 * 28 or more is left as it is, the very line that was handed over, and so is every other
 * line. So a project that had asked for a lower version is overruled, on purpose (the
 * Kotlin SDK does not run below Android 9, and the package's Android module says 28 as its
 * own minimum), and the docs say so.
 *
 * Its order against another plugin that sets the same property (`expo-build-properties`)
 * was not tried: `docs/plans/phase-2-unverified.md`, "Step 2.16".
 *
 * @param lines - Expo's `modResults` of `android.gradleProperties`: a list of
 *   `{ type: 'property', key, value }` among comments and empty lines.
 * @returns The lines, with the property set.
 *
 * @example
 * ```ts
 * withRaisedMinSdk([{ type: 'property', key: 'android.minSdkVersion', value: '24' }])
 * // [{ type: 'property', key: 'android.minSdkVersion', value: '28' }]
 * ```
 */
export function withRaisedMinSdk(lines: unknown): unknown[] {
  const list = Array.isArray(lines) ? (lines as unknown[]) : []
  const wanted = { type: 'property', key: MIN_SDK_PROPERTY, value: String(NATIVE_SCREENS_MIN_SDK) }
  let found = false
  const raised = list.map((line) => {
    if (!isRecord(line) || line.type !== 'property' || line.key !== MIN_SDK_PROPERTY) {
      return line
    }
    found = true
    const held = typeof line.value === 'string' && /^[0-9]{1,3}$/.test(line.value)
    return held && Number(line.value) >= NATIVE_SCREENS_MIN_SDK ? line : { ...line, ...wanted }
  })
  return found ? raised : [...raised, wanted]
}

/** A mod, as Expo calls one: the configuration with the file's contents, to the same. */
type Mod = (config: Record<string, unknown>) => unknown

/**
 * The `android.gradleProperties` mod with the raised version in front of it. Expo runs
 * the mod a configuration holds with the file's lines as `modResults`; the one that was
 * there before runs after this one, on its result, which is how Expo's own `withMod`
 * chains them. The plugin still imports nothing.
 */
function raisingMinSdk(previous: unknown): Mod {
  if (typeof previous === 'function' && Object.hasOwn(previous, RAISES_MIN_SDK)) {
    // Applied before: nothing is added twice.
    return previous as Mod
  }
  const mod: Mod = async (config) => {
    const next = { ...config, modResults: withRaisedMinSdk(config.modResults) }
    return typeof previous === 'function' ? (previous as Mod)(next) : next
  }
  return Object.assign(mod, { [RAISES_MIN_SDK]: true })
}

/**
 * The Expo config plugin of `@tula/expo-screens`: the lowest Android version the native
 * screens need.
 *
 * The Kotlin client under the Compose screens is written for Android 9 (API 28) and later,
 * the package's Android module declares that as its own minimum, and the native module
 * refuses to start below it (`screens.unsupported`). With this plugin the Android
 * project's `android.minSdkVersion` Gradle property is raised to 28 when the native
 * project is generated; without it, an app whose minimum is lower fails its manifest merge
 * (the manifest merger's documented behaviour for a library with a higher minimum; not
 * tried here). iOS needs nothing: the screens build for iOS 16 and Expo's own floor is
 * above that.
 *
 * It adds, and raises one value, never lowers: what the configuration already holds is
 * kept, applying the plugin again changes nothing (the same mod, the property once), and
 * the object it was given is not changed. The one value already there that it changes is
 * `android.minSdkVersion` when it is below 28 ({@link withRaisedMinSdk}); a higher one is
 * kept. It writes what an Expo configuration can say and no native file itself: one
 * function Expo runs over `gradle.properties`. It takes no options: anything handed to it
 * as options is refused with a `TypeError` whose sentence is fixed and repeats nothing it
 * was given.
 *
 * Whether Expo's prebuild runs this mod as written here was not tried since the plugin
 * became this package's own: `docs/plans/phase-2-unverified.md`, "Step 2.16".
 *
 * @param config - The app's Expo configuration.
 * @param props - Nothing: leave it out, or pass an empty object.
 * @returns A new configuration with the mod set.
 * @throws TypeError when options are given.
 *
 * @example
 * ```ts
 * // app.config.ts
 * import { withTulaScreens } from '@tula/expo-screens/plugin'
 *
 * export default withTulaScreens({
 *   name: 'Example',
 *   slug: 'example',
 *   android: { package: 'com.example.app' },
 * })
 * ```
 */
export function withTulaScreens<Config extends ExpoConfigLike>(
  config: Config,
  props?: TulaScreensPluginProps
): Config {
  if (props !== undefined && !(isRecord(props) && Object.keys(props).length === 0)) {
    throw new TypeError('@tula/expo-screens/plugin: `props` must be left out: it takes no options')
  }
  return {
    ...config,
    mods: {
      ...config.mods,
      android: {
        ...config.mods?.android,
        gradleProperties: raisingMinSdk(config.mods?.android?.gradleProperties),
      },
    },
  }
}

// Expo calls what a plugin's module exports by default with `(config, props)`: an app that
// lists `'@tula/expo-screens/plugin'` under `plugins` reaches the function this way.
export default withTulaScreens
