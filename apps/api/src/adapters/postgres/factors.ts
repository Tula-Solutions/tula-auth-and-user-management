import {
  backupCodes,
  type Database,
  type Transaction,
  userFactors,
  users,
  withTenant,
} from '@tula/db'
import { and, count, eq, gt, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm'
import { recordActivity } from '~/adapters/postgres/activity'
import { activityOf, type Recorded, recordedOf } from '~/ports/activity-log'
import type {
  FactorConfirmation,
  FactorRecord,
  FactorStore,
  NewBackupCode,
  NewFactor,
} from '~/ports/factor-store'

const columns = {
  id: userFactors.id,
  projectId: userFactors.projectId,
  environmentId: userFactors.environmentId,
  userId: userFactors.userId,
  type: userFactors.type,
  secret: userFactors.secret,
  confirmedAt: userFactors.confirmedAt,
  expiresAt: userFactors.expiresAt,
  lastUsedStep: userFactors.lastUsedStep,
  createdAt: userFactors.createdAt,
}

function ofUser(environmentId: string, userId: string) {
  return and(
    eq(userFactors.environmentId, environmentId),
    eq(userFactors.userId, userId),
    eq(userFactors.type, 'totp')
  )
}

function codesOfUser(environmentId: string, userId: string) {
  return and(eq(backupCodes.environmentId, environmentId), eq(backupCodes.userId, userId))
}

/** Replace every backup code of a user inside the caller's transaction. */
async function setCodes(
  tx: Transaction,
  scope: { projectId: string; environmentId: string },
  userId: string,
  codes: readonly NewBackupCode[],
  at: Date
): Promise<void> {
  await tx.delete(backupCodes).where(codesOfUser(scope.environmentId, userId))
  if (codes.length > 0) {
    await tx.insert(backupCodes).values(
      codes.map((code) => ({
        ...code,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        userId,
        createdAt: at,
        updatedAt: at,
      }))
    )
  }
}

/**
 * Second factors in `tula.user_factors` and backup codes in `tula.backup_codes`, inside the
 * environment's RLS scope.
 *
 * RLS already hides other environments' rows; the explicit `environment_id` filters are defence
 * in depth and keep the queries on their indexes. Every guard is part of the `UPDATE` or
 * `DELETE` it protects, so the row lock is what serializes concurrent requests.
 */
export class PostgresFactorStore implements FactorStore {
  /** @param db - Database connected as the runtime role. */
  constructor(private readonly db: Database) {}

  /** @inheritdoc */
  async findTotp(environmentId: string, userId: string): Promise<FactorRecord | null> {
    const [row] = await withTenant(this.db, environmentId, (tx) =>
      tx.select(columns).from(userFactors).where(ofUser(environmentId, userId)).limit(1)
    )
    return row ?? null
  }

  /** @inheritdoc */
  async startTotp(factor: NewFactor): Promise<boolean> {
    // One statement, so two concurrent starts cannot trip over each other: the second waits
    // for the first's row and then replaces it (the user started again), instead of failing on
    // the unique key and being told a factor is already on. Only a **confirmed** row is left
    // alone, and only then does nothing come back.
    const rows = await withTenant(this.db, factor.environmentId, (tx) =>
      tx
        .insert(userFactors)
        .values({ ...factor, updatedAt: factor.createdAt })
        .onConflictDoUpdate({
          target: [userFactors.userId, userFactors.type],
          set: {
            id: sql`excluded.id`,
            secret: sql`excluded.secret`,
            expiresAt: sql`excluded.expires_at`,
            lastUsedStep: null,
            createdAt: sql`excluded.created_at`,
            updatedAt: sql`excluded.updated_at`,
          },
          setWhere: isNull(userFactors.confirmedAt),
        })
        .returning({ id: userFactors.id })
    )
    return rows.length === 1
  }

  /** @inheritdoc */
  async confirmTotp(
    environmentId: string,
    id: string,
    confirmation: FactorConfirmation
  ): Promise<boolean> {
    const { at } = confirmation
    return withTenant(this.db, environmentId, async (tx) => {
      // The owner's row is held first, as `users.enableSmsFactor` holds it: a texted second
      // factor is turned on only for a user with no confirmed authenticator, and that write
      // reads this table under the same lock. With it, a confirmation runs wholly before
      // that write (which then refuses) or wholly after it (and the texted code is dormant
      // from then on): never in between. `FOR NO KEY UPDATE`, so that the backup codes'
      // foreign key (a `FOR KEY SHARE` on this row) is not waited for by itself.
      const [pending] = await tx
        .select({ userId: userFactors.userId })
        .from(userFactors)
        .where(and(eq(userFactors.id, id), eq(userFactors.environmentId, environmentId)))
        .limit(1)
      if (!pending) {
        return false
      }
      await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, pending.userId), eq(users.environmentId, environmentId)))
        .for('no key update')
      const [confirmed] = await tx
        .update(userFactors)
        .set({ confirmedAt: at, expiresAt: null, lastUsedStep: confirmation.step, updatedAt: at })
        .where(
          and(
            eq(userFactors.id, id),
            eq(userFactors.environmentId, environmentId),
            isNull(userFactors.confirmedAt),
            gt(userFactors.expiresAt, at)
          )
        )
        .returning({ userId: userFactors.userId, projectId: userFactors.projectId })
      if (!confirmed) {
        return false
      }
      await setCodes(
        tx,
        { projectId: confirmed.projectId, environmentId },
        confirmed.userId,
        confirmation.backupCodes,
        at
      )
      await recordActivity(tx, recordedOf([confirmation.activity]))
      return true
    })
  }

  /** @inheritdoc */
  async useTotpStep(environmentId: string, id: string, step: number, at: Date): Promise<boolean> {
    const rows = await withTenant(this.db, environmentId, (tx) =>
      tx
        .update(userFactors)
        .set({ lastUsedStep: step, updatedAt: at })
        .where(
          and(
            eq(userFactors.id, id),
            eq(userFactors.environmentId, environmentId),
            isNotNull(userFactors.confirmedAt),
            or(isNull(userFactors.lastUsedStep), lt(userFactors.lastUsedStep, step))
          )
        )
        .returning({ id: userFactors.id })
    )
    return rows.length === 1
  }

  /** @inheritdoc */
  async removeForUser(
    environmentId: string,
    userId: string,
    recorded: Recorded,
    onlyFactorId?: string
  ): Promise<boolean> {
    const activity = activityOf(recorded)
    return withTenant(this.db, environmentId, async (tx) => {
      // The id guard is part of the DELETE, so the row cannot change between a check and it.
      const rows = await tx
        .delete(userFactors)
        .where(
          and(
            ofUser(environmentId, userId),
            onlyFactorId === undefined ? undefined : eq(userFactors.id, onlyFactorId)
          )
        )
        .returning({ confirmedAt: userFactors.confirmedAt })
      if (onlyFactorId !== undefined && rows.length === 0) {
        // Not the caller's factor: its backup codes belong to whichever factor is there now.
        return false
      }
      await tx.delete(backupCodes).where(codesOfUser(environmentId, userId))
      const removed = rows.some((row) => row.confirmedAt !== null)
      await recordActivity(tx, removed && activity ? [activity] : [])
      return removed
    })
  }

  /** @inheritdoc */
  async replaceBackupCodes(
    environmentId: string,
    userId: string,
    scope: { projectId: string },
    codes: readonly NewBackupCode[],
    at: Date,
    recorded: Recorded
  ): Promise<boolean> {
    const activity = activityOf(recorded)
    return withTenant(this.db, environmentId, async (tx) => {
      // Locked, so the factor cannot be removed between this check and the insert.
      const [factor] = await tx
        .select({ id: userFactors.id })
        .from(userFactors)
        .where(and(ofUser(environmentId, userId), isNotNull(userFactors.confirmedAt)))
        .for('update')
      if (!factor) {
        return false
      }
      await setCodes(tx, { projectId: scope.projectId, environmentId }, userId, codes, at)
      await recordActivity(tx, activity ? [activity] : [])
      return true
    })
  }

  /** @inheritdoc */
  async consumeBackupCode(
    environmentId: string,
    userId: string,
    codeHash: string,
    at: Date,
    recorded: Recorded
  ): Promise<number | null> {
    const activity = activityOf(recorded)
    return withTenant(this.db, environmentId, async (tx) => {
      const spent = await tx
        .update(backupCodes)
        .set({ usedAt: at, updatedAt: at })
        .where(
          and(
            codesOfUser(environmentId, userId),
            eq(backupCodes.codeHash, codeHash),
            isNull(backupCodes.usedAt)
          )
        )
        .returning({ id: backupCodes.id })
      if (spent.length !== 1) {
        return null
      }
      await recordActivity(tx, activity ? [activity] : [])
      const [remaining] = await tx
        .select({ value: count() })
        .from(backupCodes)
        .where(and(codesOfUser(environmentId, userId), isNull(backupCodes.usedAt)))
      return remaining?.value ?? 0
    })
  }

  /** @inheritdoc */
  async countBackupCodes(environmentId: string, userId: string): Promise<number> {
    const [row] = await withTenant(this.db, environmentId, (tx) =>
      tx
        .select({ value: count() })
        .from(backupCodes)
        .where(and(codesOfUser(environmentId, userId), isNull(backupCodes.usedAt)))
    )
    return row?.value ?? 0
  }

  /** @inheritdoc */
  async deleteExpiredPending(environmentId: string, before: Date, limit: number): Promise<number> {
    const pending = and(
      eq(userFactors.environmentId, environmentId),
      isNull(userFactors.confirmedAt),
      lte(userFactors.expiresAt, before)
    )
    const rows = await withTenant(this.db, environmentId, (tx) =>
      tx
        .delete(userFactors)
        .where(
          and(
            pending,
            // DELETE has no LIMIT in Postgres: pick the batch in a subquery.
            inArray(
              userFactors.id,
              tx.select({ id: userFactors.id }).from(userFactors).where(pending).limit(limit)
            )
          )
        )
        .returning({ id: userFactors.id })
    )
    return rows.length
  }
}
