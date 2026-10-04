import type { OAuthProvider } from '@tula/contract'
import {
  credentials,
  type Database,
  identities,
  passkeyChallenges,
  passkeys,
  users,
  withTenant,
} from '@tula/db'
import { and, asc, eq, inArray, lte, ne } from 'drizzle-orm'
import { recordActivity } from '~/adapters/postgres/activity'
import { isUniqueViolation } from '~/adapters/postgres/errors'
import type { Activity } from '~/ports/activity-log'
import type {
  PasskeyChallengePurpose,
  PasskeyChallengeRecord,
  PasskeyCreateOutcome,
  PasskeyRecord,
  PasskeyRemoveOutcome,
  PasskeyStore,
  PasskeyUse,
} from '~/ports/passkey-store'
import type { SignInMeans } from '~/ports/user-repository'

const columns = {
  id: passkeys.id,
  projectId: passkeys.projectId,
  environmentId: passkeys.environmentId,
  userId: passkeys.userId,
  credentialId: passkeys.credentialId,
  publicKey: passkeys.publicKey,
  signCount: passkeys.signCount,
  transports: passkeys.transports,
  aaguid: passkeys.aaguid,
  backupEligible: passkeys.backupEligible,
  backedUp: passkeys.backedUp,
  userHandle: passkeys.userHandle,
  name: passkeys.name,
  lastUsedAt: passkeys.lastUsedAt,
  createdAt: passkeys.createdAt,
}

function ofUser(environmentId: string, userId: string) {
  return and(eq(passkeys.environmentId, environmentId), eq(passkeys.userId, userId))
}

/** Passkeys and session challenges in PostgreSQL. Every query runs inside `withTenant`. */
export class PostgresPasskeyStore implements PasskeyStore {
  /** @param db - The runtime database connection (role `tula_api`). */
  constructor(private readonly db: Database) {}

