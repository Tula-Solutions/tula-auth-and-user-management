package dev.tula.auth.ui

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

// A QR code encoder of the package's own: byte mode, error correction level M, versions 1 to
// 40 (ISO/IEC 18004). It is a port of `packages/react/src/qr/encode.ts`, which a scanner reads
// back in that package's tests; the two are held to each other by one corpus,
// `packages/react/src/qr/qr-cases.json`, read by both suites. Android has no encoder of its
// own, and a library for 300 lines would be the package's first dependency (ADR 0062).
//
// What is encoded here is an `otpauth://` address, which holds an authenticator's setup key:
// nothing in this file logs, keeps or repeats its input.

/**
 * A QR symbol: [size] modules a side, dark or light. It prints as its type's name, because
 * what it encodes may be a secret.
 */
class TulaQrMatrix internal constructor(
    /** How many modules a side has: 21 for version 1, 177 for version 40. */
    val size: Int,
    private val dark: BooleanArray,
) {
    /**
     * Whether a module is dark.
     *
     * @param x The column, from 0 at the left.
     * @param y The row, from 0 at the top.
     * @return `true` for a dark module; `false` for a light one and for one outside the symbol.
     */
    fun isDark(x: Int, y: Int): Boolean = x in 0 until size && y in 0 until size && dark[y * size + x]

    /** The type's name: a symbol is not printed. */
    override fun toString(): String = "TulaQrMatrix"
}

/** The encoder. */
object TulaQr {
    /** The most bytes of UTF-8 a symbol holds (version 40, level M). */
    const val MAX_BYTES: Int = 2331

    private const val MAX_VERSION = 40

    private val ECC_CODEWORDS_PER_BLOCK = intArrayOf(
        0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28,
        28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
    )

    private val BLOCK_COUNT = intArrayOf(
        0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25,
        26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
    )

    private val MASKS: List<(Int, Int) -> Boolean> = listOf(
        { x, y -> (x + y) % 2 == 0 },
        { _, y -> y % 2 == 0 },
        { x, _ -> x % 3 == 0 },
        { x, y -> (x + y) % 3 == 0 },
        { x, y -> (x / 3 + y / 2) % 2 == 0 },
        { x, y -> (x * y) % 2 + (x * y) % 3 == 0 },
        { x, y -> ((x * y) % 2 + (x * y) % 3) % 2 == 0 },
        { x, y -> ((x + y) % 2 + (x * y) % 3) % 2 == 0 },
    )

    private class Grid(val size: Int) {
        var dark = IntArray(size * size)
        val reserved = BooleanArray(size * size)

        fun function(x: Int, y: Int, isDark: Boolean) {
            dark[y * size + x] = if (isDark) 1 else 0
            reserved[y * size + x] = true
        }
    }

    /**
     * Encode a text.
     *
     * @param text What a scanner should read: counted in bytes of UTF-8.
     * @return The symbol, in the smallest version that holds the text.
     * @throws IllegalArgumentException for a text of more than [MAX_BYTES] bytes. The message
     *   never repeats the text.
     */
    fun encode(text: String): TulaQrMatrix {
        val bytes = text.toByteArray(Charsets.UTF_8)
        val version = pickVersion(bytes.size)
        val size = 17 + 4 * version
        val grid = Grid(size)
        drawFunctionPatterns(grid, version)
        placeCodewords(grid, withErrorCorrection(dataCodewords(bytes, version), version))
        var best = grid.dark
        var lowest = Int.MAX_VALUE
        for ((index, mask) in MASKS.withIndex()) {
            applyMask(grid, mask)
            drawFormat(grid, index)
            val score = penalty(grid)
            if (score < lowest) {
                lowest = score
                best = grid.dark.copyOf()
            }
            // The same mask again takes it off: the next one starts from the bare symbol.
            applyMask(grid, mask)
        }
        return TulaQrMatrix(size, BooleanArray(size * size) { best[it] == 1 })
    }

    private fun rawDataModules(version: Int): Int {
        var count = (16 * version + 128) * version + 64
        if (version >= 2) {
            val alignments = version / 7 + 2
            count -= (25 * alignments - 10) * alignments - 55
        }
        if (version >= 7) {
            count -= 36
        }
        return count
    }

    private fun totalCodewords(version: Int): Int = rawDataModules(version) / 8

    private fun dataCodewordCount(version: Int): Int =
        totalCodewords(version) - ECC_CODEWORDS_PER_BLOCK[version] * BLOCK_COUNT[version]

    private fun countBits(version: Int): Int = if (version < 10) 8 else 16

    private fun byteCapacity(version: Int): Int = (dataCodewordCount(version) * 8 - 4 - countBits(version)) / 8

