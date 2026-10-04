import type { OAuthProvider } from '@tula/contract'
import type { Deps } from '~/dependencies'
import { isLoopbackUrl } from '~/env'
import * as logger from '~/lib/logger'
import { errorReason } from '~/lib/safe-error'
import * as Jwks from '~/modules/jwks/service'
import * as OAuth from '~/modules/oauth/service'
import type { DatabaseDiagnosis } from '~/ports/diagnostics'
import { version } from '../../../package.json'
import type { DiagnosticCheck, InstanceDiagnostics } from './schema'

/** How long one check may take before it counts as failed. */
export const CHECK_TIMEOUT_MS = 5_000

/** A difference between the API's and the database's clock that is worth a warning. */
export const CLOCK_SKEW_WARN_MS = 5_000

/**
 * A difference that breaks things: a TOTP code is valid for 30 seconds, and an access token
 * for about a minute.
 */
export const CLOCK_SKEW_FAIL_MS = 30_000

/** Environments looked at by the checks that read stored data: a bound on the route's cost. */
export const MAX_ENVIRONMENTS_CHECKED = 200

type DiagnosticsDeps = Pick<
  Deps,
  | 'config'
  | 'clock'
  | 'diagnostics'
  | 'environments'
  | 'signingKeys'
  | 'oauthProviders'
  | 'secretBox'
>

/** The database's answer, with the API's own clock at the moment it arrived. */
interface TimedDiagnosis extends DatabaseDiagnosis {
  readAt: Date
}

/** What the checks that read stored data share: read once. */
interface Stored {
  sealed: number
  unopened: number
  signingKeys: number
  providerCredentials: number
  enabledProviders: OAuthProvider[]
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
  })
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}

