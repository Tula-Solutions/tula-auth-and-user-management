/**
 * A QR code encoder (ISO/IEC 18004): byte mode, error correction level M, versions 1 to 40.
 *
 * It exists so that showing an authenticator's enrolment code adds no runtime dependency to an
 * application's bundle. Pure arithmetic: no DOM and no Node or Bun API, so it runs in a browser
 * and during server rendering alike.
 */

/**
 * A QR code symbol as a square grid of modules, without the quiet zone.
 *
 * A renderer must leave four light modules around it (the quiet zone) for scanners to find it.
 *
 * @example
 * const { size, modules } = encodeQr('otpauth://totp/Acme:maya?secret=JBSWY3DPEHPK3PXP')
 * const topLeftIsDark = modules[0]?.[0] // true: a corner of a finder pattern
 */
export type QrMatrix = {
  /** Modules per side: `17 + 4 × version`. */
  readonly size: number
  /** Rows from top to bottom, each from left to right; `true` is a dark module. */
  readonly modules: readonly (readonly boolean[])[]
}

/**
 * The longest text {@link encodeQr} accepts, in UTF-8 bytes (version 40 at level M).
 *
 * @example
 * const fits = new TextEncoder().encode(uri).length <= QR_MAX_BYTES
 */
export const QR_MAX_BYTES = 2331

const MAX_VERSION = 40

/** Error correction codewords in each block at level M, by version (index 0 is unused). */
const ECC_CODEWORDS_PER_BLOCK: readonly number[] = [
  0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28,
  28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
]

/** Error correction blocks at level M, by version (index 0 is unused). */
const BLOCK_COUNT: readonly number[] = [
  0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25,
  26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
]

/** The eight data masks of the standard: a module is inverted where its mask holds. */
const MASKS: readonly ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
]

/** The symbol while it is built: one cell per module, row by row. */
type Grid = {
  size: number
  /** 1 where the module is dark. */
  dark: Uint8Array
  /** 1 where the module belongs to a function pattern, which data and masks leave alone. */
  reserved: Uint8Array
}

/** An in-range read: every index here is computed from the same sizes the lists were built with. */
function at(list: ArrayLike<number>, index: number): number {
  return list[index] ?? 0
}

/** Modules left for codewords once every function pattern has taken its place. */
function rawDataModules(version: number): number {
  let count = (16 * version + 128) * version + 64
  if (version >= 2) {
    const alignments = Math.floor(version / 7) + 2
    count -= (25 * alignments - 10) * alignments - 55
  }
  if (version >= 7) {
    count -= 36
  }
  return count
}

function totalCodewords(version: number): number {
  return Math.floor(rawDataModules(version) / 8)
}

function dataCodewordCount(version: number): number {
  return totalCodewords(version) - at(ECC_CODEWORDS_PER_BLOCK, version) * at(BLOCK_COUNT, version)
}

/** Width of the byte-mode character count: it grows from one byte to two at version 10. */
function countBits(version: number): number {
  return version < 10 ? 8 : 16
}

function byteCapacity(version: number): number {
  return Math.floor((dataCodewordCount(version) * 8 - 4 - countBits(version)) / 8)
}

function pickVersion(byteLength: number): number {
  for (let version = 1; version <= MAX_VERSION; version++) {
    if (byteCapacity(version) >= byteLength) {
      return version
    }
  }
  // The text is not put in the message: what goes in a QR code is often a secret.
  throw new RangeError(
    `Text is too long for a QR code: ${byteLength} bytes, at most ${QR_MAX_BYTES}.`
  )
}

function appendBits(bits: number[], value: number, length: number): void {
  for (let i = length - 1; i >= 0; i--) {
    bits.push((value >>> i) & 1)
  }
}

