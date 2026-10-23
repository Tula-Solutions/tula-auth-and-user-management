package dev.tula.auth

import kotlin.test.Test
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * The library's jar carries rules for R8 (TULA-130). Without them an app that keeps the whole
 * `dev.tula.auth` package fails its minified build on `java.net.http`, which Android lacks and
 * which the JVM-only `JdkHttpEngine` refers to. The build of the Compose example as a
 * minified release is the proof that they work; this holds that they are in the jar.
 */
class ConsumerRulesTest {
    @Test
    fun `the jar ships the consumer rules R8 reads from META-INF proguard`() {
        val rules = UrlConnectionEngine::class.java.classLoader.getResource("META-INF/proguard/tula-auth.pro")
        assertNotNull(rules, "META-INF/proguard/tula-auth.pro is missing from the library")
        val lines = rules.readText().lines().map { it.trim() }.filter { !it.startsWith("#") && it.isNotEmpty() }
        assertTrue("-dontwarn java.net.http.**" in lines, lines.toString())
    }
}
