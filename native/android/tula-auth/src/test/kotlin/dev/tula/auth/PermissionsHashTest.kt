package dev.tula.auth

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * The shared vectors of `@tula-tech/contract`, run on the Kotlin hash. The expected values were
 * computed with `node:crypto` (the TS test does the same), not by this code.
 */
class PermissionsHashTest {
    private val expected = mapOf(
        "empty" to "1.T1PNoYwrqgwDVLtfmj7L5e0Sq02OEbqHPC8RFhICuUU",
        "one key" to "1.sonRRYVwmHSoL4KzrNsxB848gpXsR38DeIz2S4UwFN0",
        "unsorted" to "1.kdxxYipIfD1CwKEWlHHKHTjlXSfyvyL0MCO13LC5oy0",
        "duplicates" to "1.lpKYugZ8Jj_zXw0qw_1iV1uMUdrW1e7RajXdaKNNQGU",
        "code point order" to "1.pBg77BDyzcUFJtyIOJIfrfWD443falmIdFuhpFxHSOU",
        "1000 keys" to "1.EtT2o60HPgHeGHxhFnuKr60vczqfXZz0l6pVBM0pnbE",
    )

    @Test
    fun everySharedVectorHashesAsTheReferenceDoes() {
        val root = System.getProperty("tula.repository.root") ?: throw AssertionError("tula.repository.root is not set")
        val vectors = Json.parseToJsonElement(
            File(root, "packages/contract/src/permissions-hash-vectors.json").readText()
        ).jsonObject.getValue("vectors").jsonArray.map { it.jsonObject }
        assertEquals(expected.keys, vectors.map { it.getValue("name").jsonPrimitive.content }.toSet())
        for (vector in vectors) {
            val name = vector.getValue("name").jsonPrimitive.content
            val keys = vector.getValue("keys").jsonArray.map { it.jsonPrimitive.content }
            assertEquals(expected[name], permissionsHash(keys), name)
        }
    }
}
