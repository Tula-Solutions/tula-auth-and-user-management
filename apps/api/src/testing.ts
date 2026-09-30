import { MemoryApiKeyRepository } from '~/adapters/memory/api-keys'
import { FixedClock } from '~/adapters/memory/clock'
import { MemoryEnvironmentRepository } from '~/adapters/memory/environments'
import { SequentialIds } from '~/adapters/memory/ids'
import { MemoryRateLimiter } from '~/adapters/memory/rate-limiter'
import { MemorySigningKeyStore } from '~/adapters/memory/signing-keys'
import type { AppConfig, Deps } from '~/dependencies'
import { sha256Hex } from '~/lib/crypto'
import { createSecretBox } from '~/lib/secret-box'
import type { ApiKeyKind, ApiKeyRecord } from '~/ports/api-key-repository'

/** `Deps` with the concrete memory adapters exposed, so tests can seed and advance them. */
export interface TestDeps extends Deps {
  clock: FixedClock
  ids: SequentialIds
  apiKeys: MemoryApiKeyRepository
  environments: MemoryEnvironmentRepository
  signingKeys: MemorySigningKeyStore
  rateLimiter: MemoryRateLimiter
}

/** Master key for test secret boxes. Never use outside tests. */
export const TEST_MASTER_KEY = 'ab'.repeat(32)

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
    environments: new MemoryEnvironmentRepository(),
    signingKeys: new MemorySigningKeyStore(),
    rateLimiter: new MemoryRateLimiter(clock),
    secretBox: createSecretBox(TEST_MASTER_KEY),
    probes: [],
    ...overrides,
    clock,
  }
}

/** The default project and environments tests act in. */
export const TEST_TENANT = {
  projectId: '00000000-0000-7000-8000-00000000a001',
  environmentId: '00000000-0000-7000-8000-00000000e001',
  productionEnvironmentId: '00000000-0000-7000-8000-00000000e002',
} as const

/**
 * Store an API key directly, bypassing the project service.
 *
 * @param deps - Test dependencies.
 * @param key - The raw key value; its kind is inferred from the `tula_pk_` / `tula_sk_` prefix.
 * @param overrides - Record fields to override (environment, id, …).
 * @returns The stored record.
 */
export function seedApiKey(
  deps: TestDeps,
  key: string,
  overrides: Partial<Omit<ApiKeyRecord, 'lastUsedAt' | 'revokedAt'>> = {}
): Promise<ApiKeyRecord> {
  const kind: ApiKeyKind = key.startsWith('tula_sk_') ? 'secret' : 'publishable'
  return deps.apiKeys.insert({
    id: deps.ids.next(),
    kind,
    name: `Test ${kind} key`,
    projectId: TEST_TENANT.projectId,
    environmentId: TEST_TENANT.environmentId,
    lastFour: key.slice(-4),
    createdAt: deps.clock.now(),
    ...overrides,
    keyHash: sha256Hex(key),
  })
}
