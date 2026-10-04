import type { AccessTokenClaims, PasswordPolicy } from '@tula/contract'
import type { Tier } from '~/env'
import type { KeyedHash } from '~/lib/keyed-hash'
import type { SecretBox } from '~/lib/secret-box'
import type { ActivityLog } from '~/ports/activity-log'
import type { ApiKeyRepository } from '~/ports/api-key-repository'
import type { BreachChecker } from '~/ports/breach-checker'
import type { Clock } from '~/ports/clock'
import type { EnvironmentRepository } from '~/ports/environment-repository'
import type { EnvironmentSettingsStore } from '~/ports/environment-settings-store'
import type { FactorStore } from '~/ports/factor-store'
import type { FlowAttemptStore } from '~/ports/flow-attempt-store'
import type { HealthProbe } from '~/ports/health-probe'
import type { IdGenerator } from '~/ports/id-generator'
import type { JobLock } from '~/ports/job-lock'
import type { Lockout } from '~/ports/lockout'
import type { Mailer } from '~/ports/mailer'
import type { RateLimiter } from '~/ports/rate-limiter'
import type { RevokedSessions } from '~/ports/revoked-sessions'
import type { SessionStore } from '~/ports/session-store'
import type { SigningKeyStore } from '~/ports/signing-key-store'
import type { UserRepository } from '~/ports/user-repository'
import type { VerificationTokenStore } from '~/ports/verification-token-store'

/** Settings the app reads at request time. Built from `Env` in the container. */
export interface AppConfig {
  tier: Tier
  /** Public base URL; each environment's token issuer lives under it (`environmentIssuer`). */
  publicUrl: string
  /**
   * `CORS_ORIGINS`: the browser origins allowed for admin routes, and the default
   * `urls.allowedOrigins` of an environment that has saved no settings (ADR 0018).
   */
  corsOrigins: readonly string[]
  /** Whether to take the client IP from `X-Forwarded-For`. */
  trustProxy: boolean
  /**
   * `PASSWORD_POLICY`: the default password policy of an environment that has saved no
   * settings. Read the policy that applies through `Passwords.policy`, never from here.
   */
  passwordPolicy: PasswordPolicy
}

/**
 * Everything services depend on. Built by `container.ts` in production and by
 * `createTestDeps()` in tests; services take it (or a `Pick`) as their first argument.
 */
export interface Deps {
  config: AppConfig
  clock: Clock
  ids: IdGenerator
  apiKeys: ApiKeyRepository
  environments: EnvironmentRepository
  /** Per-environment settings documents. Read them through `~/modules/settings/service`. */
  environmentSettings: EnvironmentSettingsStore
  signingKeys: SigningKeyStore
  verificationTokens: VerificationTokenStore
  sessions: SessionStore
  users: UserRepository
  /** Second factors (authenticator apps) and backup codes. */
  factors: FactorStore
  flowAttempts: FlowAttemptStore
  /** Reads the audit log. Activity is written by the stores, with the change it records. */
  activityLog: ActivityLog
  /** Revoked session ids whose access tokens may still be unexpired. */
  revokedSessions: RevokedSessions
  mailer: Mailer
  rateLimiter: RateLimiter
  /** Exponential backoff for failed attempts at guessing a secret. */
  lockout: Lockout
  /** Breached-password lookups for the password policy's `breachCheck`. */
  breachChecker: BreachChecker
  /** Encrypts secrets at rest with keys derived from `TULA_MASTER_KEY`. */
  secretBox: SecretBox
  /** HMACs for low-entropy secrets (codes), with keys derived from `TULA_MASTER_KEY`. */
  keyedHash: KeyedHash
  /** Lets one API instance at a time run a background job (retention). */
  jobLock: JobLock
  /** Dependencies checked by `/v1/ready`. */
  probes: readonly HealthProbe[]
}

/** The project and environment a request's API key resolved to. */
export interface Tenant {
  projectId: string
  environmentId: string
  apiKeyId: string
}

/** Context variables available on every request. */
export interface Variables {
  deps: Deps
  requestId: string
}

/** Added by `publishableKey()` / `secretKey()`. */
export interface TenantVariables {
  tenant: Tenant
}

/** Added by `sessionAuth()`: the verified access-token claims. */
export interface SessionVariables {
  session: AccessTokenClaims
}

/** Hono environment for the app and every router. */
export interface AppEnv {
  Variables: Variables
}
