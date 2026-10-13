import type { AdminClient, AdminOperations, OperationRoute } from '@tula-tech/admin'
import { OPERATIONS } from '@tula-tech/admin'
import { UPSTREAM_TIMEOUT_MS } from './read-only'

/**
 * Every operation of the API a tool can reach that is not a read: the allow-list of the
 * proposing facade (ADR 0053). Each one **asks** for a change and changes nothing: it is a
 * `POST` under `/v1/agent/`, the route group an agent key is accepted on. No operation of
 * `/v1/admin/*` may ever be here, and approving a proposal is not here and never will be:
 * that is a human's act, made with a credential this server does not hold.
 *
 * @example
 * ```ts
 * PROPOSE_OPERATIONS // ['createProposal']
 * ```
 */
export const PROPOSE_OPERATIONS = [
  'createProposal',
] as const satisfies readonly (keyof AdminOperations)[]

/**
 * Id of an operation the proposing facade may call.
 *
 * @example
 * ```ts
 * const id: ProposeOperationId = 'createProposal'
 * ```
 */
export type ProposeOperationId = (typeof PROPOSE_OPERATIONS)[number]

/** Where every operation of the facade lives: the route group that takes an agent key. */
const AGENT_PATH_PREFIX = '/v1/agent/'

/** The body the API takes a proposal as: what {@link PROPOSABLE} is held to. */
type ProposalBody = AdminOperations['createProposal']['body']

/**
 * The operations a tool may propose, each with the kind of thing it acts on. Closed: a new
 * proposal is an entry here, a tool, and the server's own list (`PROPOSAL_OPERATIONS` in
 * `@tula-tech/contract`), which is what decides. The type holds the keys to the API's own
 * enumeration: one missing, or one the API does not have, does not compile.
 *
 * Every one of them can be undone by an administrator, acts on **one** thing, and neither
 * returns nor sets a secret: a user is banned or their ban lifted, one session is ended,
 * one provider is switched off (never on, never removed, never given a credential).
 * Nothing that deletes, nothing that acts on a list, and nothing that could hand out or
 * replace a key, a password or a provider's secret is ever an entry (ADR 0053).
 *
 * @example
 * ```ts
 * PROPOSABLE.ban_user // 'user'
 * PROPOSABLE.disable_oauth_provider // 'oauth_provider'
 * ```
 */
export const PROPOSABLE = {
  ban_user: 'user',
  unban_user: 'user',
  end_session: 'session',
  disable_oauth_provider: 'oauth_provider',
} as const satisfies Readonly<Record<ProposalBody['operation'], ProposalBody['target']['type']>>

/**
 * What a tool may ask for: one operation of {@link PROPOSABLE} and the one thing it acts
 * on, **of that operation's own kind**. A ban names a user and never a session; a session
 * is ended by its own id and never by its user; a target is one id, never a list.
 *
 * @example
 * ```ts
 * const request: ProposalRequest = { operation: 'ban_user', target: { type: 'user', id: userId } }
 * ```
 */
export type ProposalRequest = {
  [Operation in keyof typeof PROPOSABLE]: {
    operation: Operation
    target: { type: (typeof PROPOSABLE)[Operation]; id: string }
  }
}[keyof typeof PROPOSABLE]

/**
 * What a target is named by: an id, or a provider's name. One run of what those are made
 * of and nothing else is put in a body; the server decides whether it names anything.
 */
const TARGET_ID = /^[A-Za-z0-9_-]{1,64}$/

/**
 * The only way a tool asks for a change: one function, which records a proposal. It has no
 * `call`, takes no header, no method and no path, and does not hand out the client it wraps.
 * It is a separate object from {@link ReadOnlyAdmin}, built by a separate function over a
 * separate allow-list: nothing was added to the read-only facade to make it.
 *
 * @example
 * ```ts
 * const proposal = await proposals.propose({ operation: 'ban_user', target: { type: 'user', id } })
 * // proposal.status === 'pending': nothing has changed.
 * ```
 */
