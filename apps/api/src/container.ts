import { PASSWORD_POLICY_PRESETS } from '@tula/contract'
import { createDatabase } from '@tula/db'
import { HibpBreachChecker } from '~/adapters/breach/hibp'
import { offlineBreachChecker } from '~/adapters/breach/offline'
import { cacheEnvironmentSettings } from '~/adapters/cache/environment-settings'
import { cacheSigningKeys } from '~/adapters/cache/signing-keys'
import { SmtpMailer } from '~/adapters/mail/smtp'
import { MemoryLockout } from '~/adapters/memory/lockout'
import { MemoryProofReplayGuard } from '~/adapters/memory/proof-replay'
import { MemoryRateLimiter } from '~/adapters/memory/rate-limiter'
import { MemoryRevokedSessions } from '~/adapters/memory/revoked-sessions'
import { createAppleProvider } from '~/adapters/oauth/apple'
import { createDiscordProvider } from '~/adapters/oauth/discord'
import { createFacebookProvider } from '~/adapters/oauth/facebook'
import { createGitHubProvider } from '~/adapters/oauth/github'
import { createGoogleProvider } from '~/adapters/oauth/google'
import { createLinkedInProvider } from '~/adapters/oauth/linkedin'
import { createMicrosoftProvider } from '~/adapters/oauth/microsoft'
import { mockOAuthProviders } from '~/adapters/oauth/mock'
import { createXProvider } from '~/adapters/oauth/x'
import { PostgresActivityLog } from '~/adapters/postgres/activity'
import { PostgresApiKeyRepository } from '~/adapters/postgres/api-keys'
import { PostgresControlPlane } from '~/adapters/postgres/control-plane'
import { PostgresEnvironmentLock } from '~/adapters/postgres/environment-lock'
import { PostgresEnvironmentSettingsStore } from '~/adapters/postgres/environment-settings'
import { PostgresEnvironmentRepository } from '~/adapters/postgres/environments'
import { PostgresFactorStore } from '~/adapters/postgres/factors'
import { PostgresFlowAttemptStore } from '~/adapters/postgres/flow-attempts'
import { databaseProbe } from '~/adapters/postgres/health'
import { PostgresHookStore } from '~/adapters/postgres/hooks'
import { PostgresJobLock } from '~/adapters/postgres/job-lock'
import { PostgresNativeAppStore } from '~/adapters/postgres/native-apps'
import { PostgresOAuthProviderStore } from '~/adapters/postgres/oauth-providers'
import { PostgresPasskeyStore } from '~/adapters/postgres/passkeys'
import { PostgresSessionStore } from '~/adapters/postgres/sessions'
import { PostgresSigningKeyStore } from '~/adapters/postgres/signing-keys'
import { PostgresSmsUsageStore } from '~/adapters/postgres/sms-usage'
import { PostgresUserRepository } from '~/adapters/postgres/users'
import { PostgresVerificationTokenStore } from '~/adapters/postgres/verification-tokens'
import { PostgresWebhookDeliveryStore } from '~/adapters/postgres/webhook-deliveries'
import { PostgresWebhookEndpointStore } from '~/adapters/postgres/webhook-endpoints'
import { connectRedis, redisProbe } from '~/adapters/redis/connection'
import { RedisLockout } from '~/adapters/redis/lockout'
import { RedisProofReplayGuard } from '~/adapters/redis/proof-replay'
import { RedisRateLimiter } from '~/adapters/redis/rate-limiter'
import { RedisRevokedSessions } from '~/adapters/redis/revoked-sessions'
import { RedisSigningKeyVersions } from '~/adapters/redis/signing-key-versions'
import { RedisVersions } from '~/adapters/redis/versions'
import { DevSmsSender } from '~/adapters/sms/dev'
import { createTwilioSmsSender } from '~/adapters/sms/twilio'
import { unconfiguredSmsSender } from '~/adapters/sms/unconfigured'
import { systemClock } from '~/adapters/system/clock'
import { createDiagnostics } from '~/adapters/system/diagnostics'
import { uuidV7Ids } from '~/adapters/system/ids'
import type { Deps } from '~/dependencies'
import type { Env } from '~/env'
import { sha256Hex } from '~/lib/crypto'
import { findDashboardDir } from '~/lib/dashboard-files'
import { createKeyedHash } from '~/lib/keyed-hash'
import * as logger from '~/lib/logger'
import { createSecretBox } from '~/lib/secret-box'
import * as DeviceBinding from '~/modules/session/device-binding'
import type { SmsSender } from '~/ports/sms-sender'
import { type ProcessPlan, type ProcessRole, planProcess } from '~/process'

