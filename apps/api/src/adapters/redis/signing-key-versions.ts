import type { SigningKeyVersions } from '~/adapters/cache/signing-keys'
import { KEY_NAMESPACE, type RedisCommands } from '~/adapters/redis/commands'
import { RedisVersions } from '~/adapters/redis/versions'

export { VERSION_TTL_MS } from '~/adapters/redis/versions'

/**
 * One marker per environment in Redis that changes whenever its signing keys do, so every
 * instance's key cache can tell that another instance rotated (see `cacheSigningKeys`).
 *
 * The key is `tula:sk:<environment id>`; nothing about the keys themselves is stored.
 */
export class RedisSigningKeyVersions extends RedisVersions implements SigningKeyVersions {
  /**
   * @param redis - The Redis client.
   * @param namespace - First key segment (default {@link KEY_NAMESPACE}).
   */
  constructor(redis: RedisCommands, namespace: string = KEY_NAMESPACE) {
    super(redis, 'sk', namespace)
  }
}