export interface ProposingAdmin {
  /**
   * Ask for one change. Nothing happens until a human approves it elsewhere.
   *
   * @param request - The operation and its target.
   * @param options - A signal that abandons the request.
   * @returns The proposal, exactly as the API sent it: project it before returning it.
   * @throws TulaAdminError as the admin client does.
   * @throws Error when the operation is not one a tool may propose, or its target is not of
   *   that operation's kind (a programming error; nothing is sent).
   */
  propose(
    request: ProposalRequest,
    options?: { signal?: AbortSignal }
  ): Promise<AdminOperations['createProposal']['response']>
}

/**
 * Wrap an agent's client so that the only thing a tool can do through it, beside nothing, is
 * ask for a change.
 *
 * The allow-list is enforced three times, as the read-only facade's is: by the type of
 * `propose`, by a check of the operation and the target on every call, and here, once, by
 * checking that every allow-listed id is a `POST` under `/v1/agent/` in the client's
 * operation table. An id that moved to another route group, or changed method, in a later
 * contract is refused when the facade is made rather than called.
 *
 * The client is the one `createAgentClient` makes: it holds an agent key, which the server
 * refuses on every write and on the approval. The facade would be as closed over an admin
 * client; the server would then refuse the proposal itself (a secret key cannot propose).
 *
 * @param agent - The agent's client, holding the agent key.
 * @param operations - The operation table to check the allow-list against.
 * @param timeoutMs - The timeout of each request.
 * @returns The facade.
 * @throws Error when an allow-listed operation is not a `POST` under `/v1/agent/`.
 *
 * @example
 * ```ts
 * const proposals = proposingAdmin(createAgentClient({ baseUrl, agentKey }))
 * await proposals.propose({ operation: 'ban_user', target: { type: 'user', id: userId } })
 * ```
 */
export function proposingAdmin(
  agent: AdminClient,
  operations: Readonly<Record<string, OperationRoute>> = OPERATIONS,
  timeoutMs: number = UPSTREAM_TIMEOUT_MS
): ProposingAdmin {
  for (const id of PROPOSE_OPERATIONS) {
    const route = Object.hasOwn(operations, id) ? operations[id] : undefined
    if (route?.method !== 'POST' || !route.path.startsWith(AGENT_PATH_PREFIX)) {
      throw new Error(`${id} is on the propose allow-list but is not a POST under /v1/agent/`)
    }
  }
  const call = agent.call.bind(agent) as (
    id: ProposeOperationId,
    input: Record<string, unknown>
  ) => Promise<{ data: unknown }>
  return Object.freeze({
    async propose(
      request: ProposalRequest,
      options?: { signal?: AbortSignal }
    ): Promise<AdminOperations['createProposal']['response']> {
      const operation: unknown = request?.operation
      const target = request?.target as { type?: unknown; id?: unknown } | undefined
      if (typeof operation !== 'string' || !Object.hasOwn(PROPOSABLE, operation)) {
        throw new Error('not an operation a tool may propose')
      }
      const kind = PROPOSABLE[operation as keyof typeof PROPOSABLE]
      if (target?.type !== kind || typeof target.id !== 'string' || !TARGET_ID.test(target.id)) {
        throw new Error('not a target of that operation')
      }
      // The body is built here, field by field, from values that were just checked: never
      // an object of the caller's, never a header, a method, a path or a timeout of theirs.
      const answer = await call('createProposal', {
        body: { operation, target: { type: kind, id: target.id } },
        ...(options?.signal instanceof AbortSignal ? { signal: options.signal } : {}),
        timeoutMs,
      })
      return answer.data as AdminOperations['createProposal']['response']
    },
  })
}

/**
 * The same facade with a signal added to every proposal: what a tool call is given, so that
 * a call that is cancelled or runs out of time takes its request with it.
 *
 * @param proposals - The facade.
 * @param signal - Aborted when the tool call is over.
 * @returns A facade whose requests end when `signal` aborts.
 *
 * @example
 * ```ts
 * const controller = new AbortController()
 * const proposals = proposingWithSignal(proposingAdmin(agent), controller.signal)
 * ```
 */
export function proposingWithSignal(
  proposals: ProposingAdmin,
  signal: AbortSignal
): ProposingAdmin {
  return Object.freeze({
    propose: (request: ProposalRequest) => proposals.propose(request, { signal }),
  })
}
