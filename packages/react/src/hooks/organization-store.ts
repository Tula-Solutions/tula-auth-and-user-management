import type {
  ActiveOrganization,
  CreateOrganizationInput,
  TulaClient,
  TulaError,
  UserOrganization,
  UserOrganizationList,
} from '@tula-tech/core'
import { toTulaError } from '../errors'

// What `useOrganization` and `useOrganizationList` share: one list of the user's organizations
// per client, fetched once however many components ask, and kept only for the session it was
// fetched for. A result that arrives for an older session is never shown (react.md, "A result
// belongs to the session it was asked for").

/** What the store holds, and for which session. Replaced, never changed, so it can be a snapshot. */
export interface OrganizationSnapshot {
  /** The session the rest was fetched for; `null` when nothing was. */
  sessionId: string | null
  /** The first page of the user's organizations, once it has arrived. */
  list: UserOrganizationList | null
  isLoading: boolean
  /** Why the last fetch failed, or `null`. */
  error: TulaError | null
}

const EMPTY: OrganizationSnapshot = Object.freeze({
  sessionId: null,
  list: null,
  isLoading: false,
  error: null,
})

/** The store of one client. */
export interface OrganizationStore {
  /** The current snapshot: the same object until something changes. */
  snapshot(): OrganizationSnapshot
  subscribe(listener: () => void): () => void
  /** Fetch the list for `sessionId` unless it is held or on its way; joins a request in flight. */
  load(sessionId: string, options?: { force?: boolean }): Promise<void>
  setActive(organizationId: string | null): Promise<ActiveOrganization>
  create(input: CreateOrganizationInput): Promise<UserOrganization>
}

const stores = new WeakMap<TulaClient, OrganizationStore>()

/** The session a client has right now, read at the moment of asking. */
function currentSession(client: TulaClient): string | null {
  return client.state.status === 'signed-in' ? client.state.sessionId : null
}

/**
 * The store of a client.
 *
 * @param client - The client of the provider.
 * @returns Its store: the same one for every call with the same client.
 */
export function organizationStore(client: TulaClient): OrganizationStore {
  const known = stores.get(client)
  if (known) {
    return known
  }
  let state: OrganizationSnapshot = EMPTY
  let inFlight: { sessionId: string; done: Promise<void> } | null = null
  // Moves when this client chooses an organization: a list asked for before the choice is older
  // than the choice and must not undo it.
  let generation = 0
  const listeners = new Set<() => void>()
  const set = (next: OrganizationSnapshot) => {
    state = next
    for (const listener of [...listeners]) {
      listener()
    }
  }

  // Whoever signed in before, their organizations are not the next one's: drop them as soon
  // as the session changes, not when somebody asks again.
  client.onChange(() => {
    if (state.sessionId !== null && state.sessionId !== currentSession(client)) {
      generation += 1
      inFlight = null
      set(EMPTY)
    }
  })

  const store: OrganizationStore = {
    snapshot: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    load(sessionId, options = {}) {
      if (currentSession(client) !== sessionId) {
        return Promise.resolve()
      }
      if (inFlight?.sessionId === sessionId) {
        return inFlight.done
      }
      if (state.sessionId === sessionId && state.list !== null && !options.force) {
        return Promise.resolve()
      }
      const startedAt = generation
      set({
        sessionId,
        list: state.sessionId === sessionId ? state.list : null,
        isLoading: true,
        error: null,
      })
      const run = async () => {
        try {
          const list = await client.organizations.list()
          if (currentSession(client) === sessionId && state.sessionId === sessionId) {
            // A choice made while this was on its way is newer than the list's own word about
            // which organization is active; the organizations in it are still current.
            const chosen = generation !== startedAt && client.state.status === 'signed-in'
            set({
              sessionId,
              list: chosen
                ? {
                    ...list,
                    activeOrganizationId:
                      client.state.status === 'signed-in' ? client.state.organizationId : null,
                  }
                : list,
              isLoading: false,
              error: null,
            })
          }
        } catch (caught) {
          if (currentSession(client) === sessionId && state.sessionId === sessionId) {
            set({ ...state, isLoading: false, error: toTulaError(caught) })
          }
        } finally {
          if (inFlight?.done === done) {
            inFlight = null
          }
        }
      }
      const done = run()
      inFlight = { sessionId, done }
      return done
    },
    async setActive(organizationId) {
      const startedFor = currentSession(client)
      const answer = await client.organizations.setActive(organizationId)
      if (
        startedFor !== null &&
        state.sessionId === startedFor &&
        currentSession(client) === startedFor
      ) {
        generation += 1
        if (state.list) {
          set({ ...state, list: { ...state.list, activeOrganizationId: answer.organizationId } })
        }
      }
      return answer
    },
    async create(input) {
      const startedFor = currentSession(client)
      const created = await client.organizations.create(input)
      if (startedFor !== null && currentSession(client) === startedFor) {
        await store.load(startedFor, { force: true })
      }
      return created
    },
  }
  stores.set(client, store)
  return store
}

/**
 * The snapshot for one session: the store's own when it was fetched for that session, and
 * nothing otherwise.
 *
 * @param snapshot - The store's snapshot.
 * @param sessionId - The session the caller is rendering for, or `null`.
 * @returns The snapshot, or an empty one.
 */
export function snapshotFor(
  snapshot: OrganizationSnapshot,
  sessionId: string | null
): OrganizationSnapshot {
  return sessionId !== null && snapshot.sessionId === sessionId ? snapshot : EMPTY
}
