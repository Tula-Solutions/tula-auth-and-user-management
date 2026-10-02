import { credentials, type Database, identities, users, withTenant } from '@tula/db'
import { and, asc, count, desc, eq, ilike, isNull, or, type SQL, sql } from 'drizzle-orm'
import { isUniqueViolation } from '~/adapters/postgres/errors'
import type {
  NewUserWithPassword,
  UserListCriteria,
  UserRecord,
  UserRepository,
} from '~/ports/user-repository'

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

/** Escape `LIKE` wildcards so a search term only ever matches literally. */
function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`
}

function orderBy(sort: UserListCriteria['sort']): SQL[] {
  const descending = sort.startsWith('-')
  const column = {
    createdAt: users.createdAt,
    email: users.emailNormalized,
    lastSignInAt: users.lastSignInAt,
  }[sort.replace('-', '') as 'createdAt' | 'email' | 'lastSignInAt']
  // NULLS LAST both ways, so users who never signed in don't lead a descending list. The id
  // makes the order total, which paging needs.
  return descending
    ? [sql`${column} desc nulls last`, desc(users.id)]
    : [sql`${column} asc nulls last`, asc(users.id)]
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

  /** @inheritdoc */
  async list(
    environmentId: string,
    criteria: UserListCriteria
  ): Promise<{ users: UserRecord[]; totalCount: number }> {
    const q = criteria.q?.trim()
    const pattern = q ? likePattern(q) : null
    const where = and(
      eq(users.environmentId, environmentId),
      pattern
        ? or(
            ilike(users.emailNormalized, pattern),
            ilike(users.firstName, pattern),
            ilike(users.lastName, pattern)
          )
        : undefined
    )
    return withTenant(this.db, environmentId, async (tx) => {
      const [total] = await tx.select({ value: count() }).from(users).where(where)
      const rows = await tx
        .select(columns)
        .from(users)
        .where(where)
        .orderBy(...orderBy(criteria.sort))
        .limit(criteria.size)
        .offset((criteria.page - 1) * criteria.size)
      return { users: rows, totalCount: total?.value ?? 0 }
    })
  }

  /** @inheritdoc */
  async setBanned(
    environmentId: string,
    userId: string,
    bannedAt: Date | null,
    at: Date
  ): Promise<UserRecord | null> {
    const [row] = await withTenant(this.db, environmentId, (tx) =>
      tx
        .update(users)
        .set({
          // Banning an already-banned user keeps the original ban time.
          bannedAt:
            bannedAt === null
              ? null
              : sql`coalesce(${users.bannedAt}, ${bannedAt.toISOString()}::timestamptz)`,
          updatedAt: at,
        })
        .where(and(eq(users.id, userId), eq(users.environmentId, environmentId)))
        .returning(columns)
    )
    return row ?? null
  }

  /** @inheritdoc */
  async delete(environmentId: string, userId: string): Promise<boolean> {
    const rows = await withTenant(this.db, environmentId, (tx) =>
      tx
        .delete(users)
        .where(and(eq(users.id, userId), eq(users.environmentId, environmentId)))
        .returning({ id: users.id })
    )
    return rows.length === 1
  }
}
