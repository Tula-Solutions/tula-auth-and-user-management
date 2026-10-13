// The native modules this package imports, declared as far as it uses them.
//
// The repository does not install React Native or Expo (about 500 packages for two imports;
// ADR 0046), so their own declarations are not there to check against. These are the
// members `index.ts` reads, copied from `react-native` 0.86.3
// (`Libraries/Utilities/Platform.d.ts`) and from `expo` 57.0.28 (`build/Expo.d.ts`, which
// re-exports `expo-modules-core` 57.0.22: `build/requireNativeModule.d.ts`,
// `build/NativeViewManagerAdapter.d.ts`), the versions of Expo SDK 57. An application has
// the real packages, and their declarations take the place of these: a module that
// resolves is never an ambient one.
//
// These are narrower than the real declarations and were never compiled against them. A
// difference between the two shows only when an application compiles against the real
// packages, which nobody has done (`docs/plans/phase-2-unverified.md`).

declare module 'react-native' {
  /** The platform the app runs on. */
  export const Platform: {
    /** `ios`, `android`, or what another renderer of React Native calls itself (`web`, …). */
    readonly OS: string
  }
}

declare module 'expo' {
  import type { ComponentType } from 'react'
  /**
   * The native module registered under a name. Throws when the build has none of that
   * name (Expo Go, a build made before the package was installed).
   */
  export function requireNativeModule<ModuleType = unknown>(moduleName: string): ModuleType
  /**
   * A native view of a module, as a component. `expo` exports
   * `expo-modules-core`'s `requireNativeViewManager` under this name.
   */
  export function requireNativeView<P = unknown>(
    moduleName: string,
    viewName?: string
  ): ComponentType<P>
}
