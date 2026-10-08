import type { Tier } from '~/env'
import type { OutboundDeps } from '~/lib/outbound'

/**
 * The outbound guard's settings for tests: a tier, and a resolver that answers only what a
 * test told it to, so no test ever asks a real name server.
 *
 * A name nobody set does not resolve. A test that wants a name to pass the guard gives it an
 * address ({@link FakeOutbound.point}); one that wants it to stop passing gives it another.
 */
export class FakeOutbound implements OutboundDeps {
  tier: Tier
  /** Every name the guard asked for, in order. */
  readonly asked: string[]
  readonly #names: Map<string, readonly string[]>
  readonly resolve: (hostname: string) => Promise<readonly string[]>

  /** @param tier - The deployment tier the guard judges by. Tests run as `local`. */
  constructor(tier: Tier = 'local') {
    this.tier = tier
    this.asked = []
    this.#names = new Map()
    // An arrow, bound here: the guard calls it without the object.
    this.resolve = async (hostname) => {
      this.asked.push(hostname)
      const addresses = this.#names.get(hostname)
      if (!addresses) {
        throw new Error('this name was not given an address')
      }
      return addresses
    }
  }

  /**
   * Make a name resolve to these addresses from now on.
   *
   * @param hostname - The name.
   * @param addresses - What it resolves to; none means it stops resolving.
   */
  point(hostname: string, ...addresses: string[]): void {
    if (addresses.length === 0) {
      this.#names.delete(hostname)
      return
    }
    this.#names.set(hostname, addresses)
  }
}
