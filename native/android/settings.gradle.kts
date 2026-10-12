// The Kotlin SDK's build (ADR 0051). Two modules:
//   tula-auth          the client with no UI: plain Kotlin on the JVM, no Android SDK needed.
//   tula-auth-android  what only an Android device has: the Keystore-backed token storage.
// The second is part of the build only where an Android SDK is installed (ANDROID_HOME,
// ANDROID_SDK_ROOT, or `sdk.dir` in local.properties), so that the client's own tests run on
// any machine with a JDK.
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

val androidSdk: String? =
    providers.environmentVariable("ANDROID_HOME").orNull
        ?: providers.environmentVariable("ANDROID_SDK_ROOT").orNull
        ?: file("local.properties").takeIf { it.isFile }?.readLines()
            ?.firstOrNull { it.startsWith("sdk.dir=") }
if (androidSdk != null) {
    include(":tula-auth-android")
}
