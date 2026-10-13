---
'create-tula': patch
---

The Expo scaffold's README (`create-tula --framework expo`) says in one paragraph that the
app draws its own screens on `@tula-tech/expo`'s headless client, and that Tula's native screens
are a separate package, `@tula-tech/expo-screens`, which the scaffold does not install and whose
iOS module has not been compiled. The scaffolded app itself is unchanged.
