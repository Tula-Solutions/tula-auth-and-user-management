import {
  CLOCK_SKEW_ALLOWANCE_MS,
  call,
  KEY_NAMESPACE,
  type RedisCommands,
} from '~/adapters/redis/commands'
import { ServiceUnavailableError } from '~/exceptions'
import type { Clock } from '~/ports/clock'
import type { ProofReplayGuard } from '~/ports/proof-replay'

/**
 * The ids of accepted proofs in Redis, shared by every API instance: a proof accepted by one
 * instance is a replay on all of them.
 *
 * - **One command.** `SET key 1 NX PX <lifetime>` writes only when the key is absent and says
 *   which it was, so two instances given one proof at once cannot both accept it.
 * - **No personal data in Redis.** The key is `tula:dp:<id>`, where the id is a SHA-256 the
 *   service made of the environment, the key's thumbprint and the proof's own id.
 * - **Fails closed.** When Redis cannot answer, or answers with anything but the two replies
 *   the command has, `remember` throws `service.unavailable`: a proof is never accepted on a
 *   guess (ADR 0016).
 * - Entries expire on their own a little after the proof could last be accepted
 *   ({@link CLOCK_SKEW_ALLOWANCE_MS}).
 */
export class RedisProofReplayGuard implements ProofReplayGuard {
  /**
   * @param redis - The Redis client.
   * @param clock - Time source for how long an entry is kept.
   * @param namespace - First key segment (default {@link KEY_NAMESPACE}).
   */
  constructor(
    private readonly redis: RedisCommands,
    private readonly clock: Clock,
    private readonly namespace: string = KEY_NAMESPACE
  ) {}

  /** @inheritdoc */
  async remember(id: string, until: Date): Promise<boolean> {
    const remaining = Math.max(0, until.getTime() - this.clock.now().getTime())
    const reply = await call(this.redis, 'SET', [
      `${this.namespace}:dp:${id}`,
      '1',
      'NX',
      'PX',
      String(remaining + CLOCK_SKEW_ALLOWANCE_MS),
    ])
    if (reply === 'OK') {
      return true
    }
    if (reply === null) {
      return false
    }
    throw new ServiceUnavailableError({ internalMessage: 'redis sent an unexpected reply' })
  }
}
