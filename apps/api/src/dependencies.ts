import type { AccessTokenClaims, PasswordPolicy } from '@tula/contract'
import type { Tier } from '~/env'
import type { SecretBox } from '~/lib/secret-box'
import type { ApiKeyRepository } from '~/ports/api-key-repository'
import type { BreachChecker } from '~/ports/breach-checker'
import type { Clock } from '~/ports/clock'
import type { EnvironmentRepository } from '~/ports/environment-repository'
import type { HealthProbe } from '~/ports/health-probe'
import type { IdGenerator } from '~/ports/id-generator'
import type { RateLimiter } from '~/ports/rate-limiter'
import type { SigningKeyStore } from '~/ports/signing-key-store'

/** Settings the app reads at request time. Built from `Env` in the container. */
export interface AppConfig {
  tier: Tier
  /** Public base URL; each environment's token issuer lives under it (`environmentIssuer`). */
  publicUrl: string
  /** Exact browser origins allowed to make credentialed requests. */
  corsOrigins: readonly string[]
  /** Whether to take the client IP from `X-Forwarded-For`. */
  trustProxy: boolean
  /** Password rules applied to every environment (read through `Passwords.policy`). */
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
  signingKeys: SigningKeyStore
  rateLimiter: RateLimiter
  /** Breached-password lookups for the password policy's `breachCheck`. */
  breachChecker: BreachChecker
  /** Encrypts secrets at rest with keys derived from `TULA_MASTER_KEY`. */
  secretBox: SecretBox
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
