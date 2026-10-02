import { PASSWORD_POLICY_PRESETS } from '@tula/contract'
import { MemoryApiKeyRepository } from '~/adapters/memory/api-keys'
import { MemoryBreachChecker } from '~/adapters/memory/breach-checker'
import { FixedClock } from '~/adapters/memory/clock'
import { MemoryEnvironmentRepository } from '~/adapters/memory/environments'
import { MemoryFlowAttemptStore } from '~/adapters/memory/flow-attempts'
import { SequentialIds } from '~/adapters/memory/ids'
import { MemoryLockout } from '~/adapters/memory/lockout'
import { MemoryMailer } from '~/adapters/memory/mailer'
import { MemoryRateLimiter } from '~/adapters/memory/rate-limiter'
import { MemoryRevokedSessions } from '~/adapters/memory/revoked-sessions'
import { MemorySessionStore } from '~/adapters/memory/sessions'
import { MemorySigningKeyStore } from '~/adapters/memory/signing-keys'
import { MemoryUserRepository } from '~/adapters/memory/users'
import { MemoryVerificationTokenStore } from '~/adapters/memory/verification-tokens'
import type { AppConfig, Deps } from '~/dependencies'
import { sha256Hex } from '~/lib/crypto'
import { createKeyedHash } from '~/lib/keyed-hash'
import { createSecretBox } from '~/lib/secret-box'
import type { ApiKeyKind, ApiKeyRecord } from '~/ports/api-key-repository'

/** `Deps` with the concrete memory adapters exposed, so tests can seed and advance them. */
export interface TestDeps extends Deps {
  clock: FixedClock
  ids: SequentialIds
  apiKeys: MemoryApiKeyRepository
  environments: MemoryEnvironmentRepository
  signingKeys: MemorySigningKeyStore
  verificationTokens: MemoryVerificationTokenStore
  sessions: MemorySessionStore
  users: MemoryUserRepository
  flowAttempts: MemoryFlowAttemptStore
  revokedSessions: MemoryRevokedSessions
  mailer: MemoryMailer
  rateLimiter: MemoryRateLimiter
  lockout: MemoryLockout
  breachChecker: MemoryBreachChecker
}

/** Master key for test secret boxes. Never use outside tests. */
export const TEST_MASTER_KEY = 'ab'.repeat(32)

/** Config used by tests unless overridden. */
export const TEST_CONFIG: AppConfig = {
  tier: 'local',
  publicUrl: 'http://localhost:3003',
  corsOrigins: [],
  trustProxy: false,
  passwordPolicy: PASSWORD_POLICY_PRESETS.recommended,
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
    verificationTokens: new MemoryVerificationTokenStore(),
    sessions: new MemorySessionStore(),
    users: new MemoryUserRepository(),
    flowAttempts: new MemoryFlowAttemptStore(),
    revokedSessions: new MemoryRevokedSessions(clock),
    mailer: new MemoryMailer(),
    rateLimiter: new MemoryRateLimiter(clock),
    lockout: new MemoryLockout(clock),
    breachChecker: new MemoryBreachChecker(),
    secretBox: createSecretBox(TEST_MASTER_KEY),
    keyedHash: createKeyedHash(TEST_MASTER_KEY),
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