    private fun pickVersion(byteLength: Int): Int {
        for (version in 1..MAX_VERSION) {
            if (byteCapacity(version) >= byteLength) {
                return version
            }
        }
        throw IllegalArgumentException("Text is too long for a QR code: $byteLength bytes, at most $MAX_BYTES.")
    }

    private fun appendBits(bits: ArrayList<Int>, value: Int, length: Int) {
        for (i in length - 1 downTo 0) {
            bits.add((value ushr i) and 1)
        }
    }

    private fun dataCodewords(bytes: ByteArray, version: Int): IntArray {
        val capacityBits = dataCodewordCount(version) * 8
        val bits = ArrayList<Int>(capacityBits)
        appendBits(bits, 0b0100, 4)
        appendBits(bits, bytes.size, countBits(version))
        for (byte in bytes) {
            appendBits(bits, byte.toInt() and 0xff, 8)
        }
        appendBits(bits, 0, min(4, capacityBits - bits.size))
        appendBits(bits, 0, (8 - bits.size % 8) % 8)
        var pad = 0xec
        while (bits.size < capacityBits) {
            appendBits(bits, pad, 8)
            pad = pad xor 0xec xor 0x11
        }
        val codewords = IntArray(bits.size / 8)
        for ((i, bit) in bits.withIndex()) {
            codewords[i ushr 3] = codewords[i ushr 3] or (bit shl (7 - (i and 7)))
        }
        return codewords
    }

    /** Multiplication in GF(2^8) over the polynomial 0x11d. */
    private fun gfMultiply(x: Int, y: Int): Int {
        var product = 0
        for (i in 7 downTo 0) {
            product = (product shl 1) xor ((product ushr 7) * 0x11d)
            product = product xor (((y ushr i) and 1) * x)
        }
        return product
    }

    private fun rsDivisor(degree: Int): IntArray {
        val divisor = IntArray(degree)
        divisor[degree - 1] = 1
        var root = 1
        repeat(degree) {
            for (j in 0 until degree) {
                divisor[j] = gfMultiply(divisor[j], root) xor (if (j + 1 < degree) divisor[j + 1] else 0)
            }
            root = gfMultiply(root, 2)
        }
        return divisor
    }

    private fun rsRemainder(data: IntArray, divisor: IntArray): IntArray {
        val remainder = IntArray(divisor.size)
        for (byte in data) {
            val factor = byte xor remainder[0]
            System.arraycopy(remainder, 1, remainder, 0, remainder.size - 1)
            remainder[remainder.size - 1] = 0
            for ((i, coefficient) in divisor.withIndex()) {
                remainder[i] = remainder[i] xor gfMultiply(coefficient, factor)
            }
        }
        return remainder
    }

    private fun withErrorCorrection(data: IntArray, version: Int): IntArray {
        val blockCount = BLOCK_COUNT[version]
        val eccLength = ECC_CODEWORDS_PER_BLOCK[version]
        val total = totalCodewords(version)
        val shortBlocks = blockCount - total % blockCount
        val shortLength = total / blockCount - eccLength
        val divisor = rsDivisor(eccLength)
        val dataBlocks = ArrayList<IntArray>()
        val eccBlocks = ArrayList<IntArray>()
        var offset = 0
        for (block in 0 until blockCount) {
            val length = shortLength + (if (block < shortBlocks) 0 else 1)
            val blockData = data.copyOfRange(offset, offset + length)
            offset += length
            dataBlocks.add(blockData)
            eccBlocks.add(rsRemainder(blockData, divisor))
        }
        val interleaved = ArrayList<Int>(total)
        for (i in 0..shortLength) {
            for (block in dataBlocks) {
                if (i < block.size) {
                    interleaved.add(block[i])
                }
            }
        }
        for (i in 0 until eccLength) {
            for (block in eccBlocks) {
                interleaved.add(block[i])
            }
        }
        return interleaved.toIntArray()
    }

    private fun drawFinder(grid: Grid, centreX: Int, centreY: Int) {
        for (dy in -4..4) {
            for (dx in -4..4) {
                val x = centreX + dx
                val y = centreY + dy
                if (x in 0 until grid.size && y in 0 until grid.size) {
                    val ring = max(abs(dx), abs(dy))
                    grid.function(x, y, ring != 2 && ring != 4)
                }
            }
        }
    }

    private fun drawAlignment(grid: Grid, centreX: Int, centreY: Int) {
        for (dy in -2..2) {
            for (dx in -2..2) {
                grid.function(centreX + dx, centreY + dy, max(abs(dx), abs(dy)) != 1)
            }
        }
    }

    private fun alignmentCentres(version: Int, size: Int): List<Int> {
        if (version == 1) {
            return emptyList()
        }
        val count = version / 7 + 2
        val step = if (version == 32) 26 else ((version * 4 + 4 + (count * 2 - 2) - 1) / (count * 2 - 2)) * 2
        val centres = ArrayList<Int>()
        centres.add(6)
        var position = size - 7
        while (centres.size < count) {
            centres.add(1, position)
            position -= step
        }
        return centres
    }

