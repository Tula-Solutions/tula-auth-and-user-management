import { MemoryApiKeyRepository } from '~/adapters/memory/api-keys'
import { FixedClock } from '~/adapters/memory/clock'
import { SequentialIds } from '~/adapters/memory/ids'
import { MemoryRateLimiter } from '~/adapters/memory/rate-limiter'
import { MemorySigningKeyStore } from '~/adapters/memory/signing-keys'
import type { AppConfig, Deps } from '~/dependencies'

/** `Deps` with the concrete memory adapters exposed, so tests can seed and advance them. */
export interface TestDeps extends Deps {
  clock: FixedClock
  ids: SequentialIds
  apiKeys: MemoryApiKeyRepository
  signingKeys: MemorySigningKeyStore
  rateLimiter: MemoryRateLimiter
}

/** Config used by tests unless overridden. */
export const TEST_CONFIG: AppConfig = {
  tier: 'local',
  publicUrl: 'http://localhost:3003',
  corsOrigins: [],
  trustProxy: false,
}

/**
 * Build dependencies from memory adapters and a fixed clock: no network, database or env.
 *
 * @param overrides - Replace any dependency, e.g. `{ probes: [failingProbe] }`.
 * @returns The test dependencies.
 *
 * @example
 * ```ts
 * const deps = createTestDeps()
 * deps.clock.advance('10m')
 * ```
 */
export function createTestDeps(overrides: Partial<TestDeps> = {}): TestDeps {
  const clock = overrides.clock ?? new FixedClock()
  return {
    config: TEST_CONFIG,
    ids: new SequentialIds(),
    apiKeys: new MemoryApiKeyRepository(),
    signingKeys: new MemorySigningKeyStore(),
    rateLimiter: new MemoryRateLimiter(clock),
    probes: [],
    ...overrides,
    clock,
  }
}
