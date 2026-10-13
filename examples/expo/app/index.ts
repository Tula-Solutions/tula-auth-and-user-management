import { registerRootComponent } from 'expo'
import { createElement, lazy, Suspense } from 'react'

// Registers the app with React Native, in Expo Go and in a build alike.
//
// The app has two ways to sign in and runs one of them: the screens it draws itself on
// `@tula/expo`'s headless client (`App.tsx`, the default), or Tula's native screens
// (`NativeApp.tsx`, with `EXPO_PUBLIC_TULA_NATIVE_SCREENS=1`). Each is on a client of its
// own that owns the session, so only the chosen one is loaded: an `import()` is evaluated
// when it is called, and the other root's client is then never made.
const Root = lazy(() =>
  process.env.EXPO_PUBLIC_TULA_NATIVE_SCREENS === '1' ? import('./NativeApp') : import('./App')
)

registerRootComponent(() => createElement(Suspense, { fallback: null }, createElement(Root)))
