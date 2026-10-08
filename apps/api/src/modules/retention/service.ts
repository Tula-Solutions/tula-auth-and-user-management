import { durationToMs } from '@tula/contract'
import type { Deps } from '~/dependencies'
import * as logger from '~/lib/logger'
import { errorReason } from '~/lib/safe-error'

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
 * How often the retention job runs. Expired sign-up attempts hold the hash of a password that
 * was never used, so they should not outlive their expiry by long; the other tables only need
 * a daily pass, and an idle pass costs three indexed queries per environment.
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
 * Delete what no longer has a use, in every environment:
 *
 * - flow attempts past their expiry (with their verification tokens);
 * - verification tokens expired for longer than {@link EXPIRED_VERIFICATION_TOKEN_RETENTION};
 * - sessions that ended more than {@link ENDED_SESSION_RETENTION} ago, with their refresh
 *   tokens;
 * - authenticator enrolments that were never confirmed and lapsed more than
 *   {@link EXPIRED_VERIFICATION_TOKEN_RETENTION} ago (a sealed secret nobody will use).
 *
 * It also deletes instance audit entries (the control plane's log: dashboard sign-ins,
 * workspaces, projects) older than the deployment's `INSTANCE_AUDIT_RETENTION_DAYS`.
 *
 * An environment's audit entries are never deleted here, and neither are outbox events: nothing delivers events
 * yet (Phase 2), so none is safe to drop (ADR 0017).
 *
 * A failure in one environment is logged and skipped, so it cannot keep the environments after
 * it from being purged. Each environment is purged through its own tenant-scoped store calls:
 * one environment's purge cannot touch another's rows.
 *
 * @param deps - Environments, the three stores and the clock.
 * @returns What was deleted. Counts from an environment that failed part-way are included.
 */
export async function purge(deps: RetentionDeps): Promise<RetentionReport> {
  const now = deps.clock.now()
  const tokensBefore = new Date(now.getTime() - durationToMs(EXPIRED_VERIFICATION_TOKEN_RETENTION))
  const sessionsBefore = new Date(now.getTime() - durationToMs(ENDED_SESSION_RETENTION))
  const report: RetentionReport = {
    environments: 0,
    failed: 0,
    flowAttempts: 0,
    verificationTokens: 0,
    sessions: 0,
    pendingFactors: 0,
    passkeyChallenges: 0,
    instanceAuditLogs: 0,
  }
  // The instance audit log belongs to no environment. It is the one audit log with an end:
  // anyone who can reach the sign-in can add to it, so it is kept for a period the
  // deployment sets, not for ever. An environment's audit log is never deleted here.
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
    report.instanceAuditLogs
  // An idle run is routine; one that deleted something, or could not, is worth a line.
  const log = report.failed > 0 ? logger.warn : removed > 0 ? logger.info : logger.debug
  log('retention run finished', { ...report })
  return report
}
