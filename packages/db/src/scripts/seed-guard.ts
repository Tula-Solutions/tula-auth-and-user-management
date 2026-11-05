/**
 * Decide whether the seed script may run.
 *
 * The seed creates a "Local" workspace and a production environment with no further checks, so
 * on a real deployment it would plant a tenant nobody asked for.
 *
 * @param env - The process environment.
 * @returns The message to print when the seed must not run, else `null`.
 */
export function seedRefusal(env: Record<string, string | undefined>): string | null {
  if (env.ENVIRONMENT === 'local' || env.ENVIRONMENT === 'dev') {
    return null
  }
  return 'seed: refused: it creates a workspace and environments for local development; set ENVIRONMENT to local or dev'
}
