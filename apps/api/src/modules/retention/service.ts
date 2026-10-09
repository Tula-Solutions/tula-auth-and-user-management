import { durationToMs } from '@tula/contract'
import type { Deps } from '~/dependencies'
import * as logger from '~/lib/logger'
import { errorReason } from '~/lib/safe-error'
import * as Settings from '~/modules/settings/service'

/**
 * How long a session is kept after it ended (was revoked, or passed its idle or absolute
 * expiry), with its refresh tokens. A month leaves time to investigate a report that mentions
 * a session id, and is far past anything a client could still do with the session: a refresh
 * token is refused the moment its session ends.
 */
export const ENDED_SESSION_RETENTION = '30d'

/**
 * How long a verification token is kept after its expiry. Not zero, so that a request in flight
 * when the token expires still finds it and answers `verification.expired` as usual rather than
 * racing the purge. Every token expires, used or not, so this also removes consumed ones.
 */
export const EXPIRED_VERIFICATION_TOKEN_RETENTION = '1h'

/**
 * How long an outbox event is kept after the webhook worker settled it (every endpoint it was
 * owed to has its delivery, ADR 0034). The event's payload is what "send it again" sends, so
 * this is how long a delivery can be redelivered: a month covers an operator who learns late
 * that their receiver dropped something, and is far past the day and a few hours the worker
 * itself keeps trying. An event with a delivery that is still pending is kept whatever its age.
 */
export const SETTLED_EVENT_RETENTION = '30d'

/**
 * How long the record of a delivery is kept (the row and every request made for it), from the
 * moment it was queued, once it is no longer pending. Longer than the event it is of, on
 * purpose: what happened to last quarter's deliveries can still be read after their payloads
 * are gone. It holds no payload and nothing of a receiver's answer, only ids, times, status
 * codes and durations.
 */
export const ENDED_DELIVERY_RETENTION = '90d'

/**
 * How long the counts of texted codes are kept (`sms_code_counts`, ADR 0037), from the day
 * they are of. A quarter: three times what the admin API reads back (`SMS_USAGE_MAX_DAYS`),
 * so that a month can still be compared with the ones before it by whoever keeps the answers.
 * The rows hold counts by destination prefix and nothing else.
 */
export const SMS_COUNT_RETENTION = '90d'

/**
 * How often the retention job runs. Expired sign-up attempts hold the hash of a password that
 * was never used, so they should not outlive their expiry by long; the other tables only need
 * a daily pass, and an idle pass costs a handful of indexed queries per environment.
 */
export const RETENTION_INTERVAL_MS = 10 * 60_000

/**
 * Rows deleted per statement. Each batch is its own short transaction, so a purge of a large
 * backlog never holds row locks, or one long transaction, for more than a batch.
 */
export const RETENTION_BATCH_SIZE = 500

/**
 * Batches per table, per environment, per run: a ceiling of 100,000 rows. A backlog larger than
 * that is finished by the following runs instead of one run that never ends.
 */
export const RETENTION_MAX_BATCHES = 200

const DAY_MS = 86_400_000

/** How many rows one run deleted, by table. Refresh tokens go with their sessions, uncounted. */
export interface RetentionCounts {
  flowAttempts: number
  verificationTokens: number
  sessions: number
  /** Authenticator enrolments that were started and never confirmed. */
  pendingFactors: number
  /** WebAuthn challenges of signed-in sessions that expired unused. */
  passkeyChallenges: number
  /** Instance audit entries older than the deployment's `INSTANCE_AUDIT_RETENTION_DAYS`. */
  instanceAuditLogs: number
  /** Environments' audit entries older than their own `audit.retentionDays`. */
  auditLogs: number
  /** Webhook deliveries that ended, with their attempts, past {@link ENDED_DELIVERY_RETENTION}. */
  webhookDeliveries: number
  /** Outbox events settled more than {@link SETTLED_EVENT_RETENTION} ago. */
  events: number
  /** Rows of texted-code counts of days more than {@link SMS_COUNT_RETENTION} ago. */
  smsCodeCounts: number
}

/** The outcome of one retention run. Counts only: nothing here identifies a user. */
export interface RetentionReport extends RetentionCounts {
  /** Environments visited. */
  environments: number
  /** Purges that failed (an environment's, or the instance audit log's); retried next run. */
  failed: number
}

type RetentionDeps = Pick<
  Deps,
  | 'environments'
  | 'flowAttempts'
  | 'verificationTokens'
  | 'sessions'
  | 'factors'
  | 'passkeys'
  | 'controlPlane'
  | 'activityLog'
  | 'webhookDeliveries'
  | 'smsUsage'
  | 'environmentSettings'
  | 'config'
  | 'clock'
>

