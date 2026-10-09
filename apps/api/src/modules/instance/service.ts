import type { OAuthProvider } from '@tula/contract'
import type { Deps } from '~/dependencies'
import { isLoopbackUrl } from '~/env'
import * as logger from '~/lib/logger'
import { errorReason } from '~/lib/safe-error'
import * as Jwks from '~/modules/jwks/service'
import * as OAuth from '~/modules/oauth/service'
import * as Settings from '~/modules/settings/service'
import type { DatabaseDiagnosis } from '~/ports/diagnostics'
import { version } from '../../../package.json'
import { WEBHOOK_WAITING_TOO_LONG_MS } from './constants'
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

/**
 * Environments looked at by the checks that read stored data: a bound on the route's cost.
 * A deployment with more is told so (`warn`): the check never claims more than it opened.
 */
export const MAX_ENVIRONMENTS_CHECKED = 200

// Defined in a file that imports nothing, so that the worker check (`scripts/worker-check/`)
// can wait against this number and not a copy of it.
export { WEBHOOK_WAITING_TOO_LONG_MS }

type DiagnosticsDeps = Pick<
  Deps,
  | 'config'
  | 'clock'
  | 'diagnostics'
  | 'environments'
  | 'signingKeys'
  | 'oauthProviders'
  | 'secretBox'
  | 'webhookDeliveries'
  | 'environmentSettings'
  | 'sms'
  | 'smsInbox'
>

/** The database's answer, with the API's own clock at the moment it arrived. */
interface TimedDiagnosis extends DatabaseDiagnosis {
  readAt: Date
}

/** What the checks that read stored data share: read once. */
interface Stored {
  /** Environments the deployment has. */
  environments: number
  /** Environments whose secrets were opened: the oldest, at most {@link MAX_ENVIRONMENTS_CHECKED}. */
  checked: number
  sealed: number
  unopened: number
  signingKeys: number
  providerCredentials: number
  enabledProviders: OAuthProvider[]
  /**
   * Of the environments checked, those whose oldest event still waiting to be queued for
   * delivery has waited {@link WEBHOOK_WAITING_TOO_LONG_MS} or longer; `null` when the events
   * could not be read.
   */
  overdue: number | null
  /**
   * Of the environments checked, those whose settings have text messages on (`sms.enabled`
   * with at least one allowed country: what `Settings.requireSms` lets through); `null` when
   * the settings could not be read. Counted only in a deployment without an SMS sender, where
   * it is what the `sms_sender` check is about: with a sender it stays 0 and nothing is read.
   */
  smsOn: number | null
}

/**
 * Wait for `work` at most `ms`. The signal it is given is aborted at the deadline: giving up
 * on the answer does not stop the work, so work that makes many calls must look at it.
 */
function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`timed out after ${ms}ms`)
      controller.abort(error)
      reject(error)
    }, ms)
  })
  return Promise.race([work(controller.signal), timeout]).finally(() => clearTimeout(timer))
}

/** Run a probe; its failure goes to the log and comes back as `null`, never as text. */
async function attempt<T>(
  id: string,
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number
) {
  try {
    return { value: await withTimeout(work, timeoutMs) }
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

/**
 * Open one sealed value per kind and environment, and note which providers are enabled.
 *
 * The oldest environments first, so that two runs look at the same ones. `signal` is the
 * check's deadline: it is looked at before every environment, because the caller stopped
 * waiting then and every further query would be work nobody reads.
 */
async function readStored(deps: DiagnosticsDeps, signal: AbortSignal): Promise<Stored> {
  const all = (await deps.environments.listAll()).sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id)
  )
  const environments = all.slice(0, MAX_ENVIRONMENTS_CHECKED)
  const stored: Stored = {
    environments: all.length,
    checked: environments.length,
    sealed: 0,
    unopened: 0,
    signingKeys: 0,
    providerCredentials: 0,
    enabledProviders: [],
    overdue: 0,
    smsOn: 0,
  }
  for (const environment of environments) {
    signal.throwIfAborted()
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
    if (stored.overdue !== null) {
      stored.overdue = await overdueAfter(deps, environment.id, stored.overdue)
    }
    // Only where the answer decides something: a deployment that has a sender is not asked
    // which of its environments use it.
    if (stored.smsOn !== null && !deps.sms.configured) {
      stored.smsOn = await smsOnAfter(deps, environment.id, stored.smsOn)
    }
  }
  return stored
}

