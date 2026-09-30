import * as logger from '~/lib/logger'
import type { BreachChecker, BreachStatus } from '~/ports/breach-checker'

/** How long a lookup may take before it counts as `unknown`; sign-up waits on it. */
export const HIBP_TIMEOUT_MS = 2_000

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
      if (!res.ok) {
        logger.warn('breach check unavailable', { status: res.status })
        return 'unknown'
      }
      for (const line of (await res.text()).split('\n')) {
        const [candidate, count] = line.trim().split(':')
        // Padding entries carry a count of 0 and are not real breaches.
        if (candidate?.toUpperCase() === suffix && Number(count) > 0) {
          return 'breached'
        }
      }
      return 'clean'
    } catch (err) {
      logger.warn('breach check unavailable', {
        err: err instanceof Error ? err.message : String(err),
      })
      return 'unknown'
    }
  }
}