    private fun drawVersion(grid: Grid, version: Int) {
        if (version < 7) {
            return
        }
        var remainder = version
        repeat(12) {
            remainder = (remainder shl 1) xor ((remainder ushr 11) * 0x1f25)
        }
        val bits = (version shl 12) or remainder
        for (i in 0 until 18) {
            val isDark = (bits ushr i) and 1 == 1
            val a = grid.size - 11 + i % 3
            val b = i / 3
            grid.function(a, b, isDark)
            grid.function(b, a, isDark)
        }
    }

    private fun drawFormat(grid: Grid, mask: Int) {
        val size = grid.size
        var remainder = mask
        repeat(10) {
            remainder = (remainder shl 1) xor ((remainder ushr 9) * 0x537)
        }
        val bits = ((mask shl 10) or remainder) xor 0x5412
        for (i in 0 until 15) {
            val isDark = (bits ushr i) and 1 == 1
            when {
                i < 6 -> grid.function(8, i, isDark)
                i < 8 -> grid.function(8, i + 1, isDark)
                i == 8 -> grid.function(7, 8, isDark)
                else -> grid.function(14 - i, 8, isDark)
            }
            if (i < 8) {
                grid.function(size - 1 - i, 8, isDark)
            } else {
                grid.function(8, size - 15 + i, isDark)
            }
        }
        grid.function(8, size - 8, true)
    }

    private fun drawFunctionPatterns(grid: Grid, version: Int) {
        val size = grid.size
        for (i in 0 until size) {
            grid.function(6, i, i % 2 == 0)
            grid.function(i, 6, i % 2 == 0)
        }
        drawFinder(grid, 3, 3)
        drawFinder(grid, size - 4, 3)
        drawFinder(grid, 3, size - 4)
        val centres = alignmentCentres(version, size)
        val last = centres.size - 1
        for ((i, centreX) in centres.withIndex()) {
            for ((j, centreY) in centres.withIndex()) {
                val onFinder = (i == 0 && j == 0) || (i == 0 && j == last) || (i == last && j == 0)
                if (!onFinder) {
                    drawAlignment(grid, centreX, centreY)
                }
            }
        }
        drawFormat(grid, 0)
        drawVersion(grid, version)
    }

    private fun placeCodewords(grid: Grid, codewords: IntArray) {
        val size = grid.size
        val total = codewords.size * 8
        var bit = 0
        var right = size - 1
        while (right >= 1) {
            if (right == 6) {
                right = 5
            }
            val upward = (right + 1) and 2 == 0
            for (step in 0 until size) {
                val y = if (upward) size - 1 - step else step
                for (x in right downTo right - 1) {
                    val index = y * size + x
                    if (!grid.reserved[index] && bit < total) {
                        grid.dark[index] = (codewords[bit ushr 3] ushr (7 - (bit and 7))) and 1
                        bit += 1
                    }
                }
            }
            right -= 2
        }
    }

    private fun applyMask(grid: Grid, mask: (Int, Int) -> Boolean) {
        val size = grid.size
        for (y in 0 until size) {
            for (x in 0 until size) {
                val index = y * size + x
                if (!grid.reserved[index] && mask(x, y)) {
                    grid.dark[index] = grid.dark[index] xor 1
                }
            }
        }
    }

    private fun linePenalty(dark: IntArray, start: Int, stride: Int, size: Int): Int {
        var penalty = 0
        var run = 0
        var colour = -1
        var recent = 0
        for (i in 0 until size) {
            val cell = dark[start + i * stride]
            run = if (cell == colour) run + 1 else 1
            colour = cell
            if (run == 5) {
                penalty += 3
            } else if (run > 5) {
                penalty += 1
            }
            recent = ((recent shl 1) and 0x7ff) or cell
            if (i >= 10 && (recent == 0x5d0 || recent == 0x05d)) {
                penalty += 40
            }
        }
        return penalty
    }

    private fun penalty(grid: Grid): Int {
        val size = grid.size
        val dark = grid.dark
        var total = 0
        var darkCount = 0
        for (i in 0 until size) {
            total += linePenalty(dark, i * size, 1, size) + linePenalty(dark, i, size, size)
        }
        for (y in 0 until size) {
            for (x in 0 until size) {
                val index = y * size + x
                val cell = dark[index]
                darkCount += cell
                if (x + 1 < size && y + 1 < size && cell == dark[index + 1] && cell == dark[index + size] &&
                    cell == dark[index + size + 1]
                ) {
                    total += 3
                }
            }
        }
        val modules = size * size
        return total + abs(darkCount * 20 - modules * 10) / modules * 10
    }
}
