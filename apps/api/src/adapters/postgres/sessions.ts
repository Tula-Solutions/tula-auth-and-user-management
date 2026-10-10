import { type Database, refreshTokens, sessions, users, withTenant } from '@tula/db'
import { and, count, desc, eq, gt, inArray, isNull, lt, lte, max, ne, or, sql } from 'drizzle-orm'
import { recordActivity } from '~/adapters/postgres/activity'
import { isUniqueViolation, LostRace } from '~/adapters/postgres/errors'
import { type Activity, activityOf, type Recorded, recordedOf } from '~/ports/activity-log'
import {
  type Authentication,
  mergeAuthMethods,
  type NewRefreshToken,
  type NewSession,
  type RefreshTokenRecord,
  type RevokeByUserOptions,
  type Rotation,
  type SessionCreation,
  type SessionDevice,
  type SessionLimit,
  type SessionRecord,
  type SessionRevokeReason,
  type SessionStore,
  sameMethods,
} from '~/ports/session-store'

const sessionColumns = {
  id: sessions.id,
  projectId: sessions.projectId,
  environmentId: sessions.environmentId,
  userId: sessions.userId,
  profile: sessions.profile,
  type: sessions.type,
  client: sessions.client,
  userAgent: sessions.userAgent,
  ipAddress: sessions.ipAddress,
  lastActiveAt: sessions.lastActiveAt,
  idleExpiresAt: sessions.idleExpiresAt,
  absoluteExpiresAt: sessions.absoluteExpiresAt,
  factorVerifiedAt: sessions.factorVerifiedAt,
  authMethods: sessions.authMethods,
  hookClaims: sessions.hookClaims,
  deviceThumbprint: sessions.deviceThumbprint,
  revokedAt: sessions.revokedAt,
  revokeReason: sessions.revokeReason,
  createdAt: sessions.createdAt,
}

const tokenColumns = {
  id: refreshTokens.id,
  sessionId: refreshTokens.sessionId,
  tokenHash: refreshTokens.tokenHash,
  parentId: refreshTokens.parentId,
  replacedById: refreshTokens.replacedById,
  usedAt: refreshTokens.usedAt,
  expiresAt: refreshTokens.expiresAt,
  createdAt: refreshTokens.createdAt,
}

function tokenValues(
  session: Pick<SessionRecord, 'projectId' | 'environmentId'>,
  token: NewRefreshToken
) {
  return {
    ...token,
    projectId: session.projectId,
    environmentId: session.environmentId,
    updatedAt: token.createdAt,
  }
}

/**
 * Sessions and refresh tokens in Postgres, inside the environment's RLS scope.
 *
 * RLS already hides other environments' rows; the explicit `environment_id` filters are defence
 * in depth and keep the queries on their indexes.
 */
export class PostgresSessionStore implements SessionStore {
  /** @param db - Database connected as the runtime role. */
  constructor(private readonly db: Database) {}

  /** @inheritdoc */
  async create(
    session: NewSession,
    token: NewRefreshToken,
    recorded: Recorded,
    limit?: SessionLimit
  ): Promise<SessionCreation> {
    const activity = activityOf(recorded)
    const { environmentId, userId } = session
    try {
      return await withTenant(this.db, environmentId, async (tx) => {
        let ended: string[] = []
        if (limit) {
          // The user's row is the lock sign-ins of one user take turns on: the second waits
          // here until the first commits, then counts the session the first one created.
          await tx
            .select({ id: users.id })
            .from(users)
            .where(and(eq(users.id, userId), eq(users.environmentId, environmentId)))
            .for('update')
          if (limit.end.length > 0) {
            const rows = await tx
              .update(sessions)
              .set({ revokedAt: limit.at, revokeReason: 'session_limit', updatedAt: limit.at })
              .where(
                and(
                  inArray(sessions.id, [...limit.end]),
                  eq(sessions.environmentId, environmentId),
                  eq(sessions.userId, userId),
                  isNull(sessions.revokedAt)
                )
              )
              .returning({ id: sessions.id })
            ended = rows.map((row) => row.id)
          }
          const [live] = await tx
            .select({ count: count() })
            .from(sessions)
            .where(
              and(
                eq(sessions.environmentId, environmentId),
                eq(sessions.userId, userId),
                isNull(sessions.revokedAt),
                gt(sessions.idleExpiresAt, limit.at),
                or(isNull(sessions.absoluteExpiresAt), gt(sessions.absoluteExpiresAt, limit.at))
              )
            )
          if ((live?.count ?? 0) >= limit.max) {
            // Rolls the endings back too: nothing changes unless the session is created.
            throw new LostRace()
          }
          await recordActivity(tx, recordedOf(ended.map(limit.activity)))
        }
        await tx.insert(sessions).values({ ...session, updatedAt: session.createdAt })
        await tx.insert(refreshTokens).values(tokenValues(session, token))
        await recordActivity(tx, activity ? [activity] : [])
        return { created: true, ended }
      })
    } catch (error) {
      if (error instanceof LostRace) {
        return { created: false }
      }
      throw error
    }
  }

