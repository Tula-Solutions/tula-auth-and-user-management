import { pgSchema } from 'drizzle-orm/pg-core'

/**
 * Every Tula table lives in the `tula` Postgres schema so embedded mode (§5.6) can share a
 * customer's database without colliding with their own tables.
 */
export const tula = pgSchema('tula')