/** Run a probe; its failure goes to the log and comes back as `null`, never as text. */
async function attempt<T>(id: string, work: () => Promise<T>, timeoutMs: number) {
  try {
    return { value: await withTimeout(work(), timeoutMs) }
  } catch (error) {
    logger.warn('diagnostic check failed', { check: id, reason: errorReason(error) })
    return null
  }
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function databaseCheck(database: { value: DatabaseDiagnosis } | null): DiagnosticCheck {
  return database
    ? { id: 'database', status: 'ok', summary: 'The database answers.' }
    : {
        id: 'database',
        status: 'fail',
        summary: 'The database cannot be reached.',
        fix: 'Check DATABASE_URL (host, port, role, password) and that Postgres is running and accepts connections: `docker compose ps`, `docker compose logs postgres`.',
      }
}

function migrationsCheck(
  database: { value: DatabaseDiagnosis } | null,
  shipped: readonly number[]
): DiagnosticCheck {
  const id = 'migrations'
  if (!database) {
    return { id, status: 'skipped', summary: 'Not checked: the database cannot be reached.' }
  }
  const migrate =
    'Run the migrations as the schema owner: `docker compose run --rm migrate` (or `bun run db:migrate` with DATABASE_MIGRATION_URL), then restart the API.'
  const applied = database.value.appliedMigrations
  if (applied === null) {
    return {
      id,
      status: 'fail',
      summary:
        'The migration history cannot be read: the database is not migrated to this version.',
      fix: migrate,
    }
  }
  const known = new Set(shipped)
  const missing = shipped.filter((when) => !applied.includes(when)).length
  if (missing > 0) {
    return {
      id,
      status: 'fail',
      summary: `The database is behind this version: ${shipped.length - missing} of ${shipped.length} migrations are applied.`,
      fix: migrate,
    }
  }
  if (applied.some((when) => !known.has(when))) {
    return {
      id,
      status: 'warn',
      summary:
        'The database has migrations this version does not ship: it was migrated by a newer version.',
      fix: 'Run the same version on every instance: upgrade this one to the version that migrated the database.',
    }
  }
  return {
    id,
    status: 'ok',
    summary: `All ${plural(shipped.length, 'migration')} this version ships are applied.`,
  }
}

function clockCheck(database: { value: TimedDiagnosis } | null): DiagnosticCheck {
  const id = 'clock'
  if (!database) {
    return { id, status: 'skipped', summary: 'Not checked: the database cannot be reached.' }
  }
  // Against the API's clock at the moment the database answered, not when every check was done.
  const skewMs = Math.abs(database.value.now.getTime() - database.value.readAt.getTime())
  if (skewMs < CLOCK_SKEW_WARN_MS) {
    return { id, status: 'ok', summary: 'The API’s clock and the database’s agree.' }
  }
  return {
    id,
    status: skewMs >= CLOCK_SKEW_FAIL_MS ? 'fail' : 'warn',
    summary: `The API’s clock and the database’s differ by about ${Math.round(skewMs / 1000)} seconds.`,
    fix: 'Synchronize the hosts’ clocks (NTP, or the container runtime’s time sync). Codes, tokens and expiry times all depend on them.',
  }
}

/** Open one sealed value per kind and environment, and note which providers are enabled. */
async function readStored(deps: DiagnosticsDeps): Promise<Stored> {
  const stored: Stored = {
    sealed: 0,
    unopened: 0,
    signingKeys: 0,
    providerCredentials: 0,
    enabledProviders: [],
  }
  const environments = (await deps.environments.listAll()).slice(0, MAX_ENVIRONMENTS_CHECKED)
  for (const environment of environments) {
    const keys = await deps.signingKeys.list(environment.id)
    // The key that signs: the one whose loss stops sign-in.
    const key = keys.find((candidate) => candidate.status === 'active') ?? keys[0]
    if (key) {
      stored.sealed += 1
      stored.signingKeys += 1
      const opens = await deps.secretBox
        .open(
          Jwks.SECRET_BOX_PURPOSE,
          key.privateKeyCiphertext,
          Jwks.ciphertextAad(key.id, environment.id)
        )
        .then(
          () => true,
          () => false
        )
      stored.unopened += opens ? 0 : 1
    }
    for (const provider of await deps.oauthProviders.list(environment.id)) {
      stored.sealed += 1
      stored.providerCredentials += 1
      stored.unopened += (await OAuth.secretOpens(deps, provider)) ? 0 : 1
      if (provider.enabled && !stored.enabledProviders.includes(provider.provider)) {
        stored.enabledProviders.push(provider.provider)
      }
    }
  }
  return stored
}

function masterKeyCheck(stored: { value: Stored } | null): DiagnosticCheck {
  const id = 'master_key'
  if (!stored) {
    return {
      id,
      status: 'skipped',
      summary: 'Not checked: the stored keys could not be read from the database.',
    }
  }
  const { sealed, unopened, signingKeys, providerCredentials } = stored.value
  if (sealed === 0) {
    return { id, status: 'skipped', summary: 'Nothing is sealed with the master key yet.' }
  }
  if (unopened > 0) {
    return {
      id,
      status: 'fail',
      summary: `TULA_MASTER_KEY does not open ${unopened} of the ${plural(sealed, 'stored secret')} checked.`,
      fix: 'Set TULA_MASTER_KEY to the key this database’s data was sealed with, on every instance, and restart. If that key is lost, signing keys must be rotated and provider credentials entered again.',
    }
  }
  return {
    id,
    status: 'ok',
    summary: `TULA_MASTER_KEY opens the stored secrets (${plural(signingKeys, 'signing key')}, ${plural(providerCredentials, 'provider credential')}).`,
  }
}

function smtpCheck(result: { value: void } | null): DiagnosticCheck {
  return result
    ? {
        id: 'smtp',
        status: 'ok',
        summary: 'The mail relay accepts the connection. No message was sent.',
      }
    : {
        id: 'smtp',
        status: 'fail',
        summary: 'The mail relay cannot be reached or refused the connection.',
        fix: 'Check SMTP_URL (host, port, user, password, smtp:// or smtps://) and that the relay is running and reachable from the API. Until it works no code, link or notice is delivered.',
      }
}

function redisCheck(configured: boolean, result: { value: void } | null): DiagnosticCheck {
  const id = 'redis'
  if (!configured) {
    return {
      id,
      status: 'skipped',
      summary:
        'Redis is not configured: rate limits, lockout and revoked sessions are held in this process’s memory, which is right for one instance only.',
    }
  }
  return result
    ? { id, status: 'ok', summary: 'Redis answers.' }
    : {
        id,
        status: 'fail',
        summary: 'Redis cannot be reached.',
        fix: 'Check REDIS_URL and that Redis is running and reachable from the API. Until it answers, requests that need a rate limit are refused (service.unavailable).',
      }
}

function publicUrlCheck(loopback: boolean, result: { value: number } | null): DiagnosticCheck {
  const id = 'public_url'
  if (loopback) {
    return {
      id,
      status: 'skipped',
      summary:
        'PUBLIC_URL is a loopback address, which the server cannot check from where it runs. `tula doctor` checks it from your machine.',
    }
  }
  const fix =
    'Set PUBLIC_URL to the address clients use to reach this API (scheme and host, no path), and check its DNS record, its certificate and the proxy in front of the API. It is the issuer of every token and the base of every OAuth redirect URI.'
  if (!result) {
    return { id, status: 'fail', summary: 'PUBLIC_URL gives no answer from the server.', fix }
  }
  if (result.value === 200) {
    return { id, status: 'ok', summary: 'PUBLIC_URL reaches an API that answers.' }
  }
  const redirect = result.value >= 300 && result.value < 400
  return {
    id,
    status: 'fail',
    summary: redirect
      ? 'PUBLIC_URL answers with a redirect instead of the API.'
      : `PUBLIC_URL answers with HTTP ${result.value} instead of the API’s status.`,
    fix,
  }
}

function redirectUriCheck(
  config: Deps['config'],
  stored: { value: Stored } | null
): DiagnosticCheck {
  const id = 'oauth_redirect_uris'
  if (config.oauthMock) {
    return {
      id,
      status: 'warn',
      summary:
        'OAUTH_MOCK_PROVIDER is on: every OAuth provider is the built-in mock, which signs in anyone as any address.',
      fix: 'Leave it on for local development only. Unset OAUTH_MOCK_PROVIDER to use the real providers.',
    }
  }
  if (!stored) {
    return {
      id,
      status: 'skipped',
      summary: 'Not checked: the providers could not be read from the database.',
    }
  }
  const providers = [...stored.value.enabledProviders].sort()
  if (providers.length === 0) {
    return { id, status: 'skipped', summary: 'No OAuth provider is enabled.' }
  }
  return {
    id,
    status: 'skipped',
    summary:
      'Cannot be verified from here: each enabled provider’s console must list exactly this redirect URI.',
    values: providers.map((provider) => `${provider}: ${OAuth.callbackUrl(config, provider)}`),
  }
}

/**
 * Check what actually goes wrong in a deployment: the database and its migrations, the master
 * key against the stored secrets, the mail relay, Redis, the clocks, `PUBLIC_URL`, and the
 * redirect URI each enabled OAuth provider must have registered.
 *
 * Every check runs at once and is cut off after `timeoutMs`. Nothing is changed and no email
 * is sent. A check's text is fixed: the reason a probe failed goes to the log only, because a
 * driver's message can name hosts, users and credentials.
 *
 * @param deps - The diagnostics probes, the stores the stored secrets are read from, the secret
 *   box, the configuration and the clock.
 * @param timeoutMs - Per-check timeout (default {@link CHECK_TIMEOUT_MS}).
 * @returns The checks, in a stable order, with the API's version, tier, clock and `PUBLIC_URL`.
 */
export async function diagnostics(
  deps: DiagnosticsDeps,
  timeoutMs: number = CHECK_TIMEOUT_MS
): Promise<InstanceDiagnostics> {
  const { config } = deps
  const probes = deps.diagnostics
  const loopback = isLoopbackUrl(config.publicUrl)
  const statusUrl = `${config.publicUrl.replace(/\/+$/, '')}/v1/status`
  const redisProbe = probes.redis
  const [database, stored, smtp, redis, publicUrl] = await Promise.all([
    attempt(
      'database',
      async (): Promise<TimedDiagnosis> => {
        const before = deps.clock.now().getTime()
        const diagnosis = await probes.database()
        // The database read its clock somewhere between the two: compare with the middle.
        const readAt = new Date((before + deps.clock.now().getTime()) / 2)
        return { ...diagnosis, readAt }
      },
      timeoutMs
    ),
    attempt('stored_secrets', () => readStored(deps), timeoutMs),
    attempt('smtp', () => probes.smtp(), timeoutMs),
    redisProbe ? attempt('redis', () => redisProbe(), timeoutMs) : null,
    // Only ever the deployment's own PUBLIC_URL: never a URL from the request.
    loopback
      ? null
      : attempt('public_url', () => probes.httpStatus(statusUrl, timeoutMs), timeoutMs),
  ])
  const now = deps.clock.now()
  return {
    version,
    environment: config.tier,
    time: now.toISOString(),
    publicUrl: config.publicUrl,
    checks: [
      databaseCheck(database),
      migrationsCheck(database, probes.shippedMigrations),
      masterKeyCheck(stored),
      smtpCheck(smtp),
      redisCheck(redisProbe !== null, redis),
      clockCheck(database),
      publicUrlCheck(loopback, publicUrl),
      redirectUriCheck(config, stored),
    ],
  }
}
