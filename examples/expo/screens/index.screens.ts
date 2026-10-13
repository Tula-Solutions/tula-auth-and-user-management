import { registerRootComponent } from 'expo'
import NativeApp from './NativeApp'

// The app's other root: Tula's native screens instead of the screens the app draws.
//
// The files of this directory are not part of the example app as it is installed: they are
// copied into `app/` by hand, with `@tula-tech/expo-screens` installed beside `@tula-tech/expo`, and
// `"main"` in `app/package.json` is then pointed at this file (`../README.md`, "Tula's
// native screens"). Until then nothing of the app imports `@tula-tech/expo-screens`, so Expo
// links no native module of it and the app bundles without it. An app runs one root: each
// is on a client of its own that owns the session, and this file never loads `App.tsx`.
//
// Nothing of this file was run: see `../README.md`, "What was run, and what was not".
registerRootComponent(NativeApp)
