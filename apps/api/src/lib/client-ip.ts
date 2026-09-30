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
