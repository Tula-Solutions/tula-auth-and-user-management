import { type Jwk, JwkSchema } from '@tula/contract'
import { type Database, signingKeys, withTenant } from '@tula/db'
import { eq } from 'drizzle-orm'
import * as logger from '~/lib/logger'
import { canVerify, type SigningKeyStore } from '~/ports/signing-key-store'

/** Public keys from `tula.signing_keys`, read inside the environment's RLS scope. */
export class PostgresSigningKeyStore implements SigningKeyStore {
  /** @param db - Database connected as the runtime role. */
  constructor(private readonly db: Database) {}

  /** @inheritdoc */
  async verificationKeys(environmentId: string, now: Date): Promise<Jwk[]> {
    const rows = await withTenant(this.db, environmentId, (tx) =>
      tx
        .select({
          id: signingKeys.id,
          publicJwk: signingKeys.publicJwk,
          status: signingKeys.status,
          retiredAt: signingKeys.retiredAt,
        })
        .from(signingKeys)
        // RLS already scopes rows; the explicit filter uses the index and is defence in depth.
        .where(eq(signingKeys.environmentId, environmentId))
    )
    const keys: Jwk[] = []
    for (const row of rows) {
      if (!canVerify(row, now)) {
        continue
      }
      // The row id is the kid (see the table's docs), whatever the stored JSON claims.
      const parsed = JwkSchema.safeParse({ ...row.publicJwk, kid: row.id })
      if (parsed.success) {
        keys.push(parsed.data)
      } else {
        logger.error('skipping malformed signing key', { environmentId, keyId: row.id })
      }
    }
    return keys
  }
}
