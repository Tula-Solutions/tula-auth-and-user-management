import {
  hasOrganizationAccess,
  type OrganizationCheck,
  readOrganizationClaims,
} from '@tula-tech/contract/custom-claims'
import type {
  ActiveOrganization,
  CreateOrganizationInput,
  TulaError,
  UserOrganization,
} from '@tula-tech/core'
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import { useTulaContext } from '../context'
import { organizationStore, snapshotFor } from './organization-store'
import { useAuthState } from './use-auth-state'

/** The store of the provider's client, as a subscribed snapshot for one session. */
function useOrganizationSnapshot(sessionId: string | null) {
  const { client } = useTulaContext()
  const store = organizationStore(client)
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.snapshot,
    // A server render and hydration know no list.
    () => snapshotFor(store.snapshot(), null)
  )
  return { client, store, snapshot: snapshotFor(snapshot, sessionId) }
}

/**
 * What {@link useOrganization} returns.
 *
 * @example
 * ```ts
 * const { organization, has }: UseOrganizationResult = useOrganization()
 * ```
 */
export interface UseOrganizationResult {
  /**
   * Whether the active organization is known: someone is signed in and either no organization
   * is active or its role has arrived. `false` while loading and when the fetch failed (see
   * `error`).
   */
  isLoaded: boolean
  /** The active organization's id, or `null` (the personal account, or organizations are off). */
  organizationId: string | null
  /**
   * The active organization with the user's role and its permissions, once loaded; `null`
   * with none active, while loading, and when the user is no longer a member of it.
   */
  organization: UserOrganization | null
  /** The key of the user's role in it, or `null`. */
  role: string | null
  /** The permission keys of that role, as of the last load; empty with none. */
  permissions: readonly string[]
  /**
   * Whether the active organization grants a permission or a role. **False** with no active
   * organization, before it has loaded, and for any answer that belongs to another session.
   * A permission is matched exactly: no wildcard, and `manage` does not imply `read`.
   *
   * This decides what to show. Your server decides what to allow: it checks the same keys
   * from the access token's claims (`auth().has()` in `@tula-tech/nextjs`).
   *
   * @param check - `{ permission: 'org:billing:read' }` or `{ role: 'admin' }`.
   * @returns Whether it is granted.
   */
  has(check: OrganizationCheck): boolean
  /** Whether the list is being fetched. */
  isLoading: boolean
  /** Why the last fetch failed (`organization.disabled`, a network error), or `null`. */
  error: TulaError | null
  /** Fetch the organizations again (after a role changed, say). */
  reload(): Promise<void>
}

/**
 * The organization the session acts in, with the user's role and permissions in it, and a
 * `has()` to check them. Keyed to the session: nothing fetched for another session is ever
 * shown, and `has()` answers false for a session that has ended.
 *
 * The id comes from the client's state (the access token's `org_id`); the role and the
 * permissions from the user's organization list, which is fetched once however many
 * components use this hook or {@link useOrganizationList}, and only while an organization is
 * active.
 *
 * @returns The active organization and `has()`.
 * @throws Error outside a `<TulaProvider>`.
 *
 * @example
 * ```tsx
 * function BillingLink() {
 *   const { organization, has } = useOrganization()
 *   if (!organization || !has({ permission: 'org:billing:read' })) {
 *     return null
 *   }
 *   return <a href='/billing'>Billing for {organization.name}</a>
 * }
 * ```
 */
