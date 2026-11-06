import org.jetbrains.kotlin.gradle.dsl.JvmTarget

// The Compose example: a module of a Gradle build whose settings name the Kotlin SDK's
// modules and its version catalog, so that it has that build's pinned versions and names none
// of its own. In the Tula repository that build is native/android (its settings.gradle.kts
// names this directory, and the example is not a workspace package: there is no package.json
// here); in a project made by create-tula it is the settings.gradle.kts one directory up.
plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "dev.tula.example.compose"
    compileSdk {
        version = release(36) {
            minorApiLevel = 1
        }
    }
    buildToolsVersion = "36.1.0"

    defaultConfig {
        applicationId = "dev.tula.example.compose"
        minSdk = 28
        targetSdk = 36
        versionCode = 1
        versionName = "0.0.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        release {
            // R8 runs on the release build, so that CI shows the libraries survive it: the
            // client's jar ships its own consumer rules (`META-INF/proguard/tula-auth.pro`).
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }

    lint {
        warningsAsErrors = true
        abortOnError = true
        // "A newer version is available" is Dependabot's to say, on its own schedule; and the
        // app targets the API level the build compiles against, which is pinned (36), so "a
        // newer Android exists" is the same note.
        disable += setOf("GradleDependency", "NewerVersionAvailable", "AndroidGradlePluginVersion", "OldTargetApi")
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_11
        allWarningsAsErrors = true
    }
}

dependencies {
    implementation(project(":tula-auth-compose"))
    // The refresh token, sealed by a key of the Android Keystore.
    implementation(project(":tula-auth-android"))
    implementation(libs.activity.compose)
    implementation(libs.compose.ui)
    implementation(libs.compose.foundation)

    androidTestImplementation(libs.compose.ui.test.junit4)
    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.androidx.test.runner)
    // Not used by name: it replaces the older Espresso the Compose test library brings (the
    // catalog says why).
    androidTestImplementation(libs.androidx.test.espresso.core)
}
