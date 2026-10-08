import type { IdGenerator } from '~/ports/id-generator'

/** Time-ordered UUID v7 ids, matching the database's `uuidv7()` default. */
export const uuidV7Ids: IdGenerator = {
  next: () => Bun.randomUUIDv7(),
}
