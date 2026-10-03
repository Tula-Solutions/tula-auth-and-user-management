import type { SigningKeyVersions } from '~/adapters/cache/signing-keys'
import { call, KEY_NAMESPACE, type RedisCommands } from '~/adapters/redis/commands'
import { ServiceUnavailableError } from '~/exceptions'

/**
 * How long a marker is kept. Losing one is harmless (instances reload their keys once), so this
 * only keeps markers of deleted environments from piling up.
 */
export const VERSION_TTL_MS = 30 * 86_400_000

/**
 * One marker per environment in Redis that changes whenever its signing keys do, so every
 * instance's key cache can tell that another instance rotated (see `cacheSigningKeys`).
 *
 * The marker is a random value rather than a counter: after Redis loses its data a counter
 * would restart and could repeat a number an instance still remembers.
 *
 * The key is `tula:sk:<environment id>`; nothing about the keys themselves is stored.
 */
export class RedisSigningKeyVersions implements SigningKeyVersions {
  /**
   * @param redis - The Redis client.
   * @param namespace - First key segment (default {@link KEY_NAMESPACE}).
   */
  constructor(
    private readonly redis: RedisCommands,
    private readonly namespace: string = KEY_NAMESPACE
  ) {}

  /** @inheritdoc */
  async current(environmentId: string): Promise<string | null> {
    const marker = await call(this.redis, 'GET', [this.#key(environmentId)])
    if (marker !== null && typeof marker !== 'string') {
      throw new ServiceUnavailableError({ internalMessage: 'redis sent an unexpected reply' })
    }
    return marker
  }

  /** @inheritdoc */
  async bump(environmentId: string): Promise<void> {
    await call(this.redis, 'SET', [
      this.#key(environmentId),
      crypto.randomUUID(),
      'PX',
      String(VERSION_TTL_MS),
    ])
  }

  #key(environmentId: string): string {
    return `${this.namespace}:sk:${environmentId}`
  }
}
