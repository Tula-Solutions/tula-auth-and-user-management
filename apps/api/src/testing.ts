import { PASSWORD_POLICY_PRESETS } from '@tula/contract'
import { MemoryActivityLog } from '~/adapters/memory/activity-log'
import { MemoryApiKeyRepository } from '~/adapters/memory/api-keys'
import { MemoryBreachChecker } from '~/adapters/memory/breach-checker'
import { FixedClock } from '~/adapters/memory/clock'
import { MemoryControlPlane } from '~/adapters/memory/control-plane'
import { MemoryDiagnostics } from '~/adapters/memory/diagnostics'
import { MemoryEnvironmentLock } from '~/adapters/memory/environment-lock'
import { MemoryEnvironmentSettingsStore } from '~/adapters/memory/environment-settings'
import { MemoryEnvironmentRepository } from '~/adapters/memory/environments'
import { MemoryFactorStore } from '~/adapters/memory/factors'
import { MemoryFlowAttemptStore } from '~/adapters/memory/flow-attempts'
import { MemoryHookStore } from '~/adapters/memory/hooks'
import { SequentialIds } from '~/adapters/memory/ids'
import { MemoryJobLock } from '~/adapters/memory/job-lock'
import { MemoryLockout } from '~/adapters/memory/lockout'
import { MemoryMailer } from '~/adapters/memory/mailer'
import { MemoryNativeAppStore } from '~/adapters/memory/native-apps'
import { type FakeOAuthProviders, fakeOAuthProviders } from '~/adapters/memory/oauth'
import { MemoryOAuthProviderStore } from '~/adapters/memory/oauth-providers'
import { FakeOutbound } from '~/adapters/memory/outbound'
import { MemoryPasskeyStore } from '~/adapters/memory/passkeys'
import { MemoryRateLimiter } from '~/adapters/memory/rate-limiter'
import { MemoryRevokedSessions } from '~/adapters/memory/revoked-sessions'
import { MemorySessionStore } from '~/adapters/memory/sessions'
import { MemorySigningKeyStore } from '~/adapters/memory/signing-keys'
import { MemorySmsSender } from '~/adapters/memory/sms-sender'
import { MemorySmsUsageStore } from '~/adapters/memory/sms-usage'
import { MemoryUserRepository } from '~/adapters/memory/users'
import { MemoryVerificationTokenStore } from '~/adapters/memory/verification-tokens'
import { MemoryWebhookDeliveryStore } from '~/adapters/memory/webhook-deliveries'
import { MemoryWebhookEndpointStore } from '~/adapters/memory/webhook-endpoints'
import type { AppConfig, Deps } from '~/dependencies'
import type { Actor } from '~/lib/actor'
import { sha256Hex } from '~/lib/crypto'
import { createKeyedHash } from '~/lib/keyed-hash'
import { createSecretBox } from '~/lib/secret-box'
import * as Audit from '~/modules/audit/service'
import type { ApiKeyKind, ApiKeyRecord } from '~/ports/api-key-repository'

/** `Deps` with the concrete memory adapters exposed, so tests can seed and advance them. */
export interface TestDeps extends Deps {
  clock: FixedClock
  ids: SequentialIds
  apiKeys: MemoryApiKeyRepository
  environments: MemoryEnvironmentRepository
  environmentSettings: MemoryEnvironmentSettingsStore
  signingKeys: MemorySigningKeyStore
  verificationTokens: MemoryVerificationTokenStore
  sessions: MemorySessionStore
  users: MemoryUserRepository
  factors: MemoryFactorStore
  passkeys: MemoryPasskeyStore
  flowAttempts: MemoryFlowAttemptStore
  oauthProviders: MemoryOAuthProviderStore
  oauth: FakeOAuthProviders
  activityLog: MemoryActivityLog
  revokedSessions: MemoryRevokedSessions
  mailer: MemoryMailer
  sms: MemorySmsSender
  smsUsage: MemorySmsUsageStore
  rateLimiter: MemoryRateLimiter
  lockout: MemoryLockout
  breachChecker: MemoryBreachChecker
  jobLock: MemoryJobLock
  environmentLock: MemoryEnvironmentLock
  controlPlane: MemoryControlPlane
  webhookEndpoints: MemoryWebhookEndpointStore
  webhookDeliveries: MemoryWebhookDeliveryStore
  hooks: MemoryHookStore
  nativeApps: MemoryNativeAppStore
  outbound: FakeOutbound
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
  oauthMock: false,
  instanceAdminTokenHash: null,
  dashboardDir: null,
  apiDocs: true,
  instanceAuditRetentionDays: 365,
  deliversWebhooks: true,
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
  // One log shared by every store, as the Postgres stores share the two activity tables.
  const activityLog = overrides.activityLog ?? new MemoryActivityLog()
  const users = new MemoryUserRepository(activityLog)
  // Shared with the control plane, so an environment created through it resolves everywhere.
  const environments = overrides.environments ?? new MemoryEnvironmentRepository()
  // Shared with the delivery store, which refuses a delivery of an endpoint that is gone.
  const webhookEndpoints = overrides.webhookEndpoints ?? new MemoryWebhookEndpointStore(activityLog)
  return {
    config: TEST_CONFIG,
    ids: new SequentialIds(),
    apiKeys: new MemoryApiKeyRepository(activityLog),
    controlPlane: new MemoryControlPlane(environments),
    environmentSettings: new MemoryEnvironmentSettingsStore(activityLog),
    signingKeys: new MemorySigningKeyStore(activityLog),
    verificationTokens: new MemoryVerificationTokenStore(),
    sessions: new MemorySessionStore(activityLog),
    users,
    factors: new MemoryFactorStore(activityLog),
    passkeys: new MemoryPasskeyStore(activityLog, users),
    flowAttempts: new MemoryFlowAttemptStore(),
    oauthProviders: new MemoryOAuthProviderStore(activityLog),
    oauth: fakeOAuthProviders(),
    revokedSessions: new MemoryRevokedSessions(clock),
    mailer: new MemoryMailer(),
    sms: new MemorySmsSender(clock),
    // No inbox route unless a test asks for one (`smsInbox: deps.sms`).
    smsInbox: null,
    smsUsage: new MemorySmsUsageStore(),
    rateLimiter: new MemoryRateLimiter(clock),
    lockout: new MemoryLockout(clock),
    breachChecker: new MemoryBreachChecker(),
    secretBox: createSecretBox(TEST_MASTER_KEY),
    keyedHash: createKeyedHash(TEST_MASTER_KEY),
    jobLock: new MemoryJobLock(),
    environmentLock: new MemoryEnvironmentLock(),
    probes: [],
    diagnostics: new MemoryDiagnostics(clock),
    webhookDeliveries: new MemoryWebhookDeliveryStore(activityLog, webhookEndpoints),
    hooks: new MemoryHookStore(activityLog),
    nativeApps: new MemoryNativeAppStore(activityLog),
    // The tier of `TEST_CONFIG`, and a resolver that knows only the names a test gives it.
    outbound: new FakeOutbound((overrides.config ?? TEST_CONFIG).tier),
    // No spread: a retry is due exactly when the schedule says.
    jitter: () => 0,
    ...overrides,
    clock,
    activityLog,
    environments,
    webhookEndpoints,
  }
}

