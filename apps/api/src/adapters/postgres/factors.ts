import { backupCodes, type Database, type Transaction, userFactors, withTenant } from '@tula/db'
import { and, count, eq, gt, inArray, isNotNull, isNull, lt, lte, or } from 'drizzle-orm'
import { recordActivity } from '~/adapters/postgres/activity'
import type { Activity } from '~/ports/activity-log'
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
    return withTenant(this.db, factor.environmentId, async (tx) => {
      // The user started again: the earlier pending enrolment goes. A confirmed factor does not
      // match, stays, and makes the insert below conflict.
      await tx
        .delete(userFactors)
        .where(and(ofUser(factor.environmentId, factor.userId), isNull(userFactors.confirmedAt)))
      const rows = await tx
        .insert(userFactors)
        .values({ ...factor, updatedAt: factor.createdAt })
        .onConflictDoNothing({ target: [userFactors.userId, userFactors.type] })
        .returning({ id: userFactors.id })
      return rows.length === 1
    })
  }

  /** @inheritdoc */
  async confirmTotp(
    environmentId: string,
    id: string,
    confirmation: FactorConfirmation
  ): Promise<boolean> {
    const { at } = confirmation
    return withTenant(this.db, environmentId, async (tx) => {
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
      await recordActivity(tx, confirmation.activity ? [confirmation.activity] : [])
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
    activity?: Activity
  ): Promise<boolean> {
    return withTenant(this.db, environmentId, async (tx) => {
      const rows = await tx
        .delete(userFactors)
        .where(ofUser(environmentId, userId))
        .returning({ confirmedAt: userFactors.confirmedAt })
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
    activity?: Activity
  ): Promise<boolean> {
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
    activity?: Activity
  ): Promise<number | null> {
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