/** Mode, count, the bytes, terminator and padding: exactly the version's data codewords. */
function dataCodewords(bytes: Uint8Array, version: number): number[] {
  const capacityBits = dataCodewordCount(version) * 8
  const bits: number[] = []
  appendBits(bits, 0b0100, 4)
  appendBits(bits, bytes.length, countBits(version))
  for (const byte of bytes) {
    appendBits(bits, byte, 8)
  }
  appendBits(bits, 0, Math.min(4, capacityBits - bits.length))
  appendBits(bits, 0, (8 - (bits.length % 8)) % 8)
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) {
    appendBits(bits, pad, 8)
  }
  const codewords: number[] = new Array(bits.length / 8).fill(0)
  for (const [i, bit] of bits.entries()) {
    codewords[i >>> 3] = at(codewords, i >>> 3) | (bit << (7 - (i & 7)))
  }
  return codewords
}

/** Multiply in GF(2^8) modulo x^8 + x^4 + x^3 + x^2 + 1 (0x11D). */
function gfMultiply(x: number, y: number): number {
  let product = 0
  for (let i = 7; i >= 0; i--) {
    product = (product << 1) ^ ((product >>> 7) * 0x11d)
    product ^= ((y >>> i) & 1) * x
  }
  return product
}

/** The Reed–Solomon generator polynomial of a degree, without its leading 1. */
function rsDivisor(degree: number): number[] {
  const divisor: number[] = new Array(degree).fill(0)
  divisor[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      divisor[j] = gfMultiply(at(divisor, j), root) ^ at(divisor, j + 1)
    }
    root = gfMultiply(root, 2)
  }
  return divisor
}

function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const remainder: number[] = new Array(divisor.length).fill(0)
  for (const byte of data) {
    const factor = byte ^ at(remainder, 0)
    remainder.shift()
    remainder.push(0)
    for (const [i, coefficient] of divisor.entries()) {
      remainder[i] = at(remainder, i) ^ gfMultiply(coefficient, factor)
    }
  }
  return remainder
}

/** Split into the version's blocks, add each block's error correction, and interleave. */
function withErrorCorrection(data: readonly number[], version: number): number[] {
  const blockCount = at(BLOCK_COUNT, version)
  const eccLength = at(ECC_CODEWORDS_PER_BLOCK, version)
  const total = totalCodewords(version)
  // The first blocks are one data codeword shorter when the total does not divide evenly.
  const shortBlocks = blockCount - (total % blockCount)
  const shortLength = Math.floor(total / blockCount) - eccLength
  const divisor = rsDivisor(eccLength)
  const dataBlocks: number[][] = []
  const eccBlocks: number[][] = []
  let offset = 0
  for (let block = 0; block < blockCount; block++) {
    const length = shortLength + (block < shortBlocks ? 0 : 1)
    const blockData = data.slice(offset, offset + length)
    offset += length
    dataBlocks.push(blockData)
    eccBlocks.push(rsRemainder(blockData, divisor))
  }
  const interleaved: number[] = []
  for (let i = 0; i <= shortLength; i++) {
    for (const block of dataBlocks) {
      if (i < block.length) {
        interleaved.push(at(block, i))
      }
    }
  }
  for (let i = 0; i < eccLength; i++) {
    for (const block of eccBlocks) {
      interleaved.push(at(block, i))
    }
  }
  return interleaved
}

function setFunction(grid: Grid, x: number, y: number, dark: boolean): void {
  const index = y * grid.size + x
  grid.dark[index] = dark ? 1 : 0
  grid.reserved[index] = 1
}

/** A finder pattern with its light separator; the part outside the symbol is skipped. */
function drawFinder(grid: Grid, centreX: number, centreY: number): void {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const x = centreX + dx
      const y = centreY + dy
      if (x >= 0 && x < grid.size && y >= 0 && y < grid.size) {
        const ring = Math.max(Math.abs(dx), Math.abs(dy))
        setFunction(grid, x, y, ring !== 2 && ring !== 4)
      }
    }
  }
}

