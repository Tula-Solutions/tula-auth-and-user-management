import { apiKeys, type Database } from '@tula/db'
import { and, desc, eq, sql } from 'drizzle-orm'
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
  async insert(key: NewApiKey): Promise<ApiKeyRecord> {
    const [row] = await this.db
      .insert(apiKeys)
      .values({ ...key, updatedAt: key.createdAt })
      .returning(columns)
    if (!row) {
      throw new Error('api key insert returned no row')
    }
    return row
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
  async touch(id: string, at: Date): Promise<void> {
    // updated_at is left alone: usage is not an edit of the key.
    await this.db.update(apiKeys).set({ lastUsedAt: at }).where(eq(apiKeys.id, id))
  }

  /** @inheritdoc */
  async revoke(environmentId: string, id: string, at: Date): Promise<ApiKeyRecord | null> {
    const [row] = await this.db
      .update(apiKeys)
      // coalesce keeps the first revocation time, so revoking twice is idempotent.
      .set({
        revokedAt: sql`coalesce(${apiKeys.revokedAt}, ${at.toISOString()}::timestamptz)`,
        updatedAt: at,
      })
      .where(and(eq(apiKeys.id, id), eq(apiKeys.environmentId, environmentId)))
      .returning(columns)
    return row ?? null
  }
}
