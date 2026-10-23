import { DOMAIN_REMINDER_DAYS, DOMAINS_MANAGE_PERMISSION, durationToMs } from '@tula-tech/contract'
import type { Deps } from '~/dependencies'
import * as logger from '~/lib/logger'
import { errorReason } from '~/lib/safe-error'
import * as Email from '~/modules/email/service'
import * as Settings from '~/modules/settings/service'
import type { DueReminder } from '~/ports/organization-domain-store'

// The reminder that a verified domain is about to lapse (ADR 0065, "Verified domains",
// "Lapse"). A background job, not a request: nothing a user does waits for these emails.

/** How often the job runs. A reminder is sent once per threshold whatever the interval. */
export const DOMAIN_REMINDER_INTERVAL_MS = 24 * 60 * 60_000

/** Verified domains one environment is read for in one run; the rest wait for the next. */
export const REMINDER_BATCH_SIZE = 200

/** Managers one reminder is sent to (the oldest memberships first). */
export const REMINDER_RECIPIENTS_PER_ORGANIZATION = 10

/**
 * Reminders (one per organization and threshold, however many domains it covers) one
 * environment sends in a day. Far above what real use produces; it bounds what the job can
 * cost in mail.
 */
export const REMINDERS_PER_ENVIRONMENT_PER_DAY = 200

/** What one run did. Counts only: nothing here identifies a user or a domain. */
export interface ReminderReport {
  /** Environments visited. */
  environments: number
  /** Domains whose reminder was taken (and sent, or given back). */
  domains: number
  /** Emails handed to the mailer. */
  emails: number
  /** Reminders given back for a retry: nobody could be told, or the mailer refused every send. */
  retried: number
  /** Environments that failed; retried next run. */
  failed: number
}

type RemindDeps = Pick<
  Deps,
  | 'environments'
  | 'organizations'
  | 'organizationDomains'
  | 'users'
  | 'environmentSettings'
  | 'config'
  | 'clock'
  | 'mailer'
  | 'rateLimiter'
>

/** The due rows grouped by organization and threshold. */
function groupsOf(due: DueReminder[]): Map<string, DueReminder[]> {
  const groups = new Map<string, DueReminder[]>()
  for (const one of due) {
    const key = `${one.record.organizationId}:${one.days}`
    groups.set(key, [...(groups.get(key) ?? []), one])
  }
  return groups
}

/**
 * Email the managers of every organization whose verified domains are within a reminder
 * threshold (the contract's `DOMAIN_REMINDER_DAYS`: 30 and 7 days), once per domain and
 * threshold.
 *
 * - **Once.** A domain's reminder is *taken* in the store (a guarded update of
 *   `reminded_days`) before anything is sent, so two instances or a repeated run send it once;
 *   verifying the domain again clears the mark and the series starts over. A reminder that
 *   could not be sent to anyone is given back, so the next run tries again.
 * - **To managers, as stored now:** the members whose role holds `org:sys:domains:manage`
 *   (at most {@link REMINDER_RECIPIENTS_PER_ORGANIZATION}), with an address that is verified,
 *   and not banned. One email covers all the organization's domains at a threshold.
 * - **Nothing to act on in it.** No code and no link, and no domain name (see
 *   `OrganizationDomainExpiringMessage`): the manager opens the organization's domain
 *   settings and asks for a new code there.
 * - **Bounded.** {@link REMINDERS_PER_ENVIRONMENT_PER_DAY} per environment a day (through
 *   the rate limiter, which fails closed), {@link REMINDER_BATCH_SIZE} domains read per
 *   environment per run. A failure in one environment is logged and skipped.
 *
 * A mailer failure never reaches a request: this runs on a timer.
 *
 * @param deps - Stores, settings, mailer, rate limiter and clock.
 * @returns What the run did.
 * @throws When the list of environments cannot be read (the database is down).
 */