function drawAlignment(grid: Grid, centreX: number, centreY: number): void {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      setFunction(grid, centreX + dx, centreY + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
    }
  }
}

/** Where alignment patterns are centred, on both axes. Version 1 has none. */
function alignmentCentres(version: number, size: number): number[] {
  if (version === 1) {
    return []
  }
  const count = Math.floor(version / 7) + 2
  // Version 32 is the one whose spacing the standard's table does not round the usual way.
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2
  const centres = [6]
  for (let position = size - 7; centres.length < count; position -= step) {
    centres.splice(1, 0, position)
  }
  return centres
}

/** Version information (versions 7 and up): 6 version bits and 12 BCH bits, written twice. */
function drawVersion(grid: Grid, version: number): void {
  if (version < 7) {
    return
  }
  let remainder = version
  for (let i = 0; i < 12; i++) {
    remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25)
  }
  const bits = (version << 12) | remainder
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) === 1
    const a = grid.size - 11 + (i % 3)
    const b = Math.floor(i / 3)
    setFunction(grid, a, b, dark)
    setFunction(grid, b, a, dark)
  }
}

/**
 * Format information: level M (bits 00) and the mask, with 10 BCH bits, written twice.
 *
 * Also sets the module that is always dark, beside the bottom-left finder.
 */
function drawFormat(grid: Grid, mask: number): void {
  const { size } = grid
  let remainder = mask
  for (let i = 0; i < 10; i++) {
    remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537)
  }
  const bits = ((mask << 10) | remainder) ^ 0x5412
  for (let i = 0; i < 15; i++) {
    const dark = ((bits >>> i) & 1) === 1
    // Around the top-left finder, stepping over the timing row and column.
    if (i < 6) {
      setFunction(grid, 8, i, dark)
    } else if (i < 8) {
      setFunction(grid, 8, i + 1, dark)
    } else if (i === 8) {
      setFunction(grid, 7, 8, dark)
    } else {
      setFunction(grid, 14 - i, 8, dark)
    }
    // Split between the top-right and the bottom-left finders.
    if (i < 8) {
      setFunction(grid, size - 1 - i, 8, dark)
    } else {
      setFunction(grid, 8, size - 15 + i, dark)
    }
  }
  setFunction(grid, 8, size - 8, true)
}

function drawFunctionPatterns(grid: Grid, version: number): void {
  const { size } = grid
  for (let i = 0; i < size; i++) {
    setFunction(grid, 6, i, i % 2 === 0)
    setFunction(grid, i, 6, i % 2 === 0)
  }
  drawFinder(grid, 3, 3)
  drawFinder(grid, size - 4, 3)
  drawFinder(grid, 3, size - 4)
  const centres = alignmentCentres(version, size)
  const last = centres.length - 1
  for (const [i, centreX] of centres.entries()) {
    for (const [j, centreY] of centres.entries()) {
      const onFinder = (i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)
      if (!onFinder) {
        drawAlignment(grid, centreX, centreY)
      }
    }
  }
  // Reserves the format areas; the real bits are written once per mask.
  drawFormat(grid, 0)
  drawVersion(grid, version)
}

/**
 * Lay the codewords out in the two-module-wide zigzag from the bottom-right corner.
 *
 * Modules left over after the last codeword (the remainder bits) stay light.
 */
function placeCodewords(grid: Grid, codewords: readonly number[]): void {
  const { size } = grid
  const total = codewords.length * 8
  let bit = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) {
      // The vertical timing pattern's column takes no data; the pairs shift left past it.
      right = 5
    }
    const upward = ((right + 1) & 2) === 0
    for (let step = 0; step < size; step++) {
      const y = upward ? size - 1 - step : step
      for (let x = right; x > right - 2; x--) {
        const index = y * size + x
        if (at(grid.reserved, index) === 0 && bit < total) {
          grid.dark[index] = (at(codewords, bit >>> 3) >>> (7 - (bit & 7))) & 1
          bit++
        }
      }
    }
  }
}

