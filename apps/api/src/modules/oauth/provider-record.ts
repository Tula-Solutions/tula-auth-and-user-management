import { MicrosoftTenantSchema } from '@tula/contract'
import type { OAuthProviderRecord } from '~/ports/oauth-provider-store'

// What a stored provider row is good for. Apart from the service so that the settings
// service, which the OAuth service imports, can ask the same question without a cycle.

/**
 * The stored field that makes a provider's credentials unusable as they are, if any.
 *
 * Microsoft's `tenant` becomes a path segment of Microsoft's endpoints and decides whose
 * accounts sign in. The admin route stores only what `MicrosoftTenantSchema` returns; a row
 * that holds anything else (written before a rule, or changed in the database) is not
 * repaired or guessed at.
 *
 * @param record - The stored provider.
 * @returns The field's name, or `null` when nothing stored rules the provider out.
 */
export function unusableField(record: OAuthProviderRecord): 'tenant' | null {
  if (record.provider !== 'microsoft') {
    return null
  }
  const tenant = MicrosoftTenantSchema.safeParse(record.config.tenant)
  // Exactly the stored spelling: the schema trims and lower-cases, the adapter does neither.
  return tenant.success && tenant.data === record.config.tenant ? null : 'tenant'
}

/**
 * Whether a stored provider is a way to sign in: switched on, and with nothing stored that
 * rules it out ({@link unusableField}).
 *
 * **The one definition** behind every count of an environment's ways to sign in (what a
 * sign-in offers, "at least one sign-in method", a user's last way in). A row every start of
 * which answers `auth.method_disabled` must not be what lets the last working method be
 * switched off. A secret that no longer opens is not looked at here: finding that out means
 * opening it, and these counts run on the request path (ADR 0026).
 *
 * @param record - The stored provider.
 * @returns `true` when the provider counts.
 */
export function isSignInMethod(record: OAuthProviderRecord): boolean {
  return record.enabled && unusableField(record) === null
}