  /** @inheritdoc */
  async reportRefusedProof(environmentId: string, id: string, activity: Activity): Promise<void> {
    await withTenant(this.db, environmentId, async (tx) => {
      const [row] = await tx
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(eq(sessions.id, id), eq(sessions.environmentId, environmentId)))
        .limit(1)
      if (row) {
        await recordActivity(tx, [activity])
      }
    })
  }

  /** @inheritdoc */
  async touch(environmentId: string, id: string, at: Date, idleExpiresAt: Date): Promise<boolean> {
    const rows = await withTenant(this.db, environmentId, (tx) =>
      tx
        .update(sessions)
        .set({ lastActiveAt: at, idleExpiresAt, updatedAt: at })
        .where(
          and(
            eq(sessions.id, id),
            eq(sessions.environmentId, environmentId),
            isNull(sessions.revokedAt),
            gt(sessions.idleExpiresAt, at),
            or(isNull(sessions.absoluteExpiresAt), gt(sessions.absoluteExpiresAt, at))
          )
        )
        .returning({ id: sessions.id })
    )
    return rows.length === 1
  }

  /** @inheritdoc */
  async findById(environmentId: string, id: string): Promise<SessionRecord | null> {
    const [row] = await withTenant(this.db, environmentId, (tx) =>
      tx
        .select(sessionColumns)
        .from(sessions)
        .where(and(eq(sessions.id, id), eq(sessions.environmentId, environmentId)))
        .limit(1)
    )
    return row ?? null
  }

  /** @inheritdoc */
  async findToken(
    environmentId: string,
    tokenHash: string
  ): Promise<{ token: RefreshTokenRecord; session: SessionRecord } | null> {
    const [row] = await withTenant(this.db, environmentId, (tx) =>
      tx
        .select({ token: tokenColumns, session: sessionColumns })
        .from(refreshTokens)
        .innerJoin(
          sessions,
          and(
            eq(sessions.id, refreshTokens.sessionId),
            eq(sessions.environmentId, refreshTokens.environmentId)
          )
        )
        .where(
          and(
            eq(refreshTokens.tokenHash, tokenHash),
            eq(refreshTokens.environmentId, environmentId)
          )
        )
        .limit(1)
    )
    return row ?? null
  }

  /** @inheritdoc */
  async findTokenById(environmentId: string, id: string): Promise<RefreshTokenRecord | null> {
    const [row] = await withTenant(this.db, environmentId, (tx) =>
      tx
        .select(tokenColumns)
        .from(refreshTokens)
        .where(and(eq(refreshTokens.id, id), eq(refreshTokens.environmentId, environmentId)))
        .limit(1)
    )
    return row ?? null
  }

  /** @inheritdoc */
  async rotate(environmentId: string, rotation: Rotation): Promise<boolean> {
    const { child, parentId, at, idleExpiresAt } = rotation
    try {
      await withTenant(this.db, environmentId, async (tx) => {
        // Updating the session first takes its row lock, which serializes concurrent rotations
        // of the same session: the loser then fails the used-parent guard (or the unique child
        // hash) and rolls back.
        const [session] = await tx
          .update(sessions)
          .set({ lastActiveAt: at, idleExpiresAt, updatedAt: at })
          .where(
            and(
              eq(sessions.id, child.sessionId),
              eq(sessions.environmentId, environmentId),
              isNull(sessions.revokedAt)
            )
          )
          .returning({ projectId: sessions.projectId, environmentId: sessions.environmentId })
        if (!session) {
          throw new LostRace()
        }
        await tx.insert(refreshTokens).values(tokenValues(session, child))
        const used = await tx
          .update(refreshTokens)
          .set({ usedAt: at, replacedById: child.id, updatedAt: at })
          .where(
            and(
              eq(refreshTokens.id, parentId),
              eq(refreshTokens.sessionId, child.sessionId),
              eq(refreshTokens.environmentId, environmentId),
              isNull(refreshTokens.usedAt)
            )
          )
          .returning({ id: refreshTokens.id })
        if (used.length !== 1) {
          throw new LostRace()
        }
      })
      return true
    } catch (error) {
      if (error instanceof LostRace || isUniqueViolation(error)) {
        return false
      }
      throw error
    }
  }

  /** @inheritdoc */
  async listActiveByUser(
    environmentId: string,
    userId: string,
    now: Date
  ): Promise<SessionRecord[]> {
    return withTenant(this.db, environmentId, (tx) =>
      tx
        .select(sessionColumns)
        .from(sessions)
        .where(
          and(
            eq(sessions.environmentId, environmentId),
            eq(sessions.userId, userId),
            isNull(sessions.revokedAt),
            gt(sessions.idleExpiresAt, now),
            or(isNull(sessions.absoluteExpiresAt), gt(sessions.absoluteExpiresAt, now))
          )
        )
        .orderBy(desc(sessions.lastActiveAt), desc(sessions.id))
    )
  }

  /** @inheritdoc */
  async listDevicesBefore(
    environmentId: string,
    userId: string,
    session: Pick<SessionRecord, 'id' | 'createdAt'>,
    limit: number
  ): Promise<SessionDevice[]> {
    return withTenant(this.db, environmentId, (tx) =>
      tx
        .select({ client: sessions.client, userAgent: sessions.userAgent })
        .from(sessions)
        .where(
          and(
            eq(sessions.environmentId, environmentId),
            eq(sessions.userId, userId),
            // The same order as `beganBefore` in the port: creation time, then id.
            or(
              lt(sessions.createdAt, session.createdAt),
              and(eq(sessions.createdAt, session.createdAt), lt(sessions.id, session.id))
            )
          )
        )
        .groupBy(sessions.client, sessions.userAgent)
        // Postgres before 18 has no max(uuid); as text a uuid sorts the same way.
        .orderBy(desc(max(sessions.createdAt)), desc(sql`max(${sessions.id}::text)`))
        .limit(limit)
    )
  }

  /** @inheritdoc */
  async revoke(
    environmentId: string,
    id: string,
    reason: SessionRevokeReason,
    at: Date,
    recorded: Recorded
  ): Promise<boolean> {
    const activity = activityOf(recorded)
    return withTenant(this.db, environmentId, async (tx) => {
      const rows = await tx
        .update(sessions)
        .set({ revokedAt: at, revokeReason: reason, updatedAt: at })
        .where(
          and(
            eq(sessions.id, id),
            eq(sessions.environmentId, environmentId),
            isNull(sessions.revokedAt)
          )
        )
        .returning({ id: sessions.id })
      const revoked = rows.length === 1
      await recordActivity(tx, revoked && activity ? [activity] : [])
      return revoked
    })
  }

  /** @inheritdoc */
  async recordAuthentication(
    environmentId: string,
    id: string,
    authentication: Authentication,
    recorded: Recorded
  ): Promise<SessionRecord | null> {
    const activity = activityOf(recorded)
    const { at } = authentication
    return withTenant(this.db, environmentId, async (tx) => {
      // Locked, so two step-ups of one session merge their methods instead of one overwriting
      // the other's.
      const [current] = await tx
        .select({ authMethods: sessions.authMethods })
        .from(sessions)
        .where(
          and(
            eq(sessions.id, id),
            eq(sessions.environmentId, environmentId),
            isNull(sessions.revokedAt),
            gt(sessions.idleExpiresAt, at),
            or(isNull(sessions.absoluteExpiresAt), gt(sessions.absoluteExpiresAt, at))
          )
        )
        .for('update')
      if (!current) {
        return null
      }
      const { claims, ifAuthMethods } = authentication.hookClaims
      // Judged on the locked row: the claims were answered for exactly these methods, and a
      // step-up that got in between must not be given them.
      if (ifAuthMethods && !sameMethods(current.authMethods, ifAuthMethods)) {
        return null
      }
      const [updated] = await tx
        .update(sessions)
        .set({
          factorVerifiedAt: at,
          authMethods: mergeAuthMethods(current.authMethods, authentication.methods),
          hookClaims: claims,
          updatedAt: at,
        })
        .where(and(eq(sessions.id, id), eq(sessions.environmentId, environmentId)))
        .returning(sessionColumns)
      await recordActivity(tx, updated && activity ? [activity] : [])
      return updated ?? null
    })
  }

  /** @inheritdoc */
  async revokeByUser(
    environmentId: string,
    userId: string,
    reason: SessionRevokeReason,
    at: Date,
    options: RevokeByUserOptions
  ): Promise<string[]> {
    const { exceptSessionId, activity } = options
    return withTenant(this.db, environmentId, async (tx) => {
      const rows = await tx
        .update(sessions)
        .set({ revokedAt: at, revokeReason: reason, updatedAt: at })
        .where(
          and(
            eq(sessions.environmentId, environmentId),
            eq(sessions.userId, userId),
            isNull(sessions.revokedAt),
            exceptSessionId ? ne(sessions.id, exceptSessionId) : undefined
          )
        )
        .returning({ id: sessions.id })
      const ids = rows.map((row) => row.id)
      await recordActivity(tx, recordedOf(ids.map(activity)))
      return ids
    })
  }

  /** @inheritdoc */
  async deleteEnded(environmentId: string, before: Date, limit: number): Promise<number> {
    const rows = await withTenant(this.db, environmentId, (tx) =>
      tx
        .delete(sessions)
        .where(
          and(
            eq(sessions.environmentId, environmentId),
            // DELETE has no LIMIT in Postgres: pick the batch in a subquery. The refresh tokens
            // go by the foreign-key cascade, the only way a chain can be removed (its links
            // reference each other).
            inArray(
              sessions.id,
              tx
                .select({ id: sessions.id })
                .from(sessions)
                .where(
                  and(
                    eq(sessions.environmentId, environmentId),
                    // The same three conditions as `endedBy` in the port.
                    or(
                      lte(sessions.revokedAt, before),
                      lte(sessions.idleExpiresAt, before),
                      lte(sessions.absoluteExpiresAt, before)
                    )
                  )
                )
                .limit(limit)
            )
          )
        )
        .returning({ id: sessions.id })
    )
    return rows.length
  }
}
