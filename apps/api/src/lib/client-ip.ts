import type { Context } from 'hono'

interface BunServerLike {
  requestIP?: (request: Request) => { address: string } | null
}

/**
 * The client's IP address, for rate limiting.
 *
 * With `trustProxy`, uses the **last** `X-Forwarded-For` entry: the one our proxy appended.
 * Earlier entries come from the client and can be forged to dodge limits. Without it, uses the
 * socket peer from Bun's server (passed as Hono's `c.env`).
 *
 * @param c - The request context.
 * @param trustProxy - Whether a trusted proxy sets `X-Forwarded-For`.
 * @returns The IP, or `'unknown'` when it cannot be determined (e.g. `app.request` in tests).
 */
export function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = c.req.header('x-forwarded-for')
    const last = forwarded?.split(',').at(-1)?.trim()
    if (last) {
      return last
    }
  }
  const server = c.env as BunServerLike | undefined
  return server?.requestIP?.(c.req.raw)?.address ?? 'unknown'
}

/** An IPv6 address as eight lowercase hextets without leading zeros, or `null` if it is not one. */
function hextets(address: string): string[] | null {
  // A trailing dotted IPv4 (`::ffff:203.0.113.7`) stands for the last two hextets.
  const dotted = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address)
  let text = address
  if (dotted) {
    const [, head, a, b, c, d] = dotted as unknown as [
      string,
      string,
      string,
      string,
      string,
      string,
    ]
    const bytes = [a, b, c, d].map(Number)
    if (bytes.some((byte) => byte > 255)) {
      return null
    }
    const [b0, b1, b2, b3] = bytes as [number, number, number, number]
    text = `${head}${((b0 << 8) | b1).toString(16)}:${((b2 << 8) | b3).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) {
    return null
  }
  const [left = '', right] = halves
  const head = left === '' ? [] : left.split(':')
  const tail = right === undefined || right === '' ? [] : right.split(':')
  const missing = 8 - head.length - tail.length
  // Without `::` all eight groups must be present; with it, it stands for at least one.
  if (right === undefined ? missing !== 0 : missing < 1) {
    return null
  }
  const groups = [...head, ...Array<string>(right === undefined ? 0 : missing).fill('0'), ...tail]
  return groups.every((group) => /^[0-9a-f]{1,4}$/i.test(group))
    ? groups.map((group) => Number.parseInt(group, 16).toString(16))
    : null
}

/**
 * The rate-limit bucket an address belongs to.
 *
 * Limits keyed on the raw address are trivial to dodge over IPv6: one subscriber normally holds
 * a whole /64, which is 2^64 addresses. So an IPv6 address is counted by its /64, and an IPv4
 * address written as IPv6 (`::ffff:203.0.113.7`) is counted as that IPv4 address. The audit log
 * still records the full address; only limits use the bucket.
 *
 * @param address - A client address from {@link clientIp}.
 * @returns The IPv4 address, `<prefix>::/64` for IPv6, or the input unchanged when it is neither
 *   (e.g. `unknown`).
 *
 * @example
 * ```ts
 * ipBucket('2001:db8:1:2::9') // '2001:db8:1:2::/64'
 * ```
 */
export function ipBucket(address: string): string {
  if (!address.includes(':')) {
    return address
  }
  // A zone id (`fe80::1%eth0`) names an interface, not a different client.
  const groups = hextets(address.split('%')[0] ?? '')
  if (!groups) {
    return address
  }
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ]
  if ([g0, g1, g2, g3, g4].every((group) => group === '0') && g5 === 'ffff') {
    const high = Number.parseInt(g6, 16)
    const low = Number.parseInt(g7, 16)
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`
  }
  return `${g0}:${g1}:${g2}:${g3}::/64`
}