/** Invert the data modules a mask selects. Applying the same mask again undoes it. */
function applyMask(grid: Grid, mask: (x: number, y: number) => boolean): void {
  const { size } = grid
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const index = y * size + x
      if (at(grid.reserved, index) === 0 && mask(x, y)) {
        grid.dark[index] = at(grid.dark, index) ^ 1
      }
    }
  }
}

/**
 * Penalty of one row or column: runs of five or more modules of one colour (rule 1) and the
 * finder-like 1:1:3:1:1 pattern with four light modules on either side (rule 3).
 */
function linePenalty(dark: Uint8Array, start: number, stride: number, size: number): number {
  let penalty = 0
  let run = 0
  let colour = -1
  let recent = 0
  for (let i = 0; i < size; i++) {
    const cell = at(dark, start + i * stride)
    run = cell === colour ? run + 1 : 1
    colour = cell
    if (run === 5) {
      penalty += 3
    } else if (run > 5) {
      penalty += 1
    }
    // The last eleven modules as bits: 10111010000 or 00001011101.
    recent = ((recent << 1) & 0x7ff) | cell
    if (i >= 10 && (recent === 0x5d0 || recent === 0x05d)) {
      penalty += 40
    }
  }
  return penalty
}

/** The standard's four penalty rules; the mask with the lowest total is the one to use. */
function penalty(grid: Grid): number {
  const { size, dark } = grid
  let total = 0
  let darkCount = 0
  for (let i = 0; i < size; i++) {
    total += linePenalty(dark, i * size, 1, size) + linePenalty(dark, i, size, size)
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const index = y * size + x
      const cell = at(dark, index)
      darkCount += cell
      // Rule 2: every 2×2 block of one colour.
      if (
        x + 1 < size &&
        y + 1 < size &&
        cell === at(dark, index + 1) &&
        cell === at(dark, index + size) &&
        cell === at(dark, index + size + 1)
      ) {
        total += 3
      }
    }
  }
  // Rule 4: ten points for every 5% the share of dark modules is away from half.
  const modules = size * size
  return total + Math.floor(Math.abs(darkCount * 20 - modules * 10) / modules) * 10
}

/**
 * Encode a text as a QR code: byte mode (the text's UTF-8 bytes), error correction level M,
 * in the smallest version (1 to 40) that holds it.
 *
 * The result has no quiet zone: draw it with four light modules around it. The same text
 * always gives the same symbol.
 *
 * @param text - The text to encode, for example an `otpauth://` URI.
 * @returns The symbol's modules, `true` where dark.
 * @throws RangeError when the text is longer than {@link QR_MAX_BYTES} UTF-8 bytes. The message
 *   gives the length and never the text.
 * @example
 * const matrix = encodeQr('otpauth://totp/Acme:maya%40example.com?secret=JBSWY3DPEHPK3PXP')
 * matrix.size // 37: version 5
 */
export function encodeQr(text: string): QrMatrix {
  const bytes = new TextEncoder().encode(text)
  const version = pickVersion(bytes.length)
  const size = 17 + 4 * version
  const grid: Grid = {
    size,
    dark: new Uint8Array(size * size),
    reserved: new Uint8Array(size * size),
  }
  drawFunctionPatterns(grid, version)
  placeCodewords(grid, withErrorCorrection(dataCodewords(bytes, version), version))

  let best = grid.dark
  let lowest = Number.POSITIVE_INFINITY
  for (const [index, mask] of MASKS.entries()) {
    applyMask(grid, mask)
    drawFormat(grid, index)
    const score = penalty(grid)
    if (score < lowest) {
      lowest = score
      best = grid.dark.slice()
    }
    applyMask(grid, mask)
  }

  const modules = Array.from({ length: size }, (_row, y) =>
    Array.from({ length: size }, (_cell, x) => at(best, y * size + x) === 1)
  )
  return { size, modules }
}
