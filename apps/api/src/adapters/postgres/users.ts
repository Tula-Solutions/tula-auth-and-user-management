import { credentials, type Database, identities, users, withTenant } from '@tula/db'
import { and, eq, isNull } from 'drizzle-orm'
import { isUniqueViolation } from '~/adapters/postgres/errors'
import type { NewUserWithPassword, UserRecord, UserRepository } from '~/ports/user-repository'

const columns = {
  id: users.id,
  projectId: users.projectId,
  environmentId: users.environmentId,
  email: users.email,
  emailNormalized: users.emailNormalized,
  emailVerifiedAt: users.emailVerifiedAt,
  firstName: users.firstName,
  lastName: users.lastName,
  bannedAt: users.bannedAt,
  lastSignInAt: users.lastSignInAt,
  createdAt: users.createdAt,
}

/**
 * Users, identities and credentials in Postgres, inside the environment's RLS scope.
 *
 * RLS already hides other environments' rows; the explicit `environment_id` filters are defence
 * in depth and keep the queries on their indexes.
 */
export class PostgresUserRepository implements UserRepository {
  /** @param db - Database connected as the runtime role. */
  constructor(private readonly db: Database) {}

  /** @inheritdoc */
  async findById(environmentId: string, id: string): Promise<UserRecord | null> {
    const [row] = await withTenant(this.db, environmentId, (tx) =>
      tx
        .select(columns)
        .from(users)
        .where(and(eq(users.id, id), eq(users.environmentId, environmentId)))
        .limit(1)
    )
    return row ?? null
  }

  /** @inheritdoc */
  async findByEmail(environmentId: string, emailNormalized: string): Promise<UserRecord | null> {
    const [row] = await withTenant(this.db, environmentId, (tx) =>
      tx
        .select(columns)
        .from(users)
        .where(
          and(eq(users.emailNormalized, emailNormalized), eq(users.environmentId, environmentId))
        )
        .limit(1)
    )
    return row ?? null
  }

  /** @inheritdoc */
  async findByEmailWithPassword(
    environmentId: string,
    emailNormalized: string
  ): Promise<{ user: UserRecord; passwordHash: string | null } | null> {
    const [row] = await withTenant(this.db, environmentId, (tx) =>
      tx
        .select({ user: columns, passwordHash: credentials.secret })
        .from(users)
        .leftJoin(
          credentials,
          and(
            eq(credentials.userId, users.id),
            eq(credentials.environmentId, users.environmentId),
            eq(credentials.type, 'password')
          )
        )
        .where(
          and(eq(users.emailNormalized, emailNormalized), eq(users.environmentId, environmentId))
        )
        .limit(1)
    )
    return row ?? null
  }

  /** @inheritdoc */
  async createWithPassword(user: NewUserWithPassword): Promise<boolean> {
    const { identityId, credentialId, passwordHash, ...record } = user
    const scope = { projectId: user.projectId, environmentId: user.environmentId }
    const stamps = { createdAt: user.createdAt, updatedAt: user.createdAt }
    try {
      await withTenant(this.db, user.environmentId, async (tx) => {
        await tx.insert(users).values({ ...record, updatedAt: user.createdAt })
        await tx.insert(identities).values({
          id: identityId,
          ...scope,
          userId: user.id,
          provider: 'email',
          providerSubject: user.emailNormalized,
          ...stamps,
        })
        await tx.insert(credentials).values({
          id: credentialId,
          ...scope,
          userId: user.id,
          type: 'password',
          secret: passwordHash,
          ...stamps,
        })
      })
      return true
    } catch (error) {
      // users_environment_email_key (or the email identity's twin): the address is taken.
      if (isUniqueViolation(error)) {
        return false
      }
      throw error
    }
  }

  /** @inheritdoc */
  async setPasswordHash(
    environmentId: string,
    userId: string,
    passwordHash: string,
    at: Date
  ): Promise<void> {
    await withTenant(this.db, environmentId, (tx) =>
      tx
        .update(credentials)
        .set({ secret: passwordHash, updatedAt: at })
        .where(
          and(
            eq(credentials.userId, userId),
            eq(credentials.environmentId, environmentId),
            eq(credentials.type, 'password')
          )
        )
    )
  }

  /** @inheritdoc */
  async markEmailVerified(environmentId: string, userId: string, at: Date): Promise<void> {
    await withTenant(this.db, environmentId, (tx) =>
      tx
        .update(users)
        .set({ emailVerifiedAt: at, updatedAt: at })
        .where(
          and(
            eq(users.id, userId),
            eq(users.environmentId, environmentId),
            isNull(users.emailVerifiedAt)
          )
        )
    )
  }

  /** @inheritdoc */
  async recordSignIn(environmentId: string, userId: string, at: Date): Promise<void> {
    await withTenant(this.db, environmentId, (tx) =>
      tx
        .update(users)
        .set({ lastSignInAt: at, updatedAt: at })
        .where(and(eq(users.id, userId), eq(users.environmentId, environmentId)))
    )
  }
}
