import type { AdminClient, AdminOperations, OperationRoute } from '@tula/admin'
import { OPERATIONS } from '@tula/admin'

/**
 * How long one request to the API may take, in milliseconds, before a tool gives up.
 *
 * @example
 * ```ts
 * readOnlyAdmin(admin, OPERATIONS, UPSTREAM_TIMEOUT_MS)
 * ```
 */
export const UPSTREAM_TIMEOUT_MS = 15_000

/**
 * Every admin operation a tool can reach: the allow-list. All of them are `GET`s. Listing API
 * keys and signing keys is deliberately not here, although both are reads (ADR 0033).
 *
 * @example
 * ```ts
 * READ_OPERATIONS.includes('listUsers') // true
 * ```
 */
export const READ_OPERATIONS = [
  'getEnvironmentSettings',
  'getUser',
  'getUserAuthentication',
  'listAuditLogs',
  'listOAuthProviders',
  'listUsers',
  'listUserSessions',
] as const satisfies readonly (keyof AdminOperations)[]

/**
 * Id of an operation a tool may call.
 *
 * @example
 * ```ts
 * const id: ReadOperationId = 'getUser'
 * ```
 */
export type ReadOperationId = (typeof READ_OPERATIONS)[number]

/** A read's parameters: the operation's path and query parameters, never a body. */
type ReadInput<Id extends ReadOperationId> = (AdminOperations[Id]['params'] extends Record<
  string,
  never
>
  ? { params?: undefined }
  : { params: AdminOperations[Id]['params'] }) & {
  query?: AdminOperations[Id]['query']
}

type ReadArguments<Id extends ReadOperationId> =
  Record<string, never> extends ReadInput<Id> ? [input?: ReadInput<Id>] : [input: ReadInput<Id>]

/**
 * The only way a tool reaches the admin API: one function, over the allow-listed `GET`
 * operations. It has no `call`, takes no body and no header, and does not hand out the client
 * it wraps, so there is no path from a tool to an operation that changes anything.
 *
 * @example
 * ```ts
 * const user = await reads.read('getUser', { params: { userId } })
 * ```
 */
export interface ReadOnlyAdmin {
  /**
   * Call one allow-listed read.
   *
   * @param id - The operation's id.
   * @param input - Its path and query parameters.
   * @returns The answer's body, exactly as the API sent it: project it before returning it.
   * @throws TulaAdminError as the admin client does.
   * @throws Error when `id` is not on the allow-list (a programming error; nothing is sent).
   */
  read<Id extends ReadOperationId>(
    id: Id,
    ...input: ReadArguments<Id>
  ): Promise<AdminOperations[Id]['response']>
}

/**
 * Wrap an admin client so that only the allow-listed reads can be called through it.
 *
 * The allow-list is enforced three times: by the type of `read`, by a check of the id on every
 * call, and here, once, by checking that every allow-listed id is a `GET` in the client's
 * operation table (so that an operation which changed method in a later contract is refused
 * rather than called).
 *
 * @param admin - The admin client, holding the secret key.
 * @param operations - The operation table to check the allow-list against.
 * @param timeoutMs - The timeout of each request.
 * @returns The facade.
 * @throws Error when an allow-listed operation is not a `GET`.
 *
 * @example
 * ```ts
 * const reads = readOnlyAdmin(createAdminClient({ baseUrl, secretKey }))
 * const { data } = await reads.read('listUsers', { query: { size: 20 } })
 * ```
 */
export function readOnlyAdmin(
  admin: AdminClient,
  operations: Readonly<Record<string, OperationRoute>> = OPERATIONS,
  timeoutMs: number = UPSTREAM_TIMEOUT_MS
): ReadOnlyAdmin {
  const allowed: ReadonlySet<string> = new Set(READ_OPERATIONS)
  for (const id of READ_OPERATIONS) {
    if (operations[id]?.method !== 'GET') {
      throw new Error(`${id} is on the read allow-list but is not a GET operation`)
    }
  }
  const call = admin.call.bind(admin) as (
    id: string,
    input: Record<string, unknown>
  ) => Promise<{ data: unknown }>
  return Object.freeze({
    async read<Id extends ReadOperationId>(
      id: Id,
      ...input: ReadArguments<Id>
    ): Promise<AdminOperations[Id]['response']> {
      if (typeof id !== 'string' || !allowed.has(id)) {
        throw new Error('not a read operation')
      }
      const given = input[0] as { params?: unknown; query?: unknown } | undefined
      // Only the path and query parameters are passed on: never a body or a header.
      const answer = await call(id, {
        ...(given?.params !== undefined ? { params: given.params } : {}),
        ...(given?.query !== undefined ? { query: given.query } : {}),
        timeoutMs,
      })
      return answer.data as AdminOperations[Id]['response']
    },
  })
}
