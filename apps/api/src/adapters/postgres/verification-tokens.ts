import { type Database, verificationTokens, withTenant } from '@tula/db'
import { and, desc, eq, gt, isNull, lt, sql } from 'drizzle-orm'
import {
  type NewVerificationToken,
  subjectOf,
  type VerificationPurpose,
  type VerificationSubject,
  type VerificationTokenRecord,
  type VerificationTokenStore,
} from '~/ports/verification-token-store'

const columns = {
  id: verificationTokens.id,
  projectId: verificationTokens.projectId,
  environmentId: verificationTokens.environmentId,
  userId: verificationTokens.userId,
  flowAttemptId: verificationTokens.flowAttemptId,
  purpose: verificationTokens.purpose,
  destination: verificationTokens.destination,
  codeHash: verificationTokens.codeHash,
  linkTokenHash: verificationTokens.linkTokenHash,
  attempts: verificationTokens.attempts,
  maxAttempts: verificationTokens.maxAttempts,
  expiresAt: verificationTokens.expiresAt,
  consumedAt: verificationTokens.consumedAt,
  createdAt: verificationTokens.createdAt,
}

function bySubject(subject: VerificationSubject) {
  return 'flowAttemptId' in subject
    ? eq(verificationTokens.flowAttemptId, subject.flowAttemptId)
    : eq(verificationTokens.userId, subject.userId)
}

/**
 * Verification tokens in `tula.verification_tokens`, inside the environment's RLS scope.
 *
 * RLS already hides other environments' rows; the explicit `environment_id` filters are defence
 * in depth and keep the queries on their indexes.
 */
export class PostgresVerificationTokenStore implements VerificationTokenStore {
  /** @param db - Database connected as the runtime role. */
  constructor(private readonly db: Database) {}

  /** @inheritdoc */
  async replace(token: NewVerificationToken, at: Date): Promise<void> {
    await withTenant(this.db, token.environmentId, async (tx) => {
      await tx
        .update(verificationTokens)
        .set({ consumedAt: at, updatedAt: at })
        .where(
          and(
            eq(verificationTokens.environmentId, token.environmentId),
            eq(verificationTokens.purpose, token.purpose),
            isNull(verificationTokens.consumedAt),
            bySubject(subjectOf(token))
          )
        )
      await tx.insert(verificationTokens).values({ ...token, updatedAt: token.createdAt })
    })
  }

  /** @inheritdoc */
  async findLatest(
    environmentId: string,
    purpose: VerificationPurpose,
    subject: VerificationSubject
  ): Promise<VerificationTokenRecord | null> {
    const [row] = await withTenant(this.db, environmentId, (tx) =>
      tx
        .select(columns)
        .from(verificationTokens)
        .where(
          and(
            eq(verificationTokens.environmentId, environmentId),
            eq(verificationTokens.purpose, purpose),
            bySubject(subject)
          )
        )
        .orderBy(desc(verificationTokens.createdAt), desc(verificationTokens.id))
        .limit(1)
    )
    return row ?? null
  }

  /** @inheritdoc */
  async findByLinkHash(
    environmentId: string,
    linkTokenHash: string
  ): Promise<VerificationTokenRecord | null> {
    const [row] = await withTenant(this.db, environmentId, (tx) =>
      tx
        .select(columns)
        .from(verificationTokens)
        .where(
          and(
            eq(verificationTokens.environmentId, environmentId),
            eq(verificationTokens.linkTokenHash, linkTokenHash)
          )
        )
        .limit(1)
    )
    return row ?? null
  }

  /** @inheritdoc */
  async recordAttempt(
    environmentId: string,
    id: string,
    now: Date
  ): Promise<VerificationTokenRecord | null> {
    // One guarded UPDATE: the row lock serializes concurrent guesses, so the counter can never
    // pass max_attempts however many requests race.
    const [row] = await withTenant(this.db, environmentId, (tx) =>
      tx
        .update(verificationTokens)
        .set({ attempts: sql`${verificationTokens.attempts} + 1`, updatedAt: now })
        .where(
          and(
            eq(verificationTokens.id, id),
            eq(verificationTokens.environmentId, environmentId),
            isNull(verificationTokens.consumedAt),
            gt(verificationTokens.expiresAt, now),
            lt(verificationTokens.attempts, verificationTokens.maxAttempts)
          )
        )
        .returning(columns)
    )
    return row ?? null
  }

  /** @inheritdoc */
  async consume(environmentId: string, id: string, now: Date): Promise<boolean> {
    const rows = await withTenant(this.db, environmentId, (tx) =>
      tx
        .update(verificationTokens)
        .set({ consumedAt: now, updatedAt: now })
        .where(
          and(
            eq(verificationTokens.id, id),
            eq(verificationTokens.environmentId, environmentId),
            isNull(verificationTokens.consumedAt),
            gt(verificationTokens.expiresAt, now)
          )
        )
        .returning({ id: verificationTokens.id })
    )
    return rows.length === 1
  }
}
