import { type Jwk, JwkSchema } from '@tula/contract'
import { type Database, signingKeys, withTenant } from '@tula/db'
import { and, desc, eq } from 'drizzle-orm'
import * as logger from '~/lib/logger'
import {
  canVerify,
  type NewSigningKey,
  type RotationPlan,
  type SigningKeyRecord,
  type SigningKeyStore,
} from '~/ports/signing-key-store'

const columns = {
  id: signingKeys.id,
  projectId: signingKeys.projectId,
  environmentId: signingKeys.environmentId,
  status: signingKeys.status,
  publicJwk: signingKeys.publicJwk,
  privateKeyCiphertext: signingKeys.privateKeyCiphertext,
  createdAt: signingKeys.createdAt,
  activatedAt: signingKeys.activatedAt,
  retiredAt: signingKeys.retiredAt,
}

/** Thrown inside a transaction to roll it back when a guarded update matched nothing. */
class LostRace extends Error {}

/** Postgres unique-violation, whether raw (pg / PGlite) or wrapped by Drizzle in `cause`. */
function isUniqueViolation(error: unknown): boolean {
  for (let current = error; current instanceof Object; current = (current as Error).cause) {
    if ((current as { code?: unknown }).code === '23505') {
      return true
    }
  }
  return false
}

function toValues(environmentId: string, key: NewSigningKey) {
  // The kid is the row id; it is not duplicated inside the stored JSON.
  const { kid: _kid, ...publicJwk } = key.publicJwk
  return {
    id: key.id,
    projectId: key.projectId,
    environmentId,
    status: key.status,
    publicJwk,
    privateKeyCiphertext: key.privateKeyCiphertext,
    activatedAt: key.activatedAt,
    createdAt: key.createdAt,
    updatedAt: key.createdAt,
  }
}

/** Signing keys in `tula.signing_keys`, read and written inside the environment's RLS scope. */
export class PostgresSigningKeyStore implements SigningKeyStore {
  /** @param db - Database connected as the runtime role. */
  constructor(private readonly db: Database) {}

  /** @inheritdoc */
  async verificationKeys(environmentId: string, now: Date): Promise<Jwk[]> {
    const keys: Jwk[] = []
    for (const row of await this.#rows(environmentId)) {
      if (!canVerify(row, now)) {
        continue
      }
      const parsed = JwkSchema.safeParse({ ...row.publicJwk, kid: row.id })
      if (parsed.success) {
        keys.push(parsed.data)
      } else {
        logger.error('skipping malformed signing key', { environmentId, keyId: row.id })
      }
    }
    return keys
  }

  /** @inheritdoc */
  async list(environmentId: string): Promise<SigningKeyRecord[]> {
    const records: SigningKeyRecord[] = []
    for (const row of await this.#rows(environmentId)) {
      const parsed = JwkSchema.safeParse({ ...row.publicJwk, kid: row.id })
      if (parsed.success) {
        records.push({ ...row, publicJwk: parsed.data })
      } else {
        logger.error('skipping malformed signing key', { environmentId, keyId: row.id })
      }
    }
    return records
  }

  /** @inheritdoc */
  async insert(environmentId: string, keys: NewSigningKey[]): Promise<boolean> {
    try {
      await withTenant(this.db, environmentId, (tx) =>
        tx.insert(signingKeys).values(keys.map((key) => toValues(environmentId, key)))
      )
      return true
    } catch (error) {
      if (isUniqueViolation(error)) {
        return false
      }
      throw error
    }
  }

  /** @inheritdoc */
  async rotate(environmentId: string, plan: RotationPlan, at: Date): Promise<boolean> {
    try {
      await withTenant(this.db, environmentId, async (tx) => {
        // Order matters under the partial unique indexes: free the active slot, then the next
        // slot, then fill next again. Each update is guarded by the expected current status.
        const retired = await tx
          .update(signingKeys)
          .set({ status: 'retired', retiredAt: at, updatedAt: at })
          .where(and(eq(signingKeys.id, plan.retireId), eq(signingKeys.status, 'active')))
          .returning({ id: signingKeys.id })
        const activated = await tx
          .update(signingKeys)
          .set({ status: 'active', activatedAt: at, updatedAt: at })
          .where(and(eq(signingKeys.id, plan.activateId), eq(signingKeys.status, 'next')))
          .returning({ id: signingKeys.id })
        if (retired.length !== 1 || activated.length !== 1) {
          throw new LostRace()
        }
        await tx.insert(signingKeys).values(toValues(environmentId, plan.next))
      })
      return true
    } catch (error) {
      if (error instanceof LostRace || isUniqueViolation(error)) {
        return false
      }
      throw error
    }
  }

  #rows(environmentId: string) {
    return withTenant(this.db, environmentId, (tx) =>
      tx
        .select(columns)
        .from(signingKeys)
        // RLS already scopes rows; the explicit filter uses the index and is defence in depth.
        .where(eq(signingKeys.environmentId, environmentId))
        .orderBy(desc(signingKeys.createdAt), desc(signingKeys.id))
    )
  }
}
