import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    // Kotlin comes with the Android plugin (its built-in Kotlin support), at the version the
    // root build pins; the Compose compiler plugin is Kotlin's own, at that same version.
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.compose)
}

group = "dev.tula"
version = "0.0.0"

android {
    namespace = "dev.tula.auth.compose"
    compileSdk {
        version = release(36) {
            minorApiLevel = 1
        }
    }
    // Pinned like every other version of this build.
    buildToolsVersion = "36.1.0"

    defaultConfig {
        // Android 9, as the client's Android module (ADR 0054).
        minSdk = 28
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }

    lint {
        // A lint warning is a failed build, as a compiler warning is.
        warningsAsErrors = true
        abortOnError = true
        // "A newer version is available" is Dependabot's to say, on its own schedule: as a lint
        // error it would fail a build that changed nothing.
        disable += setOf("GradleDependency", "NewerVersionAvailable", "AndroidGradlePluginVersion")
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_11
        allWarningsAsErrors = true
    }
}

dependencies {
    // The client and the model are what an app that uses the screens writes against.
    api(project(":tula-auth"))
    api(project(":tula-auth-ui"))
    // Foundation and UI only. No Material: an app is not tied to a version of it, and every
    // colour, size and shape is the theme's.
    implementation(libs.compose.ui)
    implementation(libs.compose.foundation)
    implementation(libs.coroutines.android)
}
