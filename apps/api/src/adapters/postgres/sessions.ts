import { type Database, refreshTokens, sessions, withTenant } from '@tula/db'
import { and, desc, eq, gt, isNull, ne, or } from 'drizzle-orm'
import { recordActivity } from '~/adapters/postgres/activity'
import { isUniqueViolation, LostRace } from '~/adapters/postgres/errors'
import type { Activity } from '~/ports/activity-log'
import type {
  NewRefreshToken,
  NewSession,
  RefreshTokenRecord,
  RevokeByUserOptions,
  Rotation,
  SessionRecord,
  SessionRevokeReason,
  SessionStore,
} from '~/ports/session-store'

const sessionColumns = {
  id: sessions.id,
  projectId: sessions.projectId,
  environmentId: sessions.environmentId,
  userId: sessions.userId,
  profile: sessions.profile,
  client: sessions.client,
  userAgent: sessions.userAgent,
  ipAddress: sessions.ipAddress,
  lastActiveAt: sessions.lastActiveAt,
  idleExpiresAt: sessions.idleExpiresAt,
  absoluteExpiresAt: sessions.absoluteExpiresAt,
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
  async create(session: NewSession, token: NewRefreshToken, activity?: Activity): Promise<void> {
    await withTenant(this.db, session.environmentId, async (tx) => {
      await tx.insert(sessions).values({ ...session, updatedAt: session.createdAt })
      await tx.insert(refreshTokens).values(tokenValues(session, token))
      await recordActivity(tx, activity ? [activity] : [])
    })
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
  async revoke(
    environmentId: string,
    id: string,
    reason: SessionRevokeReason,
    at: Date,
    activity?: Activity
  ): Promise<boolean> {
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
  async revokeByUser(
    environmentId: string,
    userId: string,
    reason: SessionRevokeReason,
    at: Date,
    options: RevokeByUserOptions = {}
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
      await recordActivity(tx, activity ? ids.map(activity) : [])
      return ids
    })
  }
}