export async function remind(deps: RemindDeps): Promise<ReminderReport> {
  const now = deps.clock.now()
  const report: ReminderReport = { environments: 0, domains: 0, emails: 0, retried: 0, failed: 0 }
  for (const { id } of await deps.environments.listAll()) {
    report.environments += 1
    try {
      const { organizations } = await Settings.current(deps, { environmentId: id })
      if (!organizations.enabled) {
        continue
      }
      const due = await deps.organizationDomains.listDueReminders(
        id,
        now,
        DOMAIN_REMINDER_DAYS,
        REMINDER_BATCH_SIZE
      )
      for (const group of groupsOf(due).values()) {
        if ((await remindGroup(deps, id, group, report)) === 'limited') {
          break
        }
      }
    } catch (error) {
      report.failed += 1
      logger.warn('domain reminders failed in one environment', {
        environmentId: id,
        err: errorReason(error),
      })
    }
  }
  return report
}

/** Send one organization's reminder for one threshold. */
async function remindGroup(
  deps: RemindDeps,
  environmentId: string,
  group: DueReminder[],
  report: ReminderReport
): Promise<'done' | 'limited'> {
  const [first] = group
  if (!first) {
    return 'done'
  }
  const { organizationId } = first.record
  const { days } = first
  const taken: { id: string; previous: number | null }[] = []
  for (const { record } of group) {
    const got = await deps.organizationDomains.takeReminder(
      environmentId,
      organizationId,
      record.id,
      days
    )
    if (got) {
      taken.push({ id: record.id, previous: got.previous })
    }
  }
  if (taken.length === 0) {
    return 'done'
  }
  const giveBack = async () => {
    for (const one of taken) {
      await deps.organizationDomains.releaseReminder(
        environmentId,
        organizationId,
        one.id,
        days,
        one.previous
      )
    }
    report.retried += taken.length
  }
  report.domains += taken.length
  try {
    const decision = await deps.rateLimiter.hit(
      `organization_domain_reminders:${environmentId}`,
      REMINDERS_PER_ENVIRONMENT_PER_DAY,
      durationToMs('1d')
    )
    if (!decision.allowed) {
      await giveBack()
      return 'limited'
    }
    const organization = await deps.organizations.find(environmentId, organizationId)
    if (!organization) {
      return 'done'
    }
    const managerIds = await deps.organizations.listMembersWithPermission(
      environmentId,
      organizationId,
      DOMAINS_MANAGE_PERMISSION,
      REMINDER_RECIPIENTS_PER_ORGANIZATION
    )
    let attempted = 0
    let sent = 0
    for (const userId of managerIds) {
      const user = await deps.users.findById(environmentId, userId)
      if (!user?.email || user.emailVerifiedAt === null || user.bannedAt !== null) {
        continue
      }
      attempted += 1
      try {
        await Email.send(deps, { environmentId }, user.email, {
          type: 'organization_domain_expiring',
          organizationName: organization.name,
          domains: taken.length,
          daysLeft: days,
        })
        sent += 1
      } catch (error) {
        // Never the address or the message: only that a send failed.
        logger.warn('a domain reminder could not be sent', {
          environmentId,
          err: errorReason(error),
        })
      }
    }
    report.emails += sent
    if (attempted > 0 && sent === 0) {
      // The mailer refused every send: try again at the next run.
      await giveBack()
    }
  } catch (error) {
    await giveBack()
    throw error
  }
  return 'done'
}

/**
 * Run the reminder job once, unless another instance is running it: the entry the scheduler
 * (`startJobs`) calls.
 *
 * @param deps - What {@link remind} needs, and the job lock.
 * @returns The run's report, or `null` when another instance held the lock.
 * @throws When the lock or the list of environments cannot be read.
 */
export async function run(
  deps: RemindDeps & Pick<Deps, 'jobLock'>
): Promise<ReminderReport | null> {
  const outcome = await deps.jobLock.runExclusive('domain_reminders', () => remind(deps))
  if (!outcome.ran) {
    return null
  }
  const report = outcome.value
  const log = report.failed > 0 ? logger.warn : report.emails > 0 ? logger.info : logger.debug
  log('domain reminder run finished', { ...report })
  return report
}
