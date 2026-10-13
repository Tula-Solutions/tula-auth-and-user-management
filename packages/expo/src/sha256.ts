import { utf8Bytes } from './bytes'

// SHA-256 (FIPS 180-4), written out. Its one use is the nonce of a native Sign in with
// Apple (ADR 0047): Apple's sheet is handed the hash of the server's nonce, and a React
// Native engine has no `crypto.subtle` to take it with. The nonce is not a secret, so
// nothing here needs to run in constant time.

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]

function rotate(value: number, by: number): number {
  return (value >>> by) | (value << (32 - by))
}

/**
 * The SHA-256 of a text's UTF-8 bytes, as lowercase hexadecimal: the one spelling the
 * server accepts in an Apple identity token's `nonce` (the contract's `appleNonceClaim`).
 *
 * @param text - The text.
 * @returns 64 lowercase hexadecimal digits.
 */
export function sha256Hex(text: string): string {
  const message = utf8Bytes(text)
  const bitLength = message.length * 8
  message.push(0x80)
  while (message.length % 64 !== 56) {
    message.push(0)
  }
  // The length in bits, as 64 bits big-endian. A text here is far below 2^32 bits.
  message.push(0, 0, 0, 0)
  for (const shift of [24, 16, 8, 0]) {
    message.push((bitLength >>> shift) & 0xff)
  }
  const hash = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]
  const w = new Array<number>(64).fill(0)
  for (let block = 0; block < message.length; block += 64) {
    for (let t = 0; t < 16; t += 1) {
      const at = block + t * 4
      w[t] =
        (((message[at] as number) << 24) |
          ((message[at + 1] as number) << 16) |
          ((message[at + 2] as number) << 8) |
          (message[at + 3] as number)) >>>
        0
    }
    for (let t = 16; t < 64; t += 1) {
      const w15 = w[t - 15] as number
      const w2 = w[t - 2] as number
      const s0 = rotate(w15, 7) ^ rotate(w15, 18) ^ (w15 >>> 3)
      const s1 = rotate(w2, 17) ^ rotate(w2, 19) ^ (w2 >>> 10)
      w[t] = ((w[t - 16] as number) + s0 + (w[t - 7] as number) + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, h] = hash as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ]
    for (let t = 0; t < 64; t += 1) {
      const s1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)
      const choice = (e & f) ^ (~e & g)
      const t1 = (h + s1 + choice + (K[t] as number) + (w[t] as number)) >>> 0
      const s0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (s0 + majority) >>> 0
      h = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    for (const [at, value] of [a, b, c, d, e, f, g, h].entries()) {
      hash[at] = ((hash[at] as number) + value) >>> 0
    }
  }
  return hash.map((word) => word.toString(16).padStart(8, '0')).join('')
}