  async create(
    passkey: PasskeyRecord,
    limit: number,
    activity?: Activity
  ): Promise<PasskeyCreateOutcome> {
    const { environmentId, userId } = passkey
    try {
      return await withTenant(this.db, environmentId, async (tx) => {
        // Locked, so two registrations for one user are counted one after the other.
        const [owner] = await tx
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.id, userId), eq(users.environmentId, environmentId)))
          .limit(1)
          .for('update')
        if (!owner || (await tx.$count(passkeys, ofUser(environmentId, userId))) >= limit) {
          return 'limit'
        }
        await tx.insert(passkeys).values({ ...passkey, updatedAt: passkey.createdAt })
        await recordActivity(tx, activity ? [activity] : [])
        return 'created'
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        return 'duplicate'
      }
      throw error
    }
  }

  async listForUser(environmentId: string, userId: string): Promise<PasskeyRecord[]> {
    return withTenant(this.db, environmentId, (tx) =>
      tx
        .select(columns)
        .from(passkeys)
        .where(ofUser(environmentId, userId))
        .orderBy(asc(passkeys.createdAt), asc(passkeys.id))
    )
  }

  async findByCredentialId(
    environmentId: string,
    credentialId: string
  ): Promise<PasskeyRecord | null> {
    const [row] = await withTenant(this.db, environmentId, (tx) =>
      tx
        .select(columns)
        .from(passkeys)
        .where(
          and(eq(passkeys.environmentId, environmentId), eq(passkeys.credentialId, credentialId))
        )
        .limit(1)
    )
    return row ?? null
  }

  async recordUse(environmentId: string, id: string, use: PasskeyUse): Promise<boolean> {
    const rows = await withTenant(this.db, environmentId, (tx) =>
      tx
        .update(passkeys)
        .set({
          signCount: use.signCount,
          backupEligible: use.backupEligible,
          backedUp: use.backedUp,
          lastUsedAt: use.at,
          updatedAt: use.at,
        })
        .where(
          and(
            eq(passkeys.id, id),
            eq(passkeys.environmentId, environmentId),
            eq(passkeys.signCount, use.expectedSignCount)
          )
        )
        .returning({ id: passkeys.id })
    )
    return rows.length > 0
  }

  async reportRegression(environmentId: string, id: string, activity: Activity): Promise<void> {
    await withTenant(this.db, environmentId, async (tx) => {
      const [row] = await tx
        .select({ id: passkeys.id })
        .from(passkeys)
        .where(and(eq(passkeys.id, id), eq(passkeys.environmentId, environmentId)))
        .limit(1)
      if (row) {
        await recordActivity(tx, [activity])
      }
    })
  }

  async rename(
    environmentId: string,
    userId: string,
    id: string,
    name: string,
    at: Date,
    activity?: Activity
  ): Promise<boolean> {
    return withTenant(this.db, environmentId, async (tx) => {
      const rows = await tx
        .update(passkeys)
        .set({ name, updatedAt: at })
        .where(and(eq(passkeys.id, id), ofUser(environmentId, userId)))
        .returning({ id: passkeys.id })
      if (rows.length === 0) {
        return false
      }
      await recordActivity(tx, activity ? [activity] : [])
      return true
    })
  }

  async remove(
    environmentId: string,
    userId: string,
    id: string,
    allowed: (remaining: SignInMeans) => boolean,
    activity?: Activity
  ): Promise<PasskeyRemoveOutcome> {
    return withTenant(this.db, environmentId, async (tx) => {
      // Locked, so two removals for one user run one after the other: the second sees what the
      // first left. The same lock `unlinkIdentity` takes, so the two cannot cross either.
      const [owner] = await tx
        .select({ verified: users.emailVerifiedAt })
        .from(users)
        .where(and(eq(users.id, userId), eq(users.environmentId, environmentId)))
        .limit(1)
        .for('update')
      const owned = await tx
        .select({ id: passkeys.id })
        .from(passkeys)
        .where(ofUser(environmentId, userId))
      if (!owner || !owned.some((passkey) => passkey.id === id)) {
        return 'not_found'
      }
      const [password] = await tx
        .select({ id: credentials.id })
        .from(credentials)
        .where(
          and(
            eq(credentials.environmentId, environmentId),
            eq(credentials.userId, userId),
            eq(credentials.type, 'password')
          )
        )
        .limit(1)
      const linked = await tx
        .select({ provider: identities.provider })
        .from(identities)
        .where(
          and(
            eq(identities.environmentId, environmentId),
            eq(identities.userId, userId),
            ne(identities.provider, 'email')
          )
        )
      const remaining: SignInMeans = {
        hasPassword: password !== undefined,
        emailVerified: owner.verified !== null,
        providers: linked.map((identity) => identity.provider as OAuthProvider),
        passkeys: owned.length - 1,
      }
      if (!allowed(remaining)) {
        return 'last_method'
      }
      await tx.delete(passkeys).where(and(eq(passkeys.id, id), ofUser(environmentId, userId)))
      await recordActivity(tx, activity ? [activity] : [])
      return 'removed'
    })
  }

  async removeForUser(environmentId: string, userId: string, activity?: Activity): Promise<number> {
    return withTenant(this.db, environmentId, async (tx) => {
      const rows = await tx
        .delete(passkeys)
        .where(ofUser(environmentId, userId))
        .returning({ id: passkeys.id })
      await tx
        .delete(passkeyChallenges)
        .where(
          and(
            eq(passkeyChallenges.environmentId, environmentId),
            eq(passkeyChallenges.userId, userId)
          )
        )
      await recordActivity(tx, activity && rows.length > 0 ? [activity] : [])
      return rows.length
    })
  }

  async putChallenge(challenge: PasskeyChallengeRecord): Promise<void> {
    await withTenant(this.db, challenge.environmentId, (tx) =>
      tx
        .insert(passkeyChallenges)
        .values({ ...challenge, updatedAt: challenge.createdAt })
        .onConflictDoUpdate({
          target: [passkeyChallenges.sessionId, passkeyChallenges.purpose],
          set: {
            id: challenge.id,
            userId: challenge.userId,
            challenge: challenge.challenge,
            expiresAt: challenge.expiresAt,
            createdAt: challenge.createdAt,
            updatedAt: challenge.createdAt,
          },
        })
    )
  }

  async takeChallenge(
    environmentId: string,
    sessionId: string,
    purpose: PasskeyChallengePurpose,
    now: Date
  ): Promise<Pick<PasskeyChallengeRecord, 'challenge' | 'userId'> | null> {
    const [row] = await withTenant(this.db, environmentId, (tx) =>
      tx
        .delete(passkeyChallenges)
        .where(
          and(
            eq(passkeyChallenges.environmentId, environmentId),
            eq(passkeyChallenges.sessionId, sessionId),
            eq(passkeyChallenges.purpose, purpose)
          )
        )
        .returning({
          challenge: passkeyChallenges.challenge,
          userId: passkeyChallenges.userId,
          expiresAt: passkeyChallenges.expiresAt,
        })
    )
    return row && row.expiresAt.getTime() > now.getTime()
      ? { challenge: row.challenge, userId: row.userId }
      : null
  }

  async deleteExpiredChallenges(
    environmentId: string,
    before: Date,
    limit: number
  ): Promise<number> {
    const expired = and(
      eq(passkeyChallenges.environmentId, environmentId),
      lte(passkeyChallenges.expiresAt, before)
    )
    const rows = await withTenant(this.db, environmentId, (tx) =>
      tx
        .delete(passkeyChallenges)
        .where(
          and(
            expired,
            // DELETE has no LIMIT in Postgres: pick the batch in a subquery.
            inArray(
              passkeyChallenges.id,
              tx
                .select({ id: passkeyChallenges.id })
                .from(passkeyChallenges)
                .where(expired)
                .limit(limit)
            )
          )
        )
        .returning({ id: passkeyChallenges.id })
    )
    return rows.length
  }
}
