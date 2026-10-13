import org.gradle.api.tasks.testing.logging.TestExceptionFormat
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
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
    // Both are in the client's public types: the generated types, `suspend` and `StateFlow`.
    api(libs.serialization.json)
    api(libs.coroutines.core)

    testImplementation(libs.kotlin.test.junit)
}

tasks.test {
    useJUnit()
    // The journeys run against the real API (ADR 0054): `bun run native:kotlin:test` starts
    // it and hands its address over. Without it they fail; they are never skipped.
    systemProperty(
        "tula.fixture.url",
        providers.environmentVariable("TULA_FIXTURE_URL").orElse("").get(),
    )
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
        filters {
            excludes {
                // Written by `bun run native:generate` and held by its own tests (ADR 0050).
                packages("dev.tula.auth.generated")
            }
        }
        verify {
            rule {
                // Lines of the hand-written client. The repository asks 80% of every
                // package and aims at 95% for security-sensitive ones; this module holds
                // the session's tokens, and was at 98% when the bound was set.
                minBound(90)
            }
        }
    }
}

tasks.check {
    dependsOn("koverVerify")
}
