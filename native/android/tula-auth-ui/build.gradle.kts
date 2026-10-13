import org.gradle.api.tasks.testing.logging.TestExceptionFormat
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

// What is behind the Compose screens and has no Compose in it (ADR 0058): the model, what a
// screen offers as data, the table of strings and the theme's grammar. Plain Kotlin on the JVM,
// so that everything that decides is tested, and counted, where no screen is drawn.
plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kover)
}

group = "dev.tula"
version = "0.0.0"

kotlin {
    compilerOptions {
        // Bytecode an Android build (API 28 and later) takes as it is.
        jvmTarget = JvmTarget.JVM_11
        allWarningsAsErrors = true
    }
}

java {
    sourceCompatibility = JavaVersion.VERSION_11
    targetCompatibility = JavaVersion.VERSION_11
}

dependencies {
    // The client is in the model's public types (`TulaClient`, `TulaError`, the generated theme).
    api(project(":tula-auth"))

    testImplementation(libs.kotlin.test.junit)
}

tasks.test {
    useJUnit()
    // The theme grammar is held to the contract's corpus, which lives beside the contract.
    systemProperty("tula.repository.root", rootDir.resolve("../..").canonicalPath)
    testLogging {
        events("failed", "skipped")
        showStackTraces = true
        exceptionFormat = TestExceptionFormat.FULL
    }
    // A test that did not run is not a test that passed.
    outputs.upToDateWhen { false }
}

kover {
    reports {
        verify {
            rule {
                // Lines of everything that decides what a screen shows. The same bound as the
                // client's; the composables that draw are in `tula-auth-compose`, which no JVM
                // test runs and which is therefore not counted anywhere (ADR 0058).
                minBound(90)
            }
        }
    }
}

tasks.check {
    dependsOn("koverVerify")
}
