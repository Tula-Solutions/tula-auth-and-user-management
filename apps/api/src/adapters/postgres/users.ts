import type { OAuthProvider } from '@tula/contract'
import {
  credentials,
  type Database,
  identities,
  passkeys,
  passwordHistory,
  users,
  withTenant,
} from '@tula/db'
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  ilike,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  type SQL,
  sql,
} from 'drizzle-orm'
import { recordActivity } from '~/adapters/postgres/activity'
import { isUniqueViolation } from '~/adapters/postgres/errors'
import { activityOf, type Recorded, recordedOf } from '~/ports/activity-log'
import type {
  IdentityRecord,
  LinkGuard,
  LinkOutcome,
  NewIdentity,
  NewUser,
  PasswordHistoryRule,
  PasswordOutcome,
  SignInMeans,
  StoredPasswords,
  UnlinkOutcome,
  UserListCriteria,
  UserRecord,
  UserRepository,
  UserWithPassword,
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
  phoneNumber: users.phoneNumber,
  phoneNumberVerifiedAt: users.phoneNumberVerifiedAt,
  smsFactorEnabledAt: users.smsFactorEnabledAt,
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
  ): Promise<UserWithPassword | null> {
    const [row] = await withTenant(this.db, environmentId, (tx) =>
      tx
        .select({
          user: columns,
          passwordHash: credentials.secret,
          passwordChangedAt: credentials.secretChangedAt,
        })
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
  async create(user: NewUser, recorded: Recorded): Promise<boolean> {
    const activity = activityOf(recorded)
    const { identityId, credentialId, passwordHash, oauthIdentity, ...record } = user
    const scope = { projectId: user.projectId, environmentId: user.environmentId }
    const stamps = { createdAt: user.createdAt, updatedAt: user.createdAt }
    try {
      await withTenant(this.db, user.environmentId, async (tx) => {
        await tx.insert(users).values({ ...record, updatedAt: user.createdAt })
        // An account with no address has no `email` identity: there is nothing to name it by.
        if (user.emailNormalized !== null) {
          await tx.insert(identities).values({
            id: identityId,
            ...scope,
            userId: user.id,
            provider: 'email',
            providerSubject: user.emailNormalized,
            ...stamps,
          })
        }
        if (oauthIdentity) {
          await tx.insert(identities).values({
            id: oauthIdentity.id,
            ...scope,
            userId: user.id,
            provider: oauthIdentity.provider,
            providerSubject: oauthIdentity.subject,
            ...stamps,
          })
        }
        if (passwordHash !== null) {
          await tx.insert(credentials).values({
            id: credentialId,
            ...scope,
            userId: user.id,
            type: 'password',
            secret: passwordHash,
            secretChangedAt: user.createdAt,
            ...stamps,
          })
        }
        await recordActivity(tx, activity ? [activity] : [])
      })
      return true
    } catch (error) {
      // users_environment_email_key (or the email identity's twin): the address is taken. Or
      // identities_environment_provider_subject_key: the provider account is.
      if (isUniqueViolation(error)) {
        return false
      }
      throw error
    }
  }

  /** @inheritdoc */
  async findByIdentity(
    environmentId: string,
    provider: OAuthProvider,
    subject: string
  ): Promise<UserRecord | null> {
    const [row] = await withTenant(this.db, environmentId, (tx) =>
      tx
        .select(columns)
        .from(identities)
        .innerJoin(
          users,
          and(eq(users.id, identities.userId), eq(users.environmentId, identities.environmentId))
        )
        .where(
          and(
            eq(identities.environmentId, environmentId),
            eq(identities.provider, provider),
            eq(identities.providerSubject, subject)
          )
        )
        .limit(1)
    )
    return row ?? null
  }

  async listIdentities(environmentId: string, userId: string): Promise<IdentityRecord[]> {
    const rows = await withTenant(this.db, environmentId, (tx) =>
      tx
        .select({
          id: identities.id,
          userId: identities.userId,
          provider: identities.provider,
          subject: identities.providerSubject,
          createdAt: identities.createdAt,
        })
        .from(identities)
        .where(
          and(
            eq(identities.environmentId, environmentId),
            eq(identities.userId, userId),
            ne(identities.provider, 'email')
          )
        )
        .orderBy(asc(identities.createdAt), asc(identities.id))
    )
    // The `email` identity is filtered out above, so what is left is a provider's.
    return rows.map((row) => ({ ...row, provider: row.provider as OAuthProvider }))
  }

  async linkIdentity(
    identity: NewIdentity,
    recorded: Recorded,
    guard?: LinkGuard
  ): Promise<LinkOutcome> {
    const activity = activityOf(recorded)
    const { environmentId, userId } = identity
    try {
      return await withTenant(this.db, environmentId, async (tx) => {
        // Locked, so the user cannot be deleted, and their address cannot change, between this
        // read and the insert.
        const [owner] = await tx
          .select({ emailNormalized: users.emailNormalized, verified: users.emailVerifiedAt })
          .from(users)
          .where(and(eq(users.id, userId), eq(users.environmentId, environmentId)))
          .limit(1)
          .for('update')
        if (
          !owner ||
          (guard && (owner.emailNormalized !== guard.emailNormalized || owner.verified === null))
        ) {
          return 'user_changed'
        }
        await tx.insert(identities).values({
          id: identity.id,
          projectId: identity.projectId,
          environmentId,
          userId,
          provider: identity.provider,
          providerSubject: identity.subject,
          createdAt: identity.createdAt,
          updatedAt: identity.createdAt,
        })
        await recordActivity(tx, activity ? [activity] : [])
        return 'linked'
      })
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error
      }
      // Which key refused it: the provider account's (it belongs to someone), or the user's
      // one-account-per-provider key.
      const owner = await this.findByIdentity(environmentId, identity.provider, identity.subject)
      return owner ? 'identity_in_use' : 'provider_linked'
    }
  }

  async unlinkIdentity(
    environmentId: string,
    userId: string,
    identityId: string,
    allowed: (remaining: SignInMeans) => boolean,
    recorded: Recorded
  ): Promise<UnlinkOutcome> {
    const activity = activityOf(recorded)
    return withTenant(this.db, environmentId, async (tx) => {
      // Locked, so two removals for one user run one after the other: the second sees what the
      // first left.
      const [owner] = await tx
        .select({ verified: users.emailVerifiedAt })
        .from(users)
        .where(and(eq(users.id, userId), eq(users.environmentId, environmentId)))
        .limit(1)
        .for('update')
      const owned = await tx
        .select({ id: identities.id, provider: identities.provider })
        .from(identities)
        .where(
          and(
            eq(identities.environmentId, environmentId),
            eq(identities.userId, userId),
            ne(identities.provider, 'email')
          )
        )
      if (!owner || !owned.some((identity) => identity.id === identityId)) {
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
      const remaining: SignInMeans = {
        hasPassword: password !== undefined,
        emailVerified: owner.verified !== null,
        providers: owned
          .filter((identity) => identity.id !== identityId)
          .map((identity) => identity.provider as OAuthProvider),
        passkeys: await tx.$count(
          passkeys,
          and(eq(passkeys.environmentId, environmentId), eq(passkeys.userId, userId))
        ),
      }
      if (!allowed(remaining)) {
        return 'last_method'
      }
      await tx
        .delete(identities)
        .where(and(eq(identities.id, identityId), eq(identities.environmentId, environmentId)))
      await recordActivity(tx, activity ? [activity] : [])
      return 'unlinked'
    })
  }

  async setPasswordHash(
    environmentId: string,
    userId: string,
    passwordHash: string,
    at: Date,
    recorded: Recorded,
    history: PasswordHistoryRule
  ): Promise<PasswordOutcome | 'stale' | null> {
    const activity = activityOf(recorded)
    return withTenant(this.db, environmentId, async (tx) => {
      // The row lock keeps the user from being deleted between this read and the write below,
      // which needs their project for a new credential row. It also puts this write before or
      // after a `markEmailVerified` of the same user, never underneath it: that one updates
      // the row, so it waits for this transaction or this one for it. Without the lock a
      // first password stored during the verification is invisible to its delete and stays
      // (`races.integration.ts` fails for it).
      //
      // It is a lock no other password write of the user shares (`NO KEY UPDATE`, where a
      // shared lock was enough before there was a history): the hash read below is then the
      // one this transaction replaces, so two concurrent writes each keep the other's hash
      // once, and neither loses one or keeps one twice. It does not block the foreign-key
      // checks of rows that point at the user (a session being created).
      const [owner] = await tx
        .select({ projectId: users.projectId })
        .from(users)
        .where(and(eq(users.id, userId), eq(users.environmentId, environmentId)))
        .limit(1)
        .for('no key update')
      if (!owner) {
        return null
      }
      const ownRows = and(
        eq(passwordHistory.userId, userId),
        eq(passwordHistory.environmentId, environmentId)
      )
      const [stored] = await tx
        .select({ secret: credentials.secret })
        .from(credentials)
        .where(
          and(
            eq(credentials.userId, userId),
            eq(credentials.environmentId, environmentId),
            eq(credentials.type, 'password')
          )
        )
        .limit(1)
      const current = stored?.secret ?? null
      if (history.ifCurrent !== undefined && history.ifCurrent !== current) {
        return 'stale'
      }
      const keep = Math.max(0, history.keep)
      if (current === null) {
        // Nothing stops being current, so nothing moves: only what is beyond the policy goes.
        await tx.delete(passwordHistory).where(and(ownRows, gt(passwordHistory.position, keep)))
      } else {
        // Every row moves one place back, so what is at `keep` now would be beyond it.
        await tx.delete(passwordHistory).where(and(ownRows, gte(passwordHistory.position, keep)))
        if (keep >= 1) {
          await tx
            .update(passwordHistory)
            .set({ position: sql`${passwordHistory.position} + 1`, updatedAt: at })
            .where(ownRows)
          await tx.insert(passwordHistory).values({
            projectId: owner.projectId,
            environmentId,
            userId,
            // The hash as it stood: never a second, cheaper form of the password.
            secret: current,
            position: 1,
            createdAt: at,
            updatedAt: at,
          })
        }
      }
      // One statement creates or replaces, so two concurrent first passwords cannot both
      // insert: the second lands on the unique (user, type) key and updates instead.
      const [row] = await tx
        .insert(credentials)
        .values({
          projectId: owner.projectId,
          environmentId,
          userId,
          type: 'password',
          secret: passwordHash,
          secretChangedAt: at,
          createdAt: at,
          updatedAt: at,
        })
        .onConflictDoUpdate({
          target: [credentials.userId, credentials.type],
          // A different password from here on: its age is counted from this write (ADR 0041).
          // Always later than the time it replaces, by a millisecond when the writer's clock
          // says otherwise: that time is how a sign-in waiting to replace an expired password
          // tells a replacement from a hash upgrade, which leaves it alone.
          set: {
            secret: passwordHash,
            secretChangedAt: sql`GREATEST(excluded.secret_changed_at, ${credentials.secretChangedAt} + interval '1 millisecond')`,
            updatedAt: at,
          },
        })
        // `xmax` is 0 on a row this statement inserted and the updating transaction's id on
        // one it updated: the standard way to tell the two apart in an upsert.
        .returning({ created: sql<boolean>`(xmax = 0)` })
      const outcome: PasswordOutcome = row?.created ? 'created' : 'replaced'
      await recordActivity(
        tx,
        activity
          ? [
              outcome === 'created'
                ? { ...activity, data: { ...activity.data, created: true } }
                : activity,
            ]
          : []
      )
      return outcome
    })
  }

  /** @inheritdoc */
  async storedPasswords(
    environmentId: string,
    userId: string,
    previous: number
  ): Promise<StoredPasswords> {
    return withTenant(this.db, environmentId, async (tx) => {
      const [stored] = await tx
        .select({ secret: credentials.secret })
        .from(credentials)
        .where(
          and(
            eq(credentials.userId, userId),
            eq(credentials.environmentId, environmentId),
            eq(credentials.type, 'password')
          )
        )
        .limit(1)
      const rows =
        previous > 0
          ? await tx
              .select({ secret: passwordHistory.secret })
              .from(passwordHistory)
              .where(
                and(
                  eq(passwordHistory.userId, userId),
                  eq(passwordHistory.environmentId, environmentId)
                )
              )
              .orderBy(asc(passwordHistory.position), desc(passwordHistory.id))
              .limit(previous)
          : []
      return { current: stored?.secret ?? null, previous: rows.map((row) => row.secret) }
    })
  }

  /** @inheritdoc */
  async deletePasswordHistoryBeyond(
    environmentId: string,
    keep: number,
    limit: number
  ): Promise<number> {
    // An indexed range of one environment (`password_history_environment_position_idx`): the
    // rows a user may keep are never read.
    const beyond = and(
      eq(passwordHistory.environmentId, environmentId),
      gt(passwordHistory.position, Math.max(0, keep))
    )
    const rows = await withTenant(this.db, environmentId, (tx) => {
      // DELETE has no LIMIT in Postgres: pick the batch in a subquery. The batch is locked as
      // it is picked and a row someone else holds is passed over (`SKIP LOCKED`): a password
      // change locks its user's rows in its own order, and a purge that waited for them could
      // deadlock with it, with the user's request as the victim. What is passed over goes in
      // a later round.
      const batch = tx
        .select({ id: passwordHistory.id })
        .from(passwordHistory)
        .where(beyond)
        .limit(limit)
        .for('update', { skipLocked: true })
      return (
        tx
          .delete(passwordHistory)
          // `= ANY(ARRAY(…))` and not `IN (…)`: the array is built once, before the delete
          // runs, so the batch is `limit` rows at most. Written as `IN (…)` the locking
          // subquery deleted four rows for a limit of three (the shared suite, on PGlite).
          .where(and(beyond, sql`${passwordHistory.id} = any(array(${batch}))`))
          .returning({ id: passwordHistory.id })
      )
    })
    return rows.length
  }

  /** @inheritdoc */
  async upgradePasswordHash(
    environmentId: string,
    userId: string,
    currentHash: string,
    passwordHash: string,
    at: Date
  ): Promise<boolean> {
    const rows = await withTenant(this.db, environmentId, (tx) =>
      tx
        .update(credentials)
        // Not `secretChangedAt`: this is the same password, and hashing it again must not
        // make an expired password look new (ADR 0041).
        .set({ secret: passwordHash, updatedAt: at })
        .where(
          and(
            eq(credentials.userId, userId),
            eq(credentials.environmentId, environmentId),
            eq(credentials.type, 'password'),
            // The compare-and-set: only the hash that was verified may be replaced.
            eq(credentials.secret, currentHash)
          )
        )
        .returning({ id: credentials.id })
    )
    return rows.length === 1
  }

  /** @inheritdoc */
  async markEmailVerified(
    environmentId: string,
    userId: string,
    at: Date,
    recorded: Recorded,
    removePassword?: { activity: Recorded }
  ): Promise<{ passwordRemoved: boolean }> {
    const activity = activityOf(recorded)
    const removal = removePassword && activityOf(removePassword.activity)
    return withTenant(this.db, environmentId, async (tx) => {
      // The guarded UPDATE is the arbiter: of two concurrent verifications one changes the row,
      // and only that one may remove the password.
      const rows = await tx
        .update(users)
        .set({ emailVerifiedAt: at, updatedAt: at })
        .where(
          and(
            eq(users.id, userId),
            eq(users.environmentId, environmentId),
            // An account with no address has none to verify (`users_email_whole`).
            isNotNull(users.email),
            isNull(users.emailVerifiedAt)
          )
        )
        .returning({ id: users.id })
      if (rows.length !== 1) {
        return { passwordRemoved: false }
      }
      const removed = removePassword
        ? await tx
            .delete(credentials)
            .where(
              and(
                eq(credentials.userId, userId),
                eq(credentials.environmentId, environmentId),
                eq(credentials.type, 'password')
              )
            )
            .returning({ id: credentials.id })
        : []
      const passwordRemoved = removed.length > 0
      if (removePassword) {
        // Whoever chose the password chose the ones before it too: the address's owner is
        // never refused a password because a stranger used it (ADR 0038).
        await tx
          .delete(passwordHistory)
          .where(
            and(
              eq(passwordHistory.userId, userId),
              eq(passwordHistory.environmentId, environmentId)
            )
          )
      }
      await recordActivity(tx, [
        ...(activity ? [activity] : []),
        ...(passwordRemoved && removal ? [removal] : []),
      ])
      return { passwordRemoved }
    })
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
    at: Date,
    recorded: Recorded
  ): Promise<UserRecord | null> {
    const activity = activityOf(recorded)
    const isUser = and(eq(users.id, userId), eq(users.environmentId, environmentId))
    return withTenant(this.db, environmentId, async (tx) => {
      // Guarded so only a real change writes: banning an already-banned user keeps the original
      // ban time, and neither a repeated ban nor a repeated unban is recorded twice.
      const [changed] = await tx
        .update(users)
        .set({ bannedAt, updatedAt: at })
        .where(and(isUser, bannedAt === null ? isNotNull(users.bannedAt) : isNull(users.bannedAt)))
        .returning(columns)
      if (changed) {
        await recordActivity(tx, activity ? [activity] : [])
        return changed
      }
      const [unchanged] = await tx.select(columns).from(users).where(isUser).limit(1)
      return unchanged ?? null
    })
  }

  /** @inheritdoc */
  async findByPhoneNumber(
    environmentId: string,
    phoneNumber: string,
    limit: number
  ): Promise<UserRecord[]> {
    return withTenant(this.db, environmentId, (tx) =>
      tx
        .select(columns)
        .from(users)
        .where(and(eq(users.environmentId, environmentId), eq(users.phoneNumber, phoneNumber)))
        .orderBy(asc(users.createdAt), asc(users.id))
        .limit(limit)
    )
  }

  /** @inheritdoc */
  async recordPhoneNumberProof(
    environmentId: string,
    userId: string,
    phoneNumber: string,
    at: Date
  ): Promise<void> {
    await withTenant(this.db, environmentId, (tx) =>
      tx
        .update(users)
        .set({ phoneNumberVerifiedAt: at, updatedAt: at })
        .where(
          and(
            eq(users.id, userId),
            eq(users.environmentId, environmentId),
            // Only while the account still holds the number the code went to, and only forwards.
            eq(users.phoneNumber, phoneNumber),
            lt(users.phoneNumberVerifiedAt, at)
          )
        )
    )
  }

  /** @inheritdoc */
  async setPhoneNumber(
    environmentId: string,
    userId: string,
    phoneNumber: string,
    at: Date,
    recorded: Recorded,
    factorRemoved: Recorded
  ): Promise<UserRecord | null> {
    const isUser = and(eq(users.id, userId), eq(users.environmentId, environmentId))
    return withTenant(this.db, environmentId, async (tx) => {
      // The row is held while it is read and written, so "had the factor, for another number"
      // is true of the row this statement changes: the entry is written exactly when the
      // factor went.
      const [before] = await tx
        .select({ phoneNumber: users.phoneNumber, smsFactorEnabledAt: users.smsFactorEnabledAt })
        .from(users)
        .where(isUser)
        .for('no key update')
      if (!before) {
        return null
      }
      const hadFactor = before.smsFactorEnabledAt !== null && before.phoneNumber !== phoneNumber
      const [changed] = await tx
        .update(users)
        .set({
          phoneNumber,
          phoneNumberVerifiedAt: at,
          // A factor of the number that is being replaced is not one of the new number.
          ...(hadFactor && { smsFactorEnabledAt: null }),
          updatedAt: at,
        })
        .where(isUser)
        .returning(columns)
      if (!changed) {
        return null
      }
      await recordActivity(tx, recordedOf(hadFactor ? [recorded, factorRemoved] : [recorded]))
      return changed
    })
  }

  /** @inheritdoc */
  async removePhoneNumber(
    environmentId: string,
    userId: string,
    at: Date,
    recorded: Recorded,
    factorRemoved: Recorded
  ): Promise<boolean> {
    const isUser = and(eq(users.id, userId), eq(users.environmentId, environmentId))
    return withTenant(this.db, environmentId, async (tx) => {
      const [before] = await tx
        .select({ smsFactorEnabledAt: users.smsFactorEnabledAt })
        .from(users)
        .where(and(isUser, isNotNull(users.phoneNumber)))
        .for('no key update')
      if (!before) {
        // No number, or no such user: nothing to remove and nothing to record.
        return false
      }
      // The factor goes in the statement that takes the number: the database would refuse a
      // factor without one (`users_sms_factor_needs_number`).
      await tx
        .update(users)
        .set({
          phoneNumber: null,
          phoneNumberVerifiedAt: null,
          smsFactorEnabledAt: null,
          updatedAt: at,
        })
        .where(isUser)
      await recordActivity(
        tx,
        recordedOf(before.smsFactorEnabledAt !== null ? [recorded, factorRemoved] : [recorded])
      )
      return true
    })
  }

  /** @inheritdoc */
  async enableSmsFactor(
    environmentId: string,
    userId: string,
    phoneNumber: string,
    at: Date,
    recorded: Recorded
  ): Promise<boolean> {
    return withTenant(this.db, environmentId, async (tx) => {
      // Guarded: only while the account holds the number the code went to, and only once.
      const rows = await tx
        .update(users)
        .set({ smsFactorEnabledAt: at, updatedAt: at })
        .where(
          and(
            eq(users.id, userId),
            eq(users.environmentId, environmentId),
            eq(users.phoneNumber, phoneNumber),
            isNull(users.smsFactorEnabledAt)
          )
        )
        .returning({ id: users.id })
      const enabled = rows.length === 1
      await recordActivity(tx, enabled ? recordedOf([recorded]) : [])
      return enabled
    })
  }

  /** @inheritdoc */
  async disableSmsFactor(
    environmentId: string,
    userId: string,
    at: Date,
    recorded: Recorded
  ): Promise<boolean> {
    return withTenant(this.db, environmentId, async (tx) => {
      const rows = await tx
        .update(users)
        .set({ smsFactorEnabledAt: null, updatedAt: at })
        .where(
          and(
            eq(users.id, userId),
            eq(users.environmentId, environmentId),
            isNotNull(users.smsFactorEnabledAt)
          )
        )
        .returning({ id: users.id })
      const disabled = rows.length === 1
      await recordActivity(tx, disabled ? recordedOf([recorded]) : [])
      return disabled
    })
  }

  /** @inheritdoc */
  async delete(environmentId: string, userId: string, recorded: Recorded): Promise<boolean> {
    const activity = activityOf(recorded)
    return withTenant(this.db, environmentId, async (tx) => {
      const rows = await tx
        .delete(users)
        .where(and(eq(users.id, userId), eq(users.environmentId, environmentId)))
        .returning({ id: users.id })
      const deleted = rows.length === 1
      await recordActivity(tx, deleted && activity ? [activity] : [])
      return deleted
    })
  }
}
