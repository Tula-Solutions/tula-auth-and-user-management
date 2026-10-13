// Imports nothing, on purpose: `scripts/worker-check/` reads this file by path, outside the
// API's own module resolution (no `~/`), to wait against the server's number and not a copy.

/**
 * How long an event may wait to be queued for delivery before the `webhook_worker` check
 * says so. A delivery round runs every five seconds and settles every waiting event, owed to
 * an endpoint or to nobody: one that has waited twelve rounds was not looked at by any.
 */
export const WEBHOOK_WAITING_TOO_LONG_MS = 60_000
