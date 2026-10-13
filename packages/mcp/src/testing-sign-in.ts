import type { AdminClient, AdminOperations, OperationRoute } from '@tula/admin'
import { OPERATIONS } from '@tula/admin'

/**
 * The operations the sign-in test's facade may call, by the kind of client it wraps
 * (ADR 0058): one each, and they are the same run. An agent's client asks on the agent's
 * route and is recorded as the `agent`; an administrator's asks on the admin route. Neither
 * takes a body. Nothing else of the API may ever be here.
 *
 * @example
 * ```ts
 * TEST_OPERATIONS.agent // 'runSignInTest'
 * ```
 */
export const TEST_OPERATIONS = {
  agent: 'runSignInTest',
  admin: 'runSignInTestAsAdmin',
} as const satisfies Readonly<Record<string, keyof AdminOperations>>

/**
 * Which kind of client a tester wraps.
 *
 * @example
 * ```ts
 * const kind: SignInTesterKind = 'agent'
 * ```
 */
export type SignInTesterKind = keyof typeof TEST_OPERATIONS

/** Where each operation must be, exactly: a path that moved is refused when the facade is made. */
const TEST_ROUTES = {
  agent: '/v1/agent/sign-in-tests',
  admin: '/v1/admin/sign-in-tests',
} as const satisfies Readonly<Record<SignInTesterKind, string>>

/**
 * How long a run is waited for. The server ends a run's steps inside 40 seconds whatever
 * happens and then bounds its clean-up; this is longer than the two together, so that a
 * report that is coming is not abandoned. A request given up here leaves nothing behind:
 * the server finishes the run and deletes its user with nobody listening.
 *
 * @example
 * ```ts
 * signInTester(agent, 'agent', OPERATIONS, SIGN_IN_TEST_TIMEOUT_MS)
 * ```
 */
export const SIGN_IN_TEST_TIMEOUT_MS = 60_000

/**
 * The report of a run, as the API sent it.
 *
 * @example
 * ```ts
 * const report: SignInTestRun = await tester.run()
 * ```
 */
export type SignInTestRun = AdminOperations['runSignInTest']['response']

/**
 * The only way a tool runs a sign-in test: one function with nothing to say. It takes no
 * body, header, method, path or timeout of the caller's, and does not hand out the client it
 * wraps. It is a separate object from `ReadOnlyAdmin` and `ProposingAdmin`, built by a
 * separate function over a separate allow-list: nothing was added to either to make it.
 *
 * @example
 * ```ts
 * const report = await tester.run()
 * // report.steps: one entry per step; no token, code or address is in it.
 * ```
 */
export interface SignInTester {
  /**
   * Run one sign-in test in the key's environment.
   *
   * @param options - A signal that abandons the request. The server finishes the run, and
   *   deletes its user, whether or not anyone is still listening.
   * @returns The report, exactly as the API sent it: project it before returning it.
   * @throws TulaAdminError as the admin client does (`auth.forbidden` where the environment
   *   does not allow it, `rate_limited` when it has had its runs).
   */
  run(options?: { signal?: AbortSignal }): Promise<SignInTestRun>
}

/**
 * Wrap a client so that the only thing a tool can do through it is run a sign-in test.
 *
 * The allow-list is enforced three times, as the other facades' are: by the type (`run` has
 * no parameter that names an operation), on every call (the id is the constant of the kind
 * the facade was made for), and here, once, by checking that the id is a `POST` at exactly
 * its route in the client's operation table.
 *
 * @param client - The agent's client (`kind: 'agent'`) or the admin client (`'admin'`).
 * @param kind - Which of the two it is: it picks the operation, and nothing a tool says does.
 * @param operations - The operation table to check the allow-list against.
 * @param timeoutMs - The timeout of the request.
 * @returns The facade.
 * @throws Error when the kind is not one of the two, or its operation is not a `POST` at its
 *   route.
 *
 * @example
 * ```ts
 * const tester = signInTester(createAgentClient({ baseUrl, agentKey }), 'agent')
 * const report = await tester.run()
 * ```
 */
export function signInTester(
  client: AdminClient,
  kind: SignInTesterKind,
  operations: Readonly<Record<string, OperationRoute>> = OPERATIONS,
  timeoutMs: number = SIGN_IN_TEST_TIMEOUT_MS
): SignInTester {
  if (!Object.hasOwn(TEST_OPERATIONS, kind)) {
    throw new Error('not a kind of client that runs a sign-in test')
  }
  const id = TEST_OPERATIONS[kind]
  const route = Object.hasOwn(operations, id) ? operations[id] : undefined
  if (route?.method !== 'POST' || route.path !== TEST_ROUTES[kind]) {
    throw new Error(`${id} is on the sign-in test allow-list but is not a POST at its route`)
  }
  const call = client.call.bind(client) as (
    id: (typeof TEST_OPERATIONS)[SignInTesterKind],
    input: Record<string, unknown>
  ) => Promise<{ data: unknown }>
  return Object.freeze({
    async run(options?: { signal?: AbortSignal }): Promise<SignInTestRun> {
      // Built here, from nothing of the caller's but the signal: no body, no header, no
      // path parameter, no query.
      const answer = await call(id, {
        ...(options?.signal instanceof AbortSignal ? { signal: options.signal } : {}),
        timeoutMs,
      })
      return answer.data as SignInTestRun
    },
  })
}

/**
 * The same facade with a signal added to the run: what a tool call is given, so that a call
 * that is cancelled takes its request with it.
 *
 * @param tester - The facade.
 * @param signal - Aborted when the tool call is over.
 * @returns A facade whose request ends when `signal` aborts.
 *
 * @example
 * ```ts
 * const controller = new AbortController()
 * const tester = testingWithSignal(signInTester(agent, 'agent'), controller.signal)
 * ```
 */
export function testingWithSignal(tester: SignInTester, signal: AbortSignal): SignInTester {
  return Object.freeze({ run: () => tester.run({ signal }) })
}
