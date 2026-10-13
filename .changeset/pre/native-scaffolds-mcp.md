---
'@tula-tech/mcp': minor
---

The scaffold tools return three more frameworks, `expo`, `swiftui` and `compose`, from the
same templates `create-tula` writes. A SwiftUI or a Compose answer names its SDK by a path
into a checkout of the Tula repository and says so in its notes, with the note that nobody
has run such a project on a phone; no registry, Maven coordinate or Swift package address
is named. `detect_framework` answers `expo` for a `package.json` that depends on `expo`
and `react-native`, and never `swiftui` or `compose`: it reads one `package.json`, and an
Xcode project and a Gradle build have none.