/**
 * Count an environment in when its settings have text messages on. Two fields of its
 * settings are looked at and a number comes back: no setting leaves this function.
 *
 * Read through the settings cache, like every request: a count a few seconds old is right
 * for a diagnosis, and nothing is deleted or sent on it. A failure is logged, the count
 * becomes `null` (the `sms_sender` check then says it could not look) and the rest of the
 * scan goes on.
 */
async function smsOnAfter(
  deps: DiagnosticsDeps,
  environmentId: string,
  on: number
): Promise<number | null> {
  try {
    const { sms } = await Settings.current(deps, { environmentId })
    return on + (sms.enabled && sms.allowedCountries.length > 0 ? 1 : 0)
  } catch (error) {
    logger.warn('diagnostic check failed', { check: 'sms_sender', reason: errorReason(error) })
    return null
  }
}

/**
 * Count an environment in when its oldest event still waiting to be queued for delivery has
 * waited too long. Only its time is read: no event, and so no payload, leaves the store.
 *
 * A failure here is the outbox's, not the stored secrets': it is logged, the count becomes
 * `null` (the `webhook_worker` check then says it could not look) and the rest of the scan
 * goes on.
 */
async function overdueAfter(
  deps: DiagnosticsDeps,
  environmentId: string,
  overdue: number
): Promise<number | null> {
  try {
    const oldest = await deps.webhookDeliveries.oldestPendingEventAt(environmentId)
    const waited = oldest ? deps.clock.now().getTime() - oldest.getTime() : 0
    return overdue + (waited >= WEBHOOK_WAITING_TOO_LONG_MS ? 1 : 0)
  } catch (error) {
    logger.warn('diagnostic check failed', { check: 'webhook_worker', reason: errorReason(error) })
    return null
  }
}

/** The scan of stored secrets still running for a deployment, keyed by its diagnostics port. */
const scans = new WeakMap<object, Promise<unknown>>()

/**
 * {@link readStored}, at most one at a time per deployment.
 *
 * A scan whose query never answers outlives its deadline (a deadline cannot cancel a query
 * that is already with the database). Starting another on top of it, on every request, is how
 * a slow database loses its last connections: until the earlier one settles, this refuses.
 */
