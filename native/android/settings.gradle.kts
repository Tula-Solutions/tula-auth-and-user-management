// The Kotlin SDK's build (ADR 0054, ADR 0058). Its modules:
//   tula-auth          the client with no UI: plain Kotlin on the JVM, no Android SDK needed.
//   tula-auth-ui       what is behind the screens: the model, the strings and the theme's
//                      grammar. Plain Kotlin on the JVM, no Compose.
//   tula-auth-android  what only an Android device has: the Keystore-backed token storage.
//   tula-auth-compose  the Compose screens, which draw `tula-auth-ui`'s model.
//   compose-example    the example app (examples/compose), and the UI tests that run it.
// The last three are part of the build only where an Android SDK is installed (ANDROID_HOME,
// ANDROID_SDK_ROOT, or `sdk.dir` in local.properties), so that the client's own tests run on
// any machine with a JDK. A variable that is set and empty names no SDK: CI's `kotlin` job
// empties both, so that its JVM tests do not depend on the runner's Android SDK.
pluginManagement {
    repositories {
        gradlePluginPortal()
        google()
        mavenCentral()
    }
}

dependencyResolutionManagement {
    repositoriesMode = RepositoriesMode.FAIL_ON_PROJECT_REPOS
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "tula-android"

include(":tula-auth")
include(":tula-auth-ui")

val androidSdk: String? =
    providers.environmentVariable("ANDROID_HOME").orNull?.takeIf { it.isNotBlank() }
        ?: providers.environmentVariable("ANDROID_SDK_ROOT").orNull?.takeIf { it.isNotBlank() }
        ?: file("local.properties").takeIf { it.isFile }?.readLines()
            ?.firstOrNull { it.startsWith("sdk.dir=") }
if (androidSdk != null) {
    include(":tula-auth-android")
}
