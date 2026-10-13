---
'create-tula': minor
---

Three native templates beside the two web ones: `--framework expo`, `swiftui` and
`compose`, copies of the repository's Expo, SwiftUI and Compose examples. A native app is
a directory of its own in the project (`app`, `ios`, `android`), next to the Compose file,
the `.env` and `tula.config.ts`, and holds no key.

The Swift package and the Kotlin libraries are published nowhere yet, so a SwiftUI or a
Compose project names its SDK by a relative path into a checkout of the Tula repository:
`--tula-repo <dir>` is required for those two and refused for the others, and a path with
a character an Xcode project or a Gradle file cannot take as it is is refused before
anything is written. The Compose project ships no Gradle wrapper and is built with the
checkout's.

Nobody has run a scaffolded native project in a simulator, on an emulator or on a phone:
the SwiftUI and the Compose one were compiled, the Expo one was written and not installed.
