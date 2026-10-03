import type { Versions } from '~/adapters/cache/versioned'
import { call, KEY_NAMESPACE, type RedisCommands } from '~/adapters/redis/commands'
import { ServiceUnavailableError } from '~/exceptions'

/**
 * How long a marker is kept. Losing one is harmless (instances reload once), so this only keeps
 * markers of deleted environments from piling up.
 */
export const VERSION_TTL_MS = 30 * 86_400_000

/**
 * Change markers in Redis: one small key per id that is replaced whenever the thing cached
 * under that id changes, so every instance's cache can tell that another instance wrote (see
 * `createVersionedCache`).
 *
 * The marker is a random value rather than a counter: after Redis loses its data a counter
 * would restart and could repeat a number an instance still remembers.
 *
 * The key is `tula:<segment>:<id>`; nothing about the cached value itself is stored.
 */
export class RedisVersions implements Versions {
  readonly #redis: RedisCommands
  readonly #prefix: string

  /**
   * @param redis - The Redis client.
   * @param segment - Second key segment, naming what the markers are for (`sk`, `es`).
   * @param namespace - First key segment (default {@link KEY_NAMESPACE}).
   */
  constructor(redis: RedisCommands, segment: string, namespace: string = KEY_NAMESPACE) {
    this.#redis = redis
    this.#prefix = `${namespace}:${segment}:`
  }

  /** @inheritdoc */
  async current(id: string): Promise<string | null> {
    const marker = await call(this.#redis, 'GET', [`${this.#prefix}${id}`])
    if (marker !== null && typeof marker !== 'string') {
      throw new ServiceUnavailableError({ internalMessage: 'redis sent an unexpected reply' })
    }
    return marker
  }

  /** @inheritdoc */
  async bump(id: string): Promise<void> {
    await call(this.#redis, 'SET', [
      `${this.#prefix}${id}`,
      crypto.randomUUID(),
      'PX',
      String(VERSION_TTL_MS),
    ])
  }
}
