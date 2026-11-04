import type { Actor } from '~/lib/actor'
import * as SsoConnections from '~/modules/sso-connection/service'

type Deps = Parameters<typeof SsoConnections.markTested>[0]
type Tenant = Parameters<typeof SsoConnections.markTested>[1]

/**
 * Mark a connection as having passed a test sign-in of its current settings, which activation
 * requires (TULA-145). For tests that are about something after activation; the test round
 * itself is exercised through the mock identity provider in `modules/sso-test`.
 *
 * @param deps - The connection store and clock.
 * @param tenant - The environment.
 * @param id - The connection.
 * @param actor - The actor of the audit entry.
 */
export async function passTest(deps: Deps, tenant: Tenant, id: string, actor: Actor) {
  const current = await deps.ssoConnections.find(tenant.environmentId, id)
  if (!current) {
    throw new Error('no such connection')
  }
  await SsoConnections.markTested(deps, tenant, id, SsoConnections.fingerprint(current), actor)
}
