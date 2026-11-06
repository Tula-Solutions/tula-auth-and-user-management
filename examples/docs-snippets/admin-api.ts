// The first call shown in docs/admin-api.md, through `@tula-tech/admin`. Copied by region
// (`bun run docs:generate`) and compiled by `bun run typecheck:scripts`. Nothing here runs.

// #region first-call
import { createAdminClient } from '@tula-tech/admin'

// Server-side only: the secret key can do anything in its environment.
const admin = createAdminClient({
  baseUrl: process.env.TULA_API_URL ?? 'https://auth.example.com',
  secretKey: process.env.TULA_SECRET_KEY ?? '',
})

const { data: users } = await admin.call('listUsers', { query: { size: 10 } })

// #endregion

export { users }