function scanStored(deps: DiagnosticsDeps, signal: AbortSignal): Promise<Stored> {
  const key = deps.diagnostics
  if (scans.has(key)) {
    return Promise.reject(new Error('an earlier scan of the stored secrets is still running'))
  }
  const scan = readStored(deps, signal)
  const done = () => scans.delete(key)
  scans.set(key, scan.then(done, done))
  return scan
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
  const { environments, checked, sealed, unopened, signingKeys, providerCredentials } = stored.value
  const scope = `the first ${checked} of ${environments} environments`
  const truncated = checked < environments
  if (unopened > 0) {
    return {
      id,
      status: 'fail',
      summary: truncated
        ? `TULA_MASTER_KEY does not open ${unopened} of the ${plural(sealed, 'stored secret')} checked in ${scope}.`
        : `TULA_MASTER_KEY does not open ${unopened} of the ${plural(sealed, 'stored secret')} checked.`,
      fix: 'Set TULA_MASTER_KEY to the key this database’s data was sealed with, on every instance, and restart. If that key is lost, signing keys must be rotated and provider credentials entered again.',
    }
  }
  if (truncated) {
    return {
      id,
      status: 'warn',
      summary: `Only ${scope} were checked: TULA_MASTER_KEY opens their stored secrets (${plural(signingKeys, 'signing key')}, ${plural(providerCredentials, 'provider credential')}). The other ${environments - checked} were not opened.`,
      fix: `One run opens the secrets of the ${MAX_ENVIRONMENTS_CHECKED} oldest environments only. If sign-in fails in a newer environment with a signing-key error in the API’s log, its data was sealed with another TULA_MASTER_KEY.`,
    }
  }
  if (sealed === 0) {
    return { id, status: 'skipped', summary: 'Nothing is sealed with the master key yet.' }
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
 * Whether webhook deliveries are being made, judged by what waits (ADR 0034, "The worker as
 * its own service").
 *
 * An API instance cannot see a worker process, and with `WEBHOOK_WORKER=separate` it makes no
 * delivery itself. What it can see is the outbox: every delivery round settles every waiting
 * event, so one that has waited a minute was looked at by no round. That catches the
 * deployment where every process says `separate` and no worker was started, and a worker that
 * runs and cannot work, as soon as something has happened; with nothing waiting it says `ok`
 * and says that it did not look at the worker. Where the API instances deliver, the same
 * finding is a warning: the job runs in the process that answers, so it is behind, not absent.
 *
 * Counts only: never an event, an environment's id or a payload.
 */
function webhookWorkerCheck(
  config: Deps['config'],
  stored: { value: Stored } | null
): DiagnosticCheck {
  const id = 'webhook_worker'
  const overdue = stored?.value.overdue ?? null
  if (!stored || overdue === null) {
    return {
      id,
      status: 'skipped',
      summary: 'Not checked: the events waiting for delivery could not be read from the database.',
    }
  }
  const { environments, checked } = stored.value
  const truncated = checked < environments
  const scope = `the first ${checked} of ${environments}`
  if (overdue > 0) {
    const where = `in ${plural(overdue, 'environment')}${truncated ? ` of ${scope}` : ''}`
    return config.deliversWebhooks
      ? {
          id,
          status: 'warn',
          summary: `Events have waited a minute or more to be queued for delivery, ${where}: the delivery job is behind or failing.`,
          fix: 'WEBHOOK_WORKER is `api`, so every API instance runs the delivery job. Look in the API’s log for `could not run the webhook delivery job` and `webhook delivery failed in one environment`, and check that the database is reachable and not overloaded.',
        }
      : {
          id,
          status: 'fail',
          // Worded for what was looked at, the outbox: a worker that is absent, one that is
          // behind and one that cannot work all leave it like this, and no worker was seen.
          summary: `Events have waited a minute or more to be queued for delivery, ${where}: the worker is not running, or it cannot keep up or cannot work.`,
          fix: 'WEBHOOK_WORKER is `separate`, so no API instance makes a delivery: only a worker process does, and this check sees what waits, not the worker. See whether one is running (the same image with the command `bun run src/worker.ts`; with Compose, `docker compose --profile app --profile worker up -d`). If one is, read its log: `could not run the webhook delivery job` or `webhook delivery failed in one environment` means it cannot work, and rounds that finish while events still wait mean it cannot keep up. Or set WEBHOOK_WORKER=api on every instance and restart them.',
        }
  }
  if (truncated) {
    const rest = environments - checked
    return {
      id,
      status: 'warn',
      summary: `Only ${scope} environments were looked at: no event of theirs has waited a minute or more to be queued for delivery. The other ${rest} ${rest === 1 ? 'was' : 'were'} not read.`,
      fix: `One run reads the waiting events of the ${MAX_ENVIRONMENTS_CHECKED} oldest environments only. If deliveries of a newer environment do not arrive, look at its delivery log and at the log of the process that delivers.`,
    }
  }
  return {
    id,
    status: 'ok',
    summary: config.deliversWebhooks
      ? 'No event has waited a minute or more to be queued for delivery. WEBHOOK_WORKER is `api`: the API instances make the deliveries.'
      : 'No event has waited a minute or more to be queued for delivery. WEBHOOK_WORKER is `separate`: a worker process makes the deliveries. This check sees what waits, not the worker.',
  }
}

/**
 * Whether the deployment can send the text messages its environments were told to send
 * (ADR 0037, "Twilio"; ADR 0031).
 *
 * "SMS on" is an environment's setting and the sender is the deployment's (`SMS_PROVIDER`):
 * the boot cannot see the first, so the two are compared here. An environment with text
 * messages on in a deployment without a sender sends nothing, and says so only to whoever
 * asks for a code (`sms.unavailable`). It is a warning and not a failure: nobody signs in
 * with a texted code, and the client configuration already hides the phone number where
 * there is no sender, so nothing a user can reach is broken. It becomes a failure with
 * sign-in by SMS (TULA-27).
 *
 * With a sender it says that one is configured and nothing more: no message is sent and the
 * provider is not asked, so it never claims the credentials work. Counts only: never an
 * environment's id, a number or a country.
 */
function smsSenderCheck(
  deps: Pick<DiagnosticsDeps, 'sms' | 'smsInbox'>,
  stored: { value: Stored } | null
): DiagnosticCheck {
  const id = 'sms_sender'
  if (deps.smsInbox !== null) {
    return {
      id,
      status: 'ok',
      summary:
        'SMS_PROVIDER is `dev`: text messages are kept in the development inbox and reach no phone. Local development only.',
    }
  }
  if (deps.sms.configured) {
    return {
      id,
      status: 'ok',
      summary:
        'The deployment has a sender for text messages (SMS_PROVIDER). No message was sent and the provider was not asked: this does not show that its credentials or its sender work.',
    }
  }
  const on = stored?.value.smsOn ?? null
  if (!stored || on === null) {
    return {
      id,
      status: 'skipped',
      summary: 'Not checked: the environments’ settings could not be read from the database.',
    }
  }
  const { environments, checked } = stored.value
  const truncated = checked < environments
  const scope = `the first ${checked} of ${environments}`
  const configure =
    'Set SMS_PROVIDER=twilio and the TWILIO_* variables on every API instance and restart them (docs/self-host.md, “Text messages with Twilio”).'
  if (on > 0) {
    return {
      id,
      status: 'warn',
      summary: `SMS_PROVIDER is \`none\`, and ${plural(on, 'environment')}${truncated ? ` of ${scope}` : ''} ${on === 1 ? 'has' : 'have'} text messages switched on: no message is sent, and a request that would send one is answered \`sms.unavailable\`.`,
      fix: `${configure} Or switch text messages off in the settings of the environments that have them on.`,
    }
  }
  if (truncated) {
    const rest = environments - checked
    return {
      id,
      status: 'warn',
      summary: `SMS_PROVIDER is \`none\`. Only ${scope} environments were looked at: none of them has text messages switched on. The other ${rest} ${rest === 1 ? 'was' : 'were'} not read.`,
      fix: `One run reads the settings of the ${MAX_ENVIRONMENTS_CHECKED} oldest environments only. If a newer environment has text messages on, its requests for a code are answered \`sms.unavailable\`: ${configure}`,
    }
  }
  return {
    id,
    status: 'skipped',
    summary:
      'The deployment has no sender for text messages (SMS_PROVIDER is `none`), and no environment has them switched on.',
  }
}

/**
 * Check what actually goes wrong in a deployment: the database and its migrations, the master
 * key against the stored secrets, the mail relay, Redis, the clocks, `PUBLIC_URL`, the
 * redirect URI each enabled OAuth provider must have registered, whether events are waiting
 * for a webhook worker that is not taking them, and whether an environment was told to send
 * text messages in a deployment that has nothing to send them with.
 *
 * Every check runs at once and is cut off after `timeoutMs`; the scan of stored secrets stops
 * at its deadline and is never started while an earlier one is still running. Callers that
 * arrive while a run is in flight share it (one run per deployment at a time: the route is
 * cheap to ask and not cheap to answer); nothing is kept once it has answered. Nothing is
 * changed and no email is sent. A check's text is fixed: the reason a probe failed goes to the log only, because a
 * driver's message can name hosts, users and credentials.
 *
 * @param deps - The diagnostics probes, the stores the stored secrets and the settings are
 *   read from, the secret box, the SMS sender, the configuration and the clock.
 * @param timeoutMs - Per-check timeout (default {@link CHECK_TIMEOUT_MS}). A caller that joins
 *   a run in flight gets that run, with the timeout it was started with.
 * @returns The checks, in a stable order, with the API's version, tier, clock and `PUBLIC_URL`.
 */
export function diagnostics(
  deps: DiagnosticsDeps,
  timeoutMs: number = CHECK_TIMEOUT_MS
): Promise<InstanceDiagnostics> {
  const key = deps.diagnostics
  const running = flights.get(key)
  if (running) {
    return running
  }
  const flight = run(deps, timeoutMs).finally(() => flights.delete(key))
  flights.set(key, flight)
  return flight
}

/** The run in flight for a deployment, keyed by its diagnostics port. */
const flights = new WeakMap<object, Promise<InstanceDiagnostics>>()

async function run(deps: DiagnosticsDeps, timeoutMs: number): Promise<InstanceDiagnostics> {
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
    attempt('stored_secrets', (signal) => scanStored(deps, signal), timeoutMs),
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
      webhookWorkerCheck(config, stored),
      smsSenderCheck(deps, stored),
    ],
  }
}
