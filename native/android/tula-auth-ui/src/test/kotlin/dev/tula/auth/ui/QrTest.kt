package dev.tula.auth.ui

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File
import java.security.MessageDigest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/** The QR encoder: held to the TypeScript one by a shared corpus, and to the standard's structure. */
class QrTest {
    private fun cells(matrix: TulaQrMatrix): String = buildString {
        for (y in 0 until matrix.size) {
            for (x in 0 until matrix.size) {
                append(if (matrix.isDark(x, y)) '1' else '0')
            }
        }
    }

    private fun sha256(text: String): String =
        MessageDigest.getInstance("SHA-256").digest(text.toByteArray()).joinToString("") { "%02x".format(it) }

    @Test
    fun `every text of the shared corpus gives the symbol the TypeScript encoder gives`() {
        val root = assertNotNull(System.getProperty("tula.repository.root"), "the build names the repository's root")
        val cases = Json.parseToJsonElement(File(root, "packages/react/src/qr/qr-cases.json").readText()).jsonArray
        assertTrue(cases.size >= 12, "the corpus is whole")
        for (case in cases) {
            val text = case.jsonObject.getValue("text").jsonPrimitive.content
            val matrix = TulaQr.encode(text)
            assertEquals(case.jsonObject.getValue("size").jsonPrimitive.int, matrix.size, "size of ${text.length} characters")
            assertEquals(
                case.jsonObject.getValue("sha256").jsonPrimitive.content,
                sha256(cells(matrix)),
                "modules of ${text.length} characters",
            )
        }
    }

    @Test
    fun `a symbol has its three finders, its timing lines and the dark module`() {
        for (text in listOf("", "otpauth://totp/Acme:maya?secret=JBSWY3DPEHPK3PXP&issuer=Acme", "x".repeat(900))) {
            val matrix = TulaQr.encode(text)
            val size = matrix.size
            assertEquals(1, size % 4)
            for ((left, top) in listOf(0 to 0, size - 7 to 0, 0 to size - 7)) {
                for (dy in 0 until 7) {
                    for (dx in 0 until 7) {
                        val ring = maxOf(kotlin.math.abs(dx - 3), kotlin.math.abs(dy - 3))
                        assertEquals(ring != 2, matrix.isDark(left + dx, top + dy), "finder at $left,$top: $dx,$dy")
                    }
                }
            }
            for (i in 8 until size - 8) {
                assertEquals(i % 2 == 0, matrix.isDark(i, 6))
                assertEquals(i % 2 == 0, matrix.isDark(6, i))
            }
            assertTrue(matrix.isDark(8, size - 8))
        }
    }

    @Test
    fun `outside the symbol nothing is dark`() {
        val matrix = TulaQr.encode("a")
        assertFalse(matrix.isDark(-1, 0))
        assertFalse(matrix.isDark(0, -1))
        assertFalse(matrix.isDark(matrix.size, 0))
        assertFalse(matrix.isDark(0, matrix.size))
    }

    @Test
    fun `length is counted in bytes of UTF-8, and one byte more than a version holds moves to the next`() {
        assertEquals(21, TulaQr.encode("x".repeat(14)).size)
        assertEquals(25, TulaQr.encode("x".repeat(15)).size)
        // Seven two-byte letters fit version 1; eight do not.
        assertEquals(21, TulaQr.encode("é".repeat(7)).size)
        assertEquals(25, TulaQr.encode("é".repeat(8)).size)
        assertEquals(177, TulaQr.encode("x".repeat(TulaQr.MAX_BYTES)).size)
    }

    @Test
    fun `a text that does not fit is refused, and the refusal does not repeat the text, which may be a secret`() {
        val secret = "JBSWY3DPEHPK3PXP".repeat(200)
        val error = assertFailsWith<IllegalArgumentException> { TulaQr.encode(secret) }
        assertFalse(error.message.orEmpty().contains("JBSWY3DPEHPK3PXP"))
        assertTrue(error.message.orEmpty().contains(TulaQr.MAX_BYTES.toString()))
    }

    @Test
    fun `the same text always gives the same symbol, a different text another, and a symbol prints as its name`() {
        val text = "otpauth://totp/Acme:maya?secret=JBSWY3DPEHPK3PXP&issuer=Acme"
        assertEquals(cells(TulaQr.encode(text)), cells(TulaQr.encode(text)))
        assertNotEquals(cells(TulaQr.encode(text)), cells(TulaQr.encode(text + "x")))
        assertEquals("TulaQrMatrix", TulaQr.encode(text).toString())
        assertEquals("TulaQrMatrix", "${TulaQr.encode(text)}")
    }
}