/** How long verification keys are cached per instance. See the rotation invariant. */
export const SIGNING_KEY_CACHE_TTL_MS = 60_000

/**
 * With Redis, how often an instance checks whether another one changed an environment's signing
 * keys: the longest it keeps serving keys that predate a rotation (see `cacheSigningKeys`).
 */
export const SIGNING_KEY_VERSION_CHECK_MS = 5_000

/**
 * How long an environment's settings (and the union of allowed origins) are cached per
 * instance: the longest another instance keeps applying settings that were since replaced when
 * there is no Redis, or while Redis is down (see `cacheEnvironmentSettings`).
 */
export const ENVIRONMENT_SETTINGS_CACHE_TTL_MS = 30_000

/**
 * With Redis, how often an instance checks whether another one replaced an environment's
 * settings: the longest it keeps applying the previous ones.
 */
export const ENVIRONMENT_SETTINGS_VERSION_CHECK_MS = 5_000

/** Second key segment of the settings change markers in Redis: `tula:es:<environment id>`. */
export const ENVIRONMENT_SETTINGS_VERSION_SEGMENT = 'es'

/**
 * The Twilio sender of a deployment with `SMS_PROVIDER=twilio`.
 *
 * `env.ts` has already required the account, exactly one way to authenticate and exactly one
 * sender; asked again here, so that an environment object that did not come through
 * `parseEnv` cannot build a sender that would fail at its first message, or one whose
 * credentials are a guess. The error names no value.
 */
function twilioSender(env: Env): SmsSender {
  const credentials =
    env.TWILIO_API_KEY_SID && env.TWILIO_API_KEY_SECRET && !env.TWILIO_AUTH_TOKEN
      ? ({
          kind: 'api_key',
          sid: env.TWILIO_API_KEY_SID,
          secret: env.TWILIO_API_KEY_SECRET,
        } as const)
      : env.TWILIO_AUTH_TOKEN && !env.TWILIO_API_KEY_SID && !env.TWILIO_API_KEY_SECRET
        ? ({ kind: 'auth_token', token: env.TWILIO_AUTH_TOKEN } as const)
        : null
  const sender =
    env.TWILIO_MESSAGING_SERVICE_SID && !env.TWILIO_FROM_NUMBER
      ? ({ kind: 'messaging_service', sid: env.TWILIO_MESSAGING_SERVICE_SID } as const)
      : env.TWILIO_FROM_NUMBER && !env.TWILIO_MESSAGING_SERVICE_SID
        ? ({ kind: 'number', number: env.TWILIO_FROM_NUMBER } as const)
        : null
  if (!env.TWILIO_ACCOUNT_SID || !credentials || !sender) {
    throw new Error(
      'SMS_PROVIDER is twilio, and the TWILIO_* variables do not name one account, one way to authenticate and one sender'
    )
  }
  // Which of the two ways, never a value: an operator reading the log sees what is in use.
  logger.info('SMS_PROVIDER is twilio: text messages are sent through Twilio', {
    authentication: credentials.kind,
    sender: sender.kind,
  })
  return createTwilioSmsSender({ accountSid: env.TWILIO_ACCOUNT_SID, credentials, sender })
}

/** Production dependencies plus the function that releases their resources. */
export interface Container {
  deps: Deps
  /** What this process does (`planProcess`): what it serves and which jobs it starts. */
  plan: ProcessPlan
  close: () => Promise<void>
}

