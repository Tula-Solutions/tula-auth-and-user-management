import type { OAuthProvider } from '@tula/contract'
import type { Activity } from '~/ports/activity-log'

/** An environment's stored credentials for one provider. */
export interface OAuthProviderRecord {
  id: string
  projectId: string
  environmentId: string
  provider: OAuthProvider
  clientId: string
  /**
   * The provider's secret material, sealed (`~/lib/secret-box`, bound to environment and
   * provider). Never leaves the API.
   */
  secret: string
  /** Apple's team id and key id. Not secrets. */
  config: { teamId?: string; keyId?: string }
  enabled: boolean
  createdAt: Date
  updatedAt: Date
}

/** OAuth provider credentials, always read and written inside one environment. */
export interface OAuthProviderStore {
  /**
   * @param environmentId - The environment to look in.
   * @returns Every provider configured there.
   */
  list(environmentId: string): Promise<OAuthProviderRecord[]>

  /**
   * @param environmentId - The environment to look in.
   * @param provider - The provider.
   * @returns Its credentials, or `null` when it is not configured.
   */
  find(environmentId: string, provider: OAuthProvider): Promise<OAuthProviderRecord | null>

  /**
   * Store a provider's credentials, replacing the ones it has. One row per environment and
   * provider: the first write keeps `record.id` and `createdAt`, a later one keeps the row's.
   *
   * @param record - The credentials to store.
   * @param activity - Recorded in the same transaction.
   * @returns The row as stored.
   */
  upsert(record: OAuthProviderRecord, activity?: Activity): Promise<OAuthProviderRecord>

  /**
   * Remove a provider's credentials.
   *
   * @param environmentId - The environment.
   * @param provider - The provider.
   * @param activity - Recorded in the same transaction, only if something was removed.
   * @returns `false` when it was not configured.
   */
  delete(environmentId: string, provider: OAuthProvider, activity?: Activity): Promise<boolean>
}
