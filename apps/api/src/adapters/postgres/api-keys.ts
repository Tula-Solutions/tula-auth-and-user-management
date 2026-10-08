import { apiKeys, type Database, withTenant } from '@tula/db'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { recordActivity } from '~/adapters/postgres/activity'
import { activityOf, type Recorded } from '~/ports/activity-log'
import type { ApiKeyRecord, ApiKeyRepository, NewApiKey } from '~/ports/api-key-repository'

// Every column except key_hash: the hash never leaves this adapter.
const columns = {
  id: apiKeys.id,
  kind: apiKeys.kind,
  name: apiKeys.name,
  projectId: apiKeys.projectId,
  environmentId: apiKeys.environmentId,
  lastFour: apiKeys.lastFour,
  createdAt: apiKeys.createdAt,
  lastUsedAt: apiKeys.lastUsedAt,
  revokedAt: apiKeys.revokedAt,
}

/**
 * API keys in `tula.api_keys`. The table has no RLS, so every query except `findByHash` filters by
 * environment explicitly (see the port).
 */
export class PostgresApiKeyRepository implements ApiKeyRepository {
  /** @param db - Database connected as the runtime role. */
  constructor(private readonly db: Database) {}

  /** @inheritdoc */
  async findByHash(keyHash: string): Promise<ApiKeyRecord | null> {
    const [row] = await this.db
      .select(columns)
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, keyHash))
      .limit(1)
    return row ?? null
  }

  /** @inheritdoc */
  async insert(key: NewApiKey, recorded: Recorded): Promise<ApiKeyRecord> {
    const activity = activityOf(recorded)
    // `api_keys` has no RLS, but the activity tables do: the tenant scope is for them.
    return withTenant(this.db, key.environmentId, async (tx) => {
      const [row] = await tx
        .insert(apiKeys)
        .values({ ...key, updatedAt: key.createdAt })
        .returning(columns)
      if (!row) {
        throw new Error('api key insert returned no row')
      }
      await recordActivity(tx, activity ? [activity] : [])
      return row
    })
  }

  /** @inheritdoc */
  async listByEnvironment(environmentId: string): Promise<ApiKeyRecord[]> {
    return this.db
      .select(columns)
      .from(apiKeys)
      .where(eq(apiKeys.environmentId, environmentId))
      .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id))
  }

  /** @inheritdoc */
  async countByEnvironment(environmentId: string): Promise<{ active: number; total: number }> {
    const [row] = await this.db
      .select({
        active: sql<number>`count(*) filter (where ${apiKeys.revokedAt} is null)::int`,
        total: sql<number>`count(*)::int`,
      })
      .from(apiKeys)
      .where(eq(apiKeys.environmentId, environmentId))
    return { active: row?.active ?? 0, total: row?.total ?? 0 }
  }

  /** @inheritdoc */
  async touch(id: string, at: Date): Promise<void> {
    // The id comes from `findByHash`, never from a client, which is why this one write is not
    // filtered by environment. (`updated_at` moves too: the column updates itself on any write.)
    await this.db.update(apiKeys).set({ lastUsedAt: at }).where(eq(apiKeys.id, id))
  }

  /** @inheritdoc */
  async revoke(
    environmentId: string,
    id: string,
    at: Date,
    recorded: Recorded
  ): Promise<ApiKeyRecord | null> {
    const activity = activityOf(recorded)
    const isKey = and(eq(apiKeys.id, id), eq(apiKeys.environmentId, environmentId))
    return withTenant(this.db, environmentId, async (tx) => {
      // Guarded so revoking twice keeps the first revocation time and is recorded once.
      const [revoked] = await tx
        .update(apiKeys)
        .set({ revokedAt: at, updatedAt: at })
        .where(and(isKey, isNull(apiKeys.revokedAt)))
        .returning(columns)
      if (revoked) {
        await recordActivity(tx, activity ? [activity] : [])
        return revoked
      }
      const [existing] = await tx.select(columns).from(apiKeys).where(isKey).limit(1)
      return existing ?? null
    })
  }
}
