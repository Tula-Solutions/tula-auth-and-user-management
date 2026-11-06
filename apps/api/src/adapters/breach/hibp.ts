import * as logger from '~/lib/logger'
import type { BreachChecker, BreachStatus } from '~/ports/breach-checker'

/** How long a lookup may take before it counts as `unknown`; sign-up waits on it. */
export const HIBP_TIMEOUT_MS = 2_000

/**
 * Largest `Content-Length` we accept from the range API. Real responses are ~30 KB even with
 * padding; anything much bigger means a misconfigured proxy or base URL, so the result counts as
 * `unknown`. A body without the header is
 * counted as it streams and abandoned at the same cap ({@link readCapped}).
 */
export const HIBP_MAX_RESPONSE_BYTES = 1024 * 1024

/**
 * Read a response body as text, stopping at {@link HIBP_MAX_RESPONSE_BYTES}.
 *
 * `Content-Length` is absent on a chunked body, so the bytes are counted as they arrive.
 *
 * @param res - The response to read.
 * @returns The text, or `undefined` when the body is longer than the cap (the stream is cancelled).
 */
async function readCapped(res: Response): Promise<string | undefined> {
  if (!res.body) {
    return ''
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let received = 0
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      return text + decoder.decode()
    }
    received += value.byteLength
    if (received > HIBP_MAX_RESPONSE_BYTES) {
      await reader.cancel()
      return undefined
    }
    text += decoder.decode(value, { stream: true })
  }
}

/** Options for {@link HibpBreachChecker}. */
export interface HibpOptions {
  /** Injected for tests; defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch
  /** Defaults to {@link HIBP_TIMEOUT_MS}. */
  timeoutMs?: number
  /** Defaults to the public Pwned Passwords API. */
  baseUrl?: string
}

/**
 * Breach checker backed by Have I Been Pwned's Pwned Passwords range API.
 *
 * Uses k-anonymity: only the first 5 hex characters of the password's SHA-1 leave the server,
 * and `Add-Padding` hides how many suffixes share that prefix. SHA-1 is what the API indexes; it
 * is used here as a lookup key, never to store anything.
 */
export class HibpBreachChecker implements BreachChecker {
  readonly #fetch: typeof globalThis.fetch
  readonly #timeoutMs: number
  readonly #baseUrl: string

  /** @param options - Fetch, timeout and base URL overrides. */
  constructor(options: HibpOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#timeoutMs = options.timeoutMs ?? HIBP_TIMEOUT_MS
    this.#baseUrl = options.baseUrl ?? 'https://api.pwnedpasswords.com'
  }

  /** @inheritdoc */
  async check(password: string): Promise<BreachStatus> {
    const digest = new Bun.CryptoHasher('sha1').update(password).digest('hex').toUpperCase()
    const prefix = digest.slice(0, 5)
    const suffix = digest.slice(5)
    try {
      const res = await this.#fetch(`${this.#baseUrl}/range/${prefix}`, {
        headers: { 'Add-Padding': 'true', 'User-Agent': 'tula-auth' },
        signal: AbortSignal.timeout(this.#timeoutMs),
      })
      const declared = Number(res.headers.get('content-length') ?? 0)
      if (!res.ok || declared > HIBP_MAX_RESPONSE_BYTES) {
        logger.warn('breach check unavailable', { status: res.status, bytes: declared })
        return 'unknown'
      }
      const text = await readCapped(res)
      if (text === undefined) {
        logger.warn('breach check unavailable', { status: res.status, bytes: 'over cap' })
        return 'unknown'
      }
      for (const line of text.split('\n')) {
        const [candidate, count] = line.trim().split(':')
        // Padding entries carry a count of 0 and are not real breaches.
        if (candidate?.toUpperCase() === suffix && Number(count) > 0) {
          return 'breached'
        }
      }
      return 'clean'
    } catch (err) {
      logger.warn('breach check unavailable', {
        // Not the message: a fetch error can quote the URL, which holds the hash prefix.
        err: err instanceof Error ? err.name : 'unknown',
      })
      return 'unknown'
    }
  }
}