/** Who performs actions in tests unless a test cares: an admin with a valid origin. */
export const TEST_ACTOR: Actor = {
  type: 'admin',
  id: '00000000-0000-7000-8000-0000000000ad',
  ipAddress: '203.0.113.9',
  userAgent: 'tula-tests/1.0',
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
  return deps.apiKeys.insert(
    {
      id: deps.ids.next(),
      kind,
      name: `Test ${kind} key`,
      projectId: TEST_TENANT.projectId,
      environmentId: TEST_TENANT.environmentId,
      lastFour: key.slice(-4),
      createdAt: deps.clock.now(),
      ...overrides,
      keyHash: sha256Hex(key),
    },
    Audit.none('fixture')
  )
}

/** An instance admin token for tests: 32 characters that pass the boot check. */
export const TEST_ADMIN_TOKEN = 'k3Zr8vQ1nP5xW7bT2mY9cF4hJ6dL0sAg'

/**
 * Test deps of a deployment that sets `TULA_ADMIN_TOKEN` (the instance routes and the dashboard
 * session exist).
 *
 * @param overrides - Adapters or config to replace.
 * @returns The deps.
 */
export function createInstanceTestDeps(overrides: Partial<TestDeps> = {}): TestDeps {
  return createTestDeps({
    ...overrides,
    config: {
      ...TEST_CONFIG,
      ...overrides.config,
      instanceAdminTokenHash: sha256Hex(TEST_ADMIN_TOKEN),
    },
  })
}

/** What `app.request` needs: `createApp(deps)` satisfies it. */
interface Requestable {
  request(path: string, init?: RequestInit): Response | Promise<Response>
}

/**
 * The headers of a call the dashboard makes: the custom header, the API's own origin and, when
 * given, the session cookie and the environment.
 *
 * @param cookie - The `Cookie` header from {@link dashboardSignIn}.
 * @param environmentId - The environment an admin call is for.
 * @returns The headers.
 */
export function dashboardHeaders(cookie?: string, environmentId?: string): Record<string, string> {
  return {
    'x-tula-dashboard': '1',
    origin: new URL(TEST_CONFIG.publicUrl).origin,
    'content-type': 'application/json',
    ...(cookie ? { cookie } : {}),
    ...(environmentId ? { 'x-tula-environment': environmentId } : {}),
  }
}

/**
 * Sign in to the dashboard with {@link TEST_ADMIN_TOKEN}.
 *
 * @param app - An app built on {@link createInstanceTestDeps}.
 * @returns The `Cookie` header to send on later calls.
 * @throws Error when the sign-in does not answer 200 with a cookie.
 */
export async function dashboardSignIn(app: Requestable): Promise<string> {
  const res = await app.request('/v1/instance/session', {
    method: 'POST',
    headers: dashboardHeaders(),
    body: JSON.stringify({ token: TEST_ADMIN_TOKEN }),
  })
  const [first] = res.headers.getSetCookie()
  if (res.status !== 200 || !first) {
    throw new Error(`dashboard sign-in failed with ${res.status}`)
  }
  return first.split(';')[0] ?? ''
}
