import { apiKeys, type Database } from '@tula/db'
import { eq } from 'drizzle-orm'
import type { ApiKeyRepository, StoredApiKey } from '~/ports/api-key-repository'

/** API keys in `tula.api_keys` (the one tenant-column table without RLS; see its schema). */
export class PostgresApiKeyRepository implements ApiKeyRepository {
  /** @param db - Database connected as the runtime role. */
  constructor(private readonly db: Database) {}

  /** @inheritdoc */
  async findByHash(keyHash: string): Promise<StoredApiKey | null> {
    const [row] = await this.db
      .select({
        id: apiKeys.id,
        kind: apiKeys.kind,
        projectId: apiKeys.projectId,
        environmentId: apiKeys.environmentId,
        revokedAt: apiKeys.revokedAt,
      })
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, keyHash))
      .limit(1)
    return row ?? null
  }
}