/** Repeat one batched delete until a batch comes back short, or the ceiling is reached. */
async function drain(deleteBatch: (limit: number) => Promise<number>): Promise<number> {
  let removed = 0
  for (let batch = 0; batch < RETENTION_MAX_BATCHES; batch++) {
    const count = await deleteBatch(RETENTION_BATCH_SIZE)
    removed += count
    if (count < RETENTION_BATCH_SIZE) {
      break
    }
  }
  return removed
}

/**
 * The instant before which an environment's audit entries are past its retention period.
 *
 * `null` (the setting's default) means "keep for ever". So does anything that is not a whole
 * number of days, one or more: the admin API stores nothing else, and a document changed by
 * hand must never read as "delete everything" (zero or a negative period would put the cutoff
 * at or after now).
 *
 * @param retentionDays - The environment's `audit.retentionDays`, as stored.
 * @param now - The run's time.
 * @returns The cutoff, or `null` when nothing is to be deleted.
 */
function auditCutoff(retentionDays: unknown, now: Date): Date | null {
  if (typeof retentionDays !== 'number' || !Number.isInteger(retentionDays) || retentionDays < 1) {
    return null
  }
  return new Date(now.getTime() - retentionDays * DAY_MS)
}

/**
 * Delete one environment's audit entries that are older than its `audit.retentionDays`.
 *
 * The period is read from the source, past this instance's settings cache: every other setting
 * may trail a change by a few seconds, but acting on a period that was lengthened a moment ago
 * on another instance would delete what the operator has just asked to keep.
 *
 * The deletes are not audit entries themselves (ADR 0012): an entry cannot record its own end,
 * and one entry per run would grow the log the period is there to bound. What is on record is
 * the change of the setting (`environment.settings_updated`, with `audit.retentionDays` among
 * its changed keys) and a line in the server's log each time entries go.
 *
 * @param deps - The settings store, config, the audit log.
 * @param environmentId - The environment.
 * @param now - The run's time.
 * @returns How many entries were deleted: 0 when the environment keeps its entries for ever.
 */
async function purgeAudit(
  deps: Pick<RetentionDeps, 'environmentSettings' | 'config' | 'activityLog'>,
  environmentId: string,
  now: Date
): Promise<number> {
  const { settings } = await Settings.get(deps, { environmentId }, true)
  const retentionDays: unknown = settings.audit?.retentionDays
  const before = auditCutoff(retentionDays, now)
  if (!before) {
    return 0
  }
  const deleted = await drain((limit) =>
    deps.activityLog.deleteAuditBefore(environmentId, before, limit)
  )
  if (deleted > 0) {
    logger.info('audit entries past the retention period deleted', {
      environmentId,
      retentionDays,
      deleted,
    })
  }
  return deleted
}

/**
 * Delete what no longer has a use, in every environment:
 *
 * - flow attempts past their expiry (with their verification tokens);
 * - verification tokens expired for longer than {@link EXPIRED_VERIFICATION_TOKEN_RETENTION};
 * - sessions that ended more than {@link ENDED_SESSION_RETENTION} ago, with their refresh
 *   tokens;
 * - authenticator enrolments that were never confirmed and lapsed more than
 *   {@link EXPIRED_VERIFICATION_TOKEN_RETENTION} ago (a sealed secret nobody will use);
 * - audit entries older than the environment's own `audit.retentionDays`, where it has set one
 *   (the default, `null`, keeps them for ever);
 * - webhook deliveries that have ended (delivered or given up) and were queued more than
 *   {@link ENDED_DELIVERY_RETENTION} ago, with every request recorded for them;
 * - outbox events the webhook worker settled more than {@link SETTLED_EVENT_RETENTION} ago,
 *   except one that a delivery still pending is of;
 * - counts of texted codes (by destination prefix and day) of days more than
 *   {@link SMS_COUNT_RETENTION} ago.
 *
 * It also deletes instance audit entries (the control plane's log: dashboard sign-ins,
 * workspaces, projects) older than the deployment's `INSTANCE_AUDIT_RETENTION_DAYS`.
 *
 * An outbox event that no worker has settled is never deleted, and nor is a delivery that is
 * still pending: the database refuses both whatever this job asks (the restrictive policies of
 * migration 0019), as it refuses an event of the last day and a delivery of the last week.
 * Deleting an event does not delete the audit entry of the same id, nor the other way round:
 * each has its own period.
 *
 * A failure in one environment is logged and skipped, so it cannot keep the environments after
 * it from being purged. Each environment is purged through its own tenant-scoped store calls:
 * one environment's purge cannot touch another's rows.
 *
 * @param deps - Environments, the stores, the settings store and the clock.
 * @returns What was deleted. Counts from an environment that failed part-way are included.
 */