export function useOrganization(): UseOrganizationResult {
  const { client } = useTulaContext()
  const state = useAuthState(client)
  const sessionId = state.status === 'signed-in' ? state.sessionId : null
  const organizationId = state.status === 'signed-in' ? state.organizationId : null
  const { store, snapshot } = useOrganizationSnapshot(sessionId)

  useEffect(() => {
    if (sessionId !== null && organizationId !== null) {
      void store.load(sessionId)
    }
  }, [store, sessionId, organizationId])

  const organization = useMemo(
    () =>
      organizationId === null
        ? null
        : (snapshot.list?.data.find((entry) => entry.id === organizationId) ?? null),
    [snapshot.list, organizationId]
  )
  // The same grammar and bounds as the claims of a token: a malformed answer is no role.
  const claims = useMemo(
    () =>
      organization
        ? readOrganizationClaims({
            org_id: organization.id,
            org_role: organization.role,
            org_perms: organization.permissions,
          })
        : null,
    [organization]
  )
  const has = useCallback(
    (check: OrganizationCheck) =>
      sessionId !== null &&
      client.state.status === 'signed-in' &&
      client.state.sessionId === sessionId &&
      hasOrganizationAccess(claims, check),
    [client, sessionId, claims]
  )
  const reload = useCallback(
    async () => (sessionId === null ? undefined : store.load(sessionId, { force: true })),
    [store, sessionId]
  )
  return {
    isLoaded: sessionId !== null && (organizationId === null || snapshot.list !== null),
    organizationId,
    organization,
    role: claims?.orgRole ?? null,
    permissions: claims?.orgPermissions ?? [],
    has,
    isLoading: snapshot.isLoading,
    error: snapshot.error,
    reload,
  }
}

/**
 * What {@link useOrganizationList} returns.
 *
 * @example
 * ```ts
 * const { organizations, setActive }: UseOrganizationListResult = useOrganizationList()
 * ```
 */
export interface UseOrganizationListResult {
  /** Whether the list has arrived for this session. */
  isLoaded: boolean
  /**
   * The organizations the user belongs to, with their role and its permissions in each (the
   * first page the API answers); `null` until loaded.
   */
  organizations: UserOrganization[] | null
  /** The id of the organization the session acts in, or `null`. */
  activeOrganizationId: string | null
  /** Whether the list is being fetched. */
  isLoading: boolean
  /** Why the last fetch failed, or `null`. */
  error: TulaError | null
  /** Fetch the list again. */
  reload(): Promise<void>
  /**
   * Make an organization the session's active one, or clear it with `null`. The access token
   * is replaced with one that carries the new organization.
   *
   * @param organizationId - The organization, or `null` for the personal account.
   * @returns The API's answer.
   * @throws TulaError `organization.not_a_member`, `organization.personal_account_disabled`.
   */
  setActive(organizationId: string | null): Promise<ActiveOrganization>
  /**
   * Create an organization the user owns, then refresh the list. The session does not switch
   * to it: call `setActive`.
   *
   * @param input - The name and the slug.
   * @returns The organization.
   * @throws TulaError `organization.creation_disabled`, `organization.limit_reached`,
   *   `organization.slug_taken`.
   */
  create(input: CreateOrganizationInput): Promise<UserOrganization>
}

/**
 * The organizations the signed-in user belongs to, the active one, and the actions that
 * switch or add one. The list is fetched when the hook mounts with a signed-in user, once
 * however many components use it, and it is dropped the moment the session changes.
 *
 * @returns The list and its actions.
 * @throws Error outside a `<TulaProvider>`.
 *
 * @example
 * ```tsx
 * function Switcher() {
 *   const { organizations, activeOrganizationId, setActive } = useOrganizationList()
 *   return (
 *     <select
 *       value={activeOrganizationId ?? ''}
 *       onChange={(event) => setActive(event.target.value || null)}
 *     >
 *       <option value=''>Personal account</option>
 *       {organizations?.map((org) => (
 *         <option key={org.id} value={org.id}>{org.name}</option>
 *       ))}
 *     </select>
 *   )
 * }
 * ```
 */
export function useOrganizationList(): UseOrganizationListResult {
  const { client } = useTulaContext()
  const state = useAuthState(client)
  const sessionId = state.status === 'signed-in' ? state.sessionId : null
  const { store, snapshot } = useOrganizationSnapshot(sessionId)

  useEffect(() => {
    if (sessionId !== null) {
      void store.load(sessionId)
    }
  }, [store, sessionId])

  const reload = useCallback(
    async () => (sessionId === null ? undefined : store.load(sessionId, { force: true })),
    [store, sessionId]
  )
  return {
    isLoaded: snapshot.list !== null,
    organizations: snapshot.list?.data ?? null,
    activeOrganizationId: state.status === 'signed-in' ? state.organizationId : null,
    isLoading: snapshot.isLoading,
    error: snapshot.error,
    reload,
    setActive: store.setActive,
    create: store.create,
  }
}