/**
 * The composition root: the only place that picks adapters.
 *
 * Connections are lazy, so building the container does not touch the network.
 *
 * @param env - Validated environment.
 * @param role - What the process was started as: the API (the default) or the webhook worker
 *   (`src/worker.ts`). With `WEBHOOK_WORKER` it decides whether this process may call a
 *   webhook endpoint, and a worker's readiness is the database alone.
 * @returns The dependencies and a `close` for graceful shutdown.
 * @throws WorkerNotSeparateError for a worker where `WEBHOOK_WORKER` is `api`, before
 *   anything is built.
 */
export function createContainer(env: Env, role: ProcessRole = 'api'): Container {
  const plan = planProcess(role, env.WEBHOOK_WORKER)
  const database = createDatabase(env.DATABASE_URL)
  const clock = systemClock
  const mailer = new SmtpMailer({ url: env.SMTP_URL, from: env.MAIL_FROM })
  const keyedHash = createKeyedHash(env.TULA_MASTER_KEY)
  // State that API instances must agree on lives in Redis when it is configured. Without it
  // (allowed in `local` and `dev` only, see `env.ts`) it is held in this process's memory.
  const redis = env.REDIS_URL ? connectRedis(env.REDIS_URL, clock) : null
  const signingKeys = new PostgresSigningKeyStore(database.db)
  const environmentSettings = new PostgresEnvironmentSettingsStore(database.db)
  const secretBox = createSecretBox(env.TULA_MASTER_KEY)
  // `env.ts` has already refused the mock outside the `local` tier; checked again here so the
  // choice of adapter never rests on one line elsewhere.
  const oauthMock = env.OAUTH_MOCK_PROVIDER && env.ENVIRONMENT === 'local'
  if (oauthMock) {
    // Loud on purpose, on every boot: with the mock on, anyone who can reach this API signs in
    // as any address they type.
    logger.warn(
      'OAUTH_MOCK_PROVIDER is on: every OAuth provider is served by the built-in mock, which signs in anyone as any address. It must never be used outside local development.'
    )
  }
  // `env.ts` has already refused the development sender outside the `local` tier; checked
  // again here, as for the mock provider. Anywhere else, and with `SMS_PROVIDER=none`, the
  // sender is the one that refuses every message: nothing falls back to a log line.
  const smsInbox =
    env.SMS_PROVIDER === 'dev' && env.ENVIRONMENT === 'local' ? new DevSmsSender(clock) : null
  if (smsInbox) {
    // Loud on purpose, on every boot: with the inbox on, anyone who can reach this API reads
    // every code it "sends".
    logger.warn(
      'SMS_PROVIDER is dev: text messages are not sent. They are kept in memory and readable by anyone who can reach this API at /v1/dev/sms/messages. It must never be used outside local development.'
    )
  }
  if (role === 'api') {
    // A worker starts no attempt, so only the API says it. Not a refused boot: a deployment
    // that binds no session to a device key loses nothing (ADR 0043).
    DeviceBinding.warnIfUnavailable({ publicUrl: env.PUBLIC_URL })
  }
  // The one sender that really sends, in any tier. Nothing falls back from it: a message
  // Twilio does not take is a message that was not sent.
  const sms: SmsSender =
    smsInbox ?? (env.SMS_PROVIDER === 'twilio' ? twilioSender(env) : unconfiguredSmsSender)
  const deps: Deps = {
    config: {
      tier: env.ENVIRONMENT,
      publicUrl: env.PUBLIC_URL,
      corsOrigins: env.CORS_ORIGINS,
      trustProxy: env.TRUST_PROXY,
      passwordPolicy: PASSWORD_POLICY_PRESETS[env.PASSWORD_POLICY],
      oauthMock,
      // Only the digest is kept: the token is compared, never needed again.
      instanceAdminTokenHash: env.TULA_ADMIN_TOKEN ? sha256Hex(env.TULA_ADMIN_TOKEN) : null,
      // Resolved once, here: a directory without an index.html is no dashboard.
      dashboardDir: findDashboardDir(env.DASHBOARD_DIR),
      apiDocs: env.API_DOCS,
      instanceAuditRetentionDays: env.INSTANCE_AUDIT_RETENTION_DAYS,
      deliversWebhooks: plan.deliversWebhooks,
    },
    clock,
    ids: uuidV7Ids,
    apiKeys: new PostgresApiKeyRepository(database.db),
    environments: new PostgresEnvironmentRepository(database.db),
    controlPlane: new PostgresControlPlane(database.db),
    environmentSettings: redis
      ? cacheEnvironmentSettings(environmentSettings, clock, ENVIRONMENT_SETTINGS_CACHE_TTL_MS, {
          versions: new RedisVersions(redis, ENVIRONMENT_SETTINGS_VERSION_SEGMENT),
          checkEveryMs: ENVIRONMENT_SETTINGS_VERSION_CHECK_MS,
        })
      : cacheEnvironmentSettings(environmentSettings, clock, ENVIRONMENT_SETTINGS_CACHE_TTL_MS),
    signingKeys: redis
      ? cacheSigningKeys(signingKeys, clock, SIGNING_KEY_CACHE_TTL_MS, {
          versions: new RedisSigningKeyVersions(redis),
          checkEveryMs: SIGNING_KEY_VERSION_CHECK_MS,
        })
      : cacheSigningKeys(signingKeys, clock, SIGNING_KEY_CACHE_TTL_MS),
    rateLimiter: redis
      ? new RedisRateLimiter(redis, clock, keyedHash)
      : new MemoryRateLimiter(clock),
    lockout: redis ? new RedisLockout(redis) : new MemoryLockout(clock),
    breachChecker: env.BREACH_CHECK === 'hibp' ? new HibpBreachChecker() : offlineBreachChecker,
    verificationTokens: new PostgresVerificationTokenStore(database.db),
    sessions: new PostgresSessionStore(database.db),
    users: new PostgresUserRepository(database.db),
    factors: new PostgresFactorStore(database.db),
    passkeys: new PostgresPasskeyStore(database.db),
    flowAttempts: new PostgresFlowAttemptStore(database.db),
    oauthProviders: new PostgresOAuthProviderStore(database.db),
    oauth: oauthMock
      ? mockOAuthProviders({ secretBox, clock, publicUrl: env.PUBLIC_URL })
      : {
          google: createGoogleProvider(),
          github: createGitHubProvider(),
          apple: createAppleProvider(),
          microsoft: createMicrosoftProvider(),
          discord: createDiscordProvider(),
          linkedin: createLinkedInProvider(),
          x: createXProvider(),
          facebook: createFacebookProvider(),
        },
    activityLog: new PostgresActivityLog(database.db),
    revokedSessions: redis
      ? new RedisRevokedSessions(redis, clock)
      : new MemoryRevokedSessions(clock),
    proofReplay: redis
      ? new RedisProofReplayGuard(redis, clock)
      : new MemoryProofReplayGuard(clock),
    mailer,
    sms,
    smsInbox,
    smsUsage: new PostgresSmsUsageStore(database.db),
    secretBox,
    keyedHash,
    // On Postgres even when Redis is configured: the jobs it guards are database work.
    jobLock: new PostgresJobLock(database.withAdvisoryLock),
    environmentLock: new PostgresEnvironmentLock(database.withAdvisoryLock),
    webhookEndpoints: new PostgresWebhookEndpointStore(database.db),
    webhookDeliveries: new PostgresWebhookDeliveryStore(database.db),
    hooks: new PostgresHookStore(database.db),
    nativeApps: new PostgresNativeAppStore(database.db),
    // The tier and nothing else: the system resolver and the system's certificate authorities.
    // Nothing in the configuration can hand the guard a resolver or a certificate to trust.
    outbound: { tier: env.ENVIRONMENT },
    // From the CSPRNG like everything else here, though nothing depends on it being secret.
    jitter: () => (crypto.getRandomValues(new Uint32Array(1))[0] ?? 0) / 2 ** 32,
    // A worker's rounds are database work and requests to receivers: nothing of it goes
    // through Redis, so a Redis outage must not mark a working worker unready.
    probes:
      redis && plan.role === 'api'
        ? [databaseProbe(database.db), redisProbe(redis)]
        : [databaseProbe(database.db)],
    diagnostics: createDiagnostics({
      db: database.db,
      mailer,
      redis: redis ? redisProbe(redis) : null,
    }),
  }
  return {
    deps,
    plan,
    close: async () => {
      mailer.close()
      redis?.close()
      await database.close()
    },
  }
}