export async function purge(deps: RetentionDeps): Promise<RetentionReport> {
  const now = deps.clock.now()
  const tokensBefore = new Date(now.getTime() - durationToMs(EXPIRED_VERIFICATION_TOKEN_RETENTION))
  const sessionsBefore = new Date(now.getTime() - durationToMs(ENDED_SESSION_RETENTION))
  const deliveriesBefore = new Date(now.getTime() - durationToMs(ENDED_DELIVERY_RETENTION))
  const eventsBefore = new Date(now.getTime() - durationToMs(SETTLED_EVENT_RETENTION))
  // A day (UTC), as the counts are kept: the first one that stays.
  const smsCountsBefore = new Date(now.getTime() - durationToMs(SMS_COUNT_RETENTION))
    .toISOString()
    .slice(0, 10)
  const report: RetentionReport = {
    environments: 0,
    failed: 0,
    flowAttempts: 0,
    verificationTokens: 0,
    sessions: 0,
    pendingFactors: 0,
    passkeyChallenges: 0,
    instanceAuditLogs: 0,
    auditLogs: 0,
    webhookDeliveries: 0,
    events: 0,
    smsCodeCounts: 0,
  }
  // The instance audit log belongs to no environment, and its period is the deployment's:
  // anyone who can reach the sign-in can add to it, so it always has an end. An environment's
  // audit log ends only where the environment has set a period (below).
  try {
    const auditBefore = new Date(now.getTime() - deps.config.instanceAuditRetentionDays * DAY_MS)
    report.instanceAuditLogs = await drain((limit) =>
      deps.controlPlane.deleteAuditBefore(auditBefore, limit)
    )
  } catch (error) {
    report.failed += 1
    logger.warn('retention failed for the instance audit log', { err: errorReason(error) })
  }
  for (const { id } of await deps.environments.listAll()) {
    report.environments += 1
    try {
      report.flowAttempts += await drain((limit) => deps.flowAttempts.deleteExpired(id, now, limit))
      report.verificationTokens += await drain((limit) =>
        deps.verificationTokens.deleteExpired(id, tokensBefore, limit)
      )
      report.sessions += await drain((limit) =>
        deps.sessions.deleteEnded(id, sessionsBefore, limit)
      )
      // The same grace as tokens: a confirmation in flight when the enrolment lapses still
      // finds the row and answers `mfa.enrolment_expired` rather than racing the purge.
      report.pendingFactors += await drain((limit) =>
        deps.factors.deleteExpiredPending(id, tokensBefore, limit)
      )
      // A WebAuthn challenge is dead the moment it expires: nothing reads one afterwards.
      report.passkeyChallenges += await drain((limit) =>
        deps.passkeys.deleteExpiredChallenges(id, now, limit)
      )
      // Last, and the only step whose rows did not end by themselves: the environment chose
      // how long its audit entries are kept. One that cannot be read, or purged, keeps them.
      report.auditLogs += await purgeAudit(deps, id, now)
      // The webhook worker's leavings. The delivery log first, then the events: neither
      // depends on the other (a delivery keeps its event's id and type, not a reference).
      report.webhookDeliveries += await drain((limit) =>
        deps.webhookDeliveries.deleteEndedBefore(id, deliveriesBefore, limit)
      )
      report.events += await drain((limit) =>
        deps.webhookDeliveries.deleteSettledEvents(id, eventsBefore, limit)
      )
      report.smsCodeCounts += await drain((limit) =>
        deps.smsUsage.deleteBefore(id, smsCountsBefore, limit)
      )
    } catch (error) {
      report.failed += 1
      logger.warn('retention failed in one environment', {
        environmentId: id,
        err: errorReason(error),
      })
    }
  }
  return report
}

/**
 * Run the retention job, unless another API instance is running it.
 *
 * Called on boot and every {@link RETENTION_INTERVAL_MS} by `server.ts`, on every instance; the
 * job lock lets one of them through. Logs one line per run, with counts only.
 *
 * @param deps - Everything {@link purge} needs, plus the job lock.
 * @returns The run's report, or `null` when another instance held the lock (nothing is logged).
 * @throws When the lock or the list of environments cannot be read (the database is down).
 */
export async function run(
  deps: RetentionDeps & Pick<Deps, 'jobLock'>
): Promise<RetentionReport | null> {
  const outcome = await deps.jobLock.runExclusive('retention', () => purge(deps))
  if (!outcome.ran) {
    return null
  }
  const report = outcome.value
  const removed =
    report.flowAttempts +
    report.verificationTokens +
    report.sessions +
    report.pendingFactors +
    report.passkeyChallenges +
    report.instanceAuditLogs +
    report.auditLogs +
    report.webhookDeliveries +
    report.events +
    report.smsCodeCounts
  // An idle run is routine; one that deleted something, or could not, is worth a line.
  const log = report.failed > 0 ? logger.warn : removed > 0 ? logger.info : logger.debug
  log('retention run finished', { ...report })
  return report
}
