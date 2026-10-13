---
'create-tula': patch
'@tula/mcp': patch
---

The Expo scaffold (`create-tula --framework expo`, and the MCP scaffold tool) follows the
Expo example, which now has a second root: `app/NativeApp.tsx` and `app/src/native-tula.ts`
show Tula's native screens (`@tula/expo/native-screens`) instead of the screens the app
draws, when it is built with `EXPO_PUBLIC_TULA_NATIVE_SCREENS=1`. By default the app loads
its own root as before. The scaffold's README says what that root is, that an app is on one
of the two and never both, and that nothing of the scaffolded app was installed, bundled or
built since the second root was added.
