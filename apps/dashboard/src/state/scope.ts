import { create } from 'zustand'

/** The workspace, project and environment the operator is looking at. Ids only. */
export interface Scope {
  workspaceId: string | null
  projectId: string | null
  environmentId: string | null
}

interface ScopeState extends Scope {
  /** Replace the selection (the address bar is the source; this mirrors it). */
  set: (scope: Scope) => void
}

/**
 * The current selection, mirrored from the route's parameters.
 *
 * The address is the source of truth (a link is shareable and survives a reload); this store
 * exists so that code outside a route (the API mutator, the navigation on instance pages)
 * can read it. It holds ids, never a credential.
 */
export const useScope = create<ScopeState>((set) => ({
  workspaceId: null,
  projectId: null,
  environmentId: null,
  set: (scope) => set(scope),
}))

/** The part of a query client {@link syncScope} uses. */
export interface ScopeQueryCache {
  removeQueries: (filters: {
    predicate: (query: { queryKey: readonly unknown[] }) => boolean
  }) => void
}

/**
 * Make the store say what the address says, before anything of the route renders.
 *
 * Admin queries are keyed by their path, not by environment (the environment travels in a
 * header), so when the environment changes every cached admin answer is dropped: one
 * environment's users must never be drawn under another's name.
 *
 * @param cache - The query client.
 * @param scope - The ids from the route's parameters.
 */
export function syncScope(cache: ScopeQueryCache, scope: Scope): void {
  const current = useScope.getState()
  if (current.environmentId !== scope.environmentId) {
    cache.removeQueries({
      predicate: (query) =>
        typeof query.queryKey[0] === 'string' && query.queryKey[0].startsWith('/v1/admin/'),
    })
  }
  if (
    current.workspaceId !== scope.workspaceId ||
    current.projectId !== scope.projectId ||
    current.environmentId !== scope.environmentId
  ) {
    current.set(scope)
  }
}
