import { timestamp, uuid } from 'drizzle-orm/pg-core'

/**
 * UUID v7 primary key (time-ordered, so inserts stay index-friendly).
 *
 * The API normally supplies ids through its `IdGenerator` port; this default only covers direct
 * inserts (seeds, scripts).
 *
 * @returns An `id` column definition.
 */
export function primaryKey() {
  return uuid('id')
    .primaryKey()
    .$defaultFn(() => Bun.randomUUIDv7())
}

/**
 * `created_at` / `updated_at` timestamps (timestamptz, JS `Date`).
 *
 * @returns The two column definitions, to spread into a table.
 */
export function timestamps() {
  return {
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  }
}
