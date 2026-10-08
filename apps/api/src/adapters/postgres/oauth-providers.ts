import type { OAuthProvider } from '@tula/contract'
import { type Database, oauthProviders, withTenant } from '@tula/db'
import { and, asc, eq } from 'drizzle-orm'
import { recordActivity } from '~/adapters/postgres/activity'
import { activityOf, type Recorded } from '~/ports/activity-log'
import type { OAuthProviderRecord, OAuthProviderStore } from '~/ports/oauth-provider-store'

const columns = {
  id: oauthProviders.id,
  projectId: oauthProviders.projectId,
  environmentId: oauthProviders.environmentId,
  provider: oauthProviders.provider,
  clientId: oauthProviders.clientId,
  secret: oauthProviders.secret,
  config: oauthProviders.config,
  enabled: oauthProviders.enabled,
  createdAt: oauthProviders.createdAt,
  updatedAt: oauthProviders.updatedAt,
}

/** OAuth provider credentials in Postgres, behind row-level security. */
export class PostgresOAuthProviderStore implements OAuthProviderStore {
  constructor(private readonly db: Database) {}

  async list(environmentId: string): Promise<OAuthProviderRecord[]> {
    return withTenant(this.db, environmentId, (tx) =>
      tx
        .select(columns)
        .from(oauthProviders)
        .where(eq(oauthProviders.environmentId, environmentId))
        .orderBy(asc(oauthProviders.provider))
    )
  }

  async find(environmentId: string, provider: OAuthProvider): Promise<OAuthProviderRecord | null> {
    const [row] = await withTenant(this.db, environmentId, (tx) =>
      tx
        .select(columns)
        .from(oauthProviders)
        .where(
          and(
            eq(oauthProviders.environmentId, environmentId),
            eq(oauthProviders.provider, provider)
          )
        )
        .limit(1)
    )
    return row ?? null
  }

  async upsert(record: OAuthProviderRecord, recorded: Recorded): Promise<OAuthProviderRecord> {
    const activity = activityOf(recorded)
    return withTenant(this.db, record.environmentId, async (tx) => {
      // One statement creates or replaces, so two concurrent first saves cannot both insert.
      const [row] = await tx
        .insert(oauthProviders)
        .values(record)
        .onConflictDoUpdate({
          target: [oauthProviders.environmentId, oauthProviders.provider],
          set: {
            clientId: record.clientId,
            secret: record.secret,
            config: record.config,
            enabled: record.enabled,
            updatedAt: record.updatedAt,
          },
        })
        .returning(columns)
      await recordActivity(tx, activity ? [activity] : [])
      // An upsert always returns its row.
      return row as OAuthProviderRecord
    })
  }

  async delete(
    environmentId: string,
    provider: OAuthProvider,
    recorded: Recorded
  ): Promise<boolean> {
    const activity = activityOf(recorded)
    return withTenant(this.db, environmentId, async (tx) => {
      const rows = await tx
        .delete(oauthProviders)
        .where(
          and(
            eq(oauthProviders.environmentId, environmentId),
            eq(oauthProviders.provider, provider)
          )
        )
        .returning({ id: oauthProviders.id })
      const deleted = rows.length === 1
      await recordActivity(tx, deleted && activity ? [activity] : [])
      return deleted
    })
  }
}
