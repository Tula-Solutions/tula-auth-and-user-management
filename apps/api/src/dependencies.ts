import type { AccessTokenClaims, PasswordPolicy } from '@tula/contract'
import type { Tier } from '~/env'
import type { KeyedHash } from '~/lib/keyed-hash'
import type { OutboundDeps } from '~/lib/outbound'
import type { SecretBox } from '~/lib/secret-box'
import type { ActivityLog } from '~/ports/activity-log'
import type { ApiKeyRepository } from '~/ports/api-key-repository'
import type { BreachChecker } from '~/ports/breach-checker'
import type { Clock } from '~/ports/clock'
import type { ControlPlane } from '~/ports/control-plane'
import type { Diagnostics } from '~/ports/diagnostics'
import type { EnvironmentLock } from '~/ports/environment-lock'
import type { EnvironmentRepository } from '~/ports/environment-repository'
import type { EnvironmentSettingsStore } from '~/ports/environment-settings-store'
import type { FactorStore } from '~/ports/factor-store'
import type { FlowAttemptStore } from '~/ports/flow-attempt-store'
import type { HealthProbe } from '~/ports/health-probe'
import type { HookStore } from '~/ports/hook-store'
import type { IdGenerator } from '~/ports/id-generator'
import type { JobLock } from '~/ports/job-lock'
import type { Lockout } from '~/ports/lockout'
import type { Mailer } from '~/ports/mailer'
import type { NativeAppStore } from '~/ports/native-app-store'
import type { OAuthProviders } from '~/ports/oauth-provider'
import type { OAuthProviderStore } from '~/ports/oauth-provider-store'
import type { PasskeyStore } from '~/ports/passkey-store'
import type { ProofReplayGuard } from '~/ports/proof-replay'
import type { RateLimiter } from '~/ports/rate-limiter'
import type { RevokedSessions } from '~/ports/revoked-sessions'
import type { SessionStore } from '~/ports/session-store'
import type { SigningKeyStore } from '~/ports/signing-key-store'
import type { SmsInbox, SmsSender } from '~/ports/sms-sender'
import type { SmsUsageStore } from '~/ports/sms-usage-store'
import type { UserRepository } from '~/ports/user-repository'
import type { VerificationTokenStore } from '~/ports/verification-token-store'
import type { WebhookDeliveryStore } from '~/ports/webhook-delivery-store'
import type { WebhookEndpointStore } from '~/ports/webhook-endpoint-store'

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
  /**
   * Every OAuth provider is served by the built-in mock provider, and its consent page is
   * mounted (`OAUTH_MOCK_PROVIDER`). Only ever `true` in the `local` tier: `env.ts` refuses to
   * boot with it anywhere else. A development and test aid (ADR 0026).
   */
  oauthMock: boolean
  /**
   * SHA-256 (hex) of `TULA_ADMIN_TOKEN`, the instance admin token; `null` when the deployment
   * sets none, and the instance routes then do not exist. The token itself is not kept.
   */
  instanceAdminTokenHash: string | null
  /**
   * The real path of the dashboard's build output (`DASHBOARD_DIR`, or `apps/dashboard/dist`),
   * served at `/dashboard`; `null` when there is none, and `/dashboard` is then an unknown path.
   */
  dashboardDir: string | null
  /**
   * Whether the API reference page is served at `/v1/docs` (`API_DOCS`: on by default in the
   * `local` and `dev` tiers only). Off, the page and its scripts are unknown paths.
   */
  apiDocs: boolean
  /**
   * Days an instance audit entry is kept before the retention job deletes it
   * (`INSTANCE_AUDIT_RETENTION_DAYS`, default 365). An environment's audit log has its own
   * period, in its settings (`audit.retentionDays`, ADR 0017), not this one.
   */
  instanceAuditRetentionDays: number
  /**
   * Whether this process may make a request to a webhook endpoint: the worker's rounds, a test
   * event, a delivery sent again. `false` only in an API instance of a deployment whose
   * worker is its own service (`WEBHOOK_WORKER=separate`): there `Webhooks.run` does nothing
   * and the two on-demand routes are refused (`not_implemented`, 501, with
   * `params.reason: 'worker_separate'`). Decided once, by
   * `planProcess` (`~/process`), from the command the process was started with.
   */
  deliversWebhooks: boolean
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
  /** Passkeys (WebAuthn credentials) and the challenges of signed-in sessions. */
  passkeys: PasskeyStore
  flowAttempts: FlowAttemptStore
  /** Each environment's own OAuth credentials (sealed). */
  oauthProviders: OAuthProviderStore
  /** The protocol adapter of each OAuth provider. */
  oauth: OAuthProviders
  /** Reads the audit log. Activity is written by the stores, with the change it records. */
  activityLog: ActivityLog
  /** Revoked session ids whose access tokens may still be unexpired. */
  revokedSessions: RevokedSessions
  /** The ids of accepted device-binding proofs: a proof is accepted once (ADR 0043). */
  proofReplay: ProofReplayGuard
  mailer: Mailer
  /**
   * Sends text messages. Send through `~/modules/sms/service`, after `Settings.requireSms`.
   * A deployment with no sender (`SMS_PROVIDER=none`) has one that refuses every message.
   */
  sms: SmsSender
  /**
   * The development SMS inbox (`SMS_PROVIDER=dev`): what the local-tier route
   * `GET /v1/dev/sms/messages` reads. `null` everywhere else, and the route then does not
   * exist. Only ever set in the `local` tier: `env.ts` refuses the development sender
   * anywhere else (ADR 0037).
   */
  smsInbox: SmsInbox | null
  /**
   * Codes texted and used, per destination prefix and day: written by `~/modules/sms/service`
   * and read by the admin API. Counts only, never a number (ADR 0037).
   */
  smsUsage: SmsUsageStore
  rateLimiter: RateLimiter
  /** Exponential backoff for failed attempts at guessing a secret. */
  lockout: Lockout
  /** Breached-password lookups for the password policy's `breachCheck`. */
  breachChecker: BreachChecker
  /** Encrypts secrets at rest with keys derived from `TULA_MASTER_KEY`. */
  secretBox: SecretBox
  /** HMACs for low-entropy secrets (codes), with keys derived from `TULA_MASTER_KEY`. */
  keyedHash: KeyedHash
  /** Lets one API instance at a time run a background job (retention, webhook delivery). */
  jobLock: JobLock
  /** Where an environment's events are delivered, and the sealed secret each is signed with. */
  webhookEndpoints: WebhookEndpointStore
  /** The outbox's waiting events and the record of what became of sending them. */
  webhookDeliveries: WebhookDeliveryStore
  /** The questions an environment has the server ask before it acts, and their sealed secrets. */
  hooks: HookStore
  /** The native apps an environment says are its own: what its association files are built from. */
  nativeApps: NativeAppStore
  /**
   * What the outbound guard (`~/lib/outbound`) judges an operator's address by: the tier, and
   * in tests a resolver. Pass it to `Outbound.check` and `Outbound.request`; never build one
   * at a call site.
   */
  outbound: OutboundDeps
  /**
   * A number from 0 (inclusive) to 1 (exclusive), for spreading out retries so that deliveries
   * which failed together do not all come back together. **Never for a secret, a token or an
   * id**: those come from `~/lib/crypto`. A test gives a fixed number.
   */
  jitter: () => number
  /**
   * Makes writes that share an invariant across stores take turns, per environment (the
   * settings document and the OAuth providers: "at least one sign-in method").
   */
  environmentLock: EnvironmentLock
  /** Dependencies checked by `/v1/ready`. */
  probes: readonly HealthProbe[]
  /** The probes behind `GET /v1/instance/diagnostics`. */
  diagnostics: Diagnostics
  /** Workspaces, projects, environment creation and the instance audit log (ADR 0032). */
  controlPlane: ControlPlane
}

/**
 * The project and environment a request resolved to: by its API key, or by a dashboard session
 * together with the `x-tula-environment` header.
 */
export interface Tenant {
  projectId: string
  environmentId: string
  /** The key's id; empty when no key authorized the request (a dashboard session, a flow). */
  apiKeyId: string
}

/** A verified dashboard session (ADR 0032). */
export interface DashboardSession {
  /** The session's random id: the `instance_admin` actor's id in the audit logs. */
  id: string
  expiresAt: Date
}

/** Context variables available on every request. */
export interface Variables {
  deps: Deps
  requestId: string
  /** Set when the request was authorized by a dashboard session. */
  dashboard?: DashboardSession
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
