import { type Database, nativeApps, withTenant } from '@tula/db'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { recordActivity } from '~/adapters/postgres/activity'
import { isUniqueViolation } from '~/adapters/postgres/errors'
import { activityOf, type Recorded } from '~/ports/activity-log'
import type {
  NativeAppChanges,
  NativeAppExpectation,
  NativeAppRecord,
  NativeAppStore,
} from '~/ports/native-app-store'

const columns = {
  id: nativeApps.id,
  projectId: nativeApps.projectId,
  environmentId: nativeApps.environmentId,
  platform: nativeApps.platform,
  identifier: nativeApps.identifier,
  teamId: nativeApps.teamId,
  sha256CertFingerprints: nativeApps.sha256CertFingerprints,
  appLinkPaths: nativeApps.appLinkPaths,
  createdAt: nativeApps.createdAt,
  updatedAt: nativeApps.updatedAt,
}

/** The app of one environment whose team, fingerprints and link paths are still what the caller read. */
function stillExpected(environmentId: string, id: string, expected: NativeAppExpectation) {
  return and(
    eq(nativeApps.environmentId, environmentId),
    eq(nativeApps.id, id),
    // The compare of the compare-and-set: in the statement itself, so it is judged against
    // the row as it is when the write takes its lock.
    expected.teamId === null ? isNull(nativeApps.teamId) : eq(nativeApps.teamId, expected.teamId),
    // Array equality is by position: the fingerprints and the paths are stored sorted.
    eq(nativeApps.sha256CertFingerprints, [...expected.sha256CertFingerprints]),
    eq(nativeApps.appLinkPaths, [...expected.appLinkPaths])
  )
}

/** Native apps in Postgres, behind row-level security. */
export class PostgresNativeAppStore implements NativeAppStore {
  /** @param db - Database connected as the runtime role. */
  constructor(private readonly db: Database) {}

  /** @inheritdoc */
  async list(environmentId: string): Promise<NativeAppRecord[]> {
    return withTenant(this.db, environmentId, (tx) =>
      tx
        .select(columns)
        .from(nativeApps)
        .where(eq(nativeApps.environmentId, environmentId))
        // The id breaks ties between apps of the same instant, so the order is stable.
        .orderBy(asc(nativeApps.createdAt), asc(nativeApps.id))
    )
  }

  /** @inheritdoc */
  async find(environmentId: string, id: string): Promise<NativeAppRecord | null> {
    const [row] = await withTenant(this.db, environmentId, (tx) =>
      tx
        .select(columns)
        .from(nativeApps)
        .where(and(eq(nativeApps.environmentId, environmentId), eq(nativeApps.id, id)))
        .limit(1)
    )
    return row ?? null
  }

  /** @inheritdoc */
  async insert(record: NativeAppRecord, recorded: Recorded): Promise<NativeAppRecord | null> {
    const activity = activityOf(recorded)
    try {
      return await withTenant(this.db, record.environmentId, async (tx) => {
        const [row] = await tx.insert(nativeApps).values(record).returning(columns)
        await recordActivity(tx, activity ? [activity] : [])
        // An insert that did not throw returns its row.
        return row as NativeAppRecord
      })
    } catch (error) {
      // The environment already has that app (or this very id): the unique key decided, and
      // the transaction, with its audit entry, is rolled back.
      if (isUniqueViolation(error)) {
        return null
      }
      throw error
    }
  }

  /** @inheritdoc */
  async update(
    environmentId: string,
    id: string,
    expected: NativeAppExpectation,
    changes: NativeAppChanges,
    updatedAt: Date,
    recorded: Recorded
  ): Promise<NativeAppRecord | null> {
    const activity = activityOf(recorded)
    return withTenant(this.db, environmentId, async (tx) => {
      const [row] = await tx
        .update(nativeApps)
        .set({
          // A field left out is `undefined`, which Drizzle leaves out of the statement.
          teamId: changes.teamId,
          sha256CertFingerprints: changes.sha256CertFingerprints,
          appLinkPaths: changes.appLinkPaths,
          updatedAt,
        })
        .where(stillExpected(environmentId, id, expected))
        .returning(columns)
      await recordActivity(tx, row && activity ? [activity] : [])
      return row ?? null
    })
  }

  /** @inheritdoc */
  async delete(environmentId: string, id: string, recorded: Recorded): Promise<boolean> {
    const activity = activityOf(recorded)
    return withTenant(this.db, environmentId, async (tx) => {
      const rows = await tx
        .delete(nativeApps)
        .where(and(eq(nativeApps.environmentId, environmentId), eq(nativeApps.id, id)))
        .returning({ id: nativeApps.id })
      const deleted = rows.length === 1
      await recordActivity(tx, deleted && activity ? [activity] : [])
      return deleted
    })
  }
}
