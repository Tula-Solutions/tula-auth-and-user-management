import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    // Kotlin comes with the Android plugin (its built-in Kotlin support), at the version the
    // root build pins.
    alias(libs.plugins.android.library)
}

group = "dev.tula"
version = "0.0.0"

android {
    namespace = "dev.tula.auth.android"
    compileSdk {
        version = release(36) {
            minorApiLevel = 1
        }
    }
    // Pinned like every other version of this build; the Android plugin would otherwise use
    // its own default.
    buildToolsVersion = "36.1.0"

    defaultConfig {
        // Android 9. ADR 0054 has what the floor rests on.
        minSdk = 28
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_11
        allWarningsAsErrors = true
    }
}

dependencies {
    api(project(":tula-auth"))
    // Credential Manager: the passkey sheet and Google's account sheet.
    implementation(libs.credentials)
    // What Credential Manager needs to reach a passkey on Android 13 and lower (minSdk is 28).
    implementation(libs.credentials.play.services)
    // Google's ID token option and credential for Credential Manager.
    implementation(libs.googleid)
}
