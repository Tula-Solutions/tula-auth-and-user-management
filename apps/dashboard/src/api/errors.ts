/** One field's error, as the contract's envelope lists it. */
export interface FieldError {
  /** Dot path of the field in the request body (`password.minLength`). */
  field: string
  /** The contract's error code for the field. */
  code: string
  /** The server's message, rendered as text. */
  message: string
}

/** What an {@link ApiError} is built from. */
export interface ApiErrorInit {
  status: number
  code: string
  detail: string
  params?: Record<string, unknown>
  fieldErrors?: FieldError[]
  retryAfter?: number | null
}

/**
 * The one error every failed API call throws.
 *
 * Built from the contract's envelope, or with a client code of its own (`network.failed`,
 * `response.invalid`, `client.no_environment`, `client.environment_changed`; all `status: 0`
 * except an unreadable answer, which keeps its status). It never carries a response body or a network error's message.
 */
export class ApiError extends Error {
  /** HTTP status, or 0 when no answer was received. */
  readonly status: number
  /** The contract's error code, or one of the client's own. */
  readonly code: string
  /** The server's description, safe to render as text. */
  readonly detail: string
  /** The envelope's parameters (limits, methods). */
  readonly params: Record<string, unknown>
  /** Per-field errors of a refused body. */
  readonly fieldErrors: FieldError[]
  /** Seconds the server asked the caller to wait, when it said so. */
  readonly retryAfter: number | null

  /** @param init - Status, code and what the envelope carried. */
  constructor(init: ApiErrorInit) {
    super(`${init.code}: ${init.detail}`)
    this.name = 'ApiError'
    this.status = init.status
    this.code = init.code
    this.detail = init.detail
    this.params = init.params ?? {}
    this.fieldErrors = init.fieldErrors ?? []
    this.retryAfter = init.retryAfter ?? null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readFieldErrors(value: unknown): FieldError[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.flatMap((entry) =>
    isRecord(entry) && typeof entry.field === 'string' && typeof entry.message === 'string'
      ? [
          {
            field: entry.field,
            code: typeof entry.code === 'string' ? entry.code : 'validation.failed',
            message: entry.message,
          },
        ]
      : []
  )
}

/**
 * Read the contract's error envelope from a parsed body.
 *
 * @param status - The response's HTTP status.
 * @param body - The parsed JSON body, or anything else.
 * @param retryAfter - The `Retry-After` header in seconds, if any.
 * @returns The typed error; `response.invalid` when the body is not an envelope.
 */
export function fromEnvelope(status: number, body: unknown, retryAfter: number | null): ApiError {
  if (!isRecord(body) || typeof body.code !== 'string' || typeof body.detail !== 'string') {
    return new ApiError({
      status,
      code: 'response.invalid',
      detail: 'The server answered with something this dashboard cannot read.',
    })
  }
  return new ApiError({
    status,
    code: body.code,
    detail: body.detail,
    params: isRecord(body.params) ? body.params : {},
    fieldErrors: readFieldErrors(body.errors),
    retryAfter,
  })
}

/**
 * Narrow anything thrown by a query or mutation to an {@link ApiError}.
 *
 * @param error - What was thrown.
 * @returns The error itself, or a generic `client.failed` one that carries nothing of it.
 */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    return error
  }
  return new ApiError({
    status: 0,
    code: 'client.failed',
    detail: 'Something went wrong in the dashboard. Reload the page and try again.',
  })
}

/**
 * The field errors of a failure, by field path. The first message of a field wins.
 *
 * @param error - What a mutation threw.
 * @returns A map from field path to message; empty when there are none.
 */
export function fieldErrorMap(error: unknown): Record<string, string> {
  const map: Record<string, string> = {}
  for (const entry of toApiError(error).fieldErrors) {
    if (!Object.hasOwn(map, entry.field)) {
      map[entry.field] = entry.message
    }
  }
  return map
}

/** Messages that say more than the server's `detail` does about what to do next. */
const MESSAGES: Record<string, string> = {
  'network.failed': 'The API did not answer. Check that it is running, then try again.',
  'precondition.failed':
    'These settings were changed somewhere else since you opened them. Reload to see the current version.',
  'auth.unauthenticated': 'Your session has ended. Sign in again.',
  'request.origin_not_allowed':
    'The API refused this page’s origin. Open the dashboard from the API’s own address.',
}

/**
 * The sentence to show for a failure.
 *
 * @param error - What a query or mutation threw.
 * @returns A message for the operator: the dashboard's own for a few codes, else the server's.
 */
export function messageFor(error: unknown): string {
  const failure = toApiError(error)
  if (failure.code === 'rate_limited') {
    return failure.retryAfter === null
      ? 'Too many requests. Wait a moment, then try again.'
      : `Too many requests. Try again in ${failure.retryAfter} seconds.`
  }
  // The table's own entries only: a code such as `constructor` names something every object
  // has, which is no message.
  return (
    (Object.hasOwn(MESSAGES, failure.code) ? MESSAGES[failure.code] : undefined) ?? failure.detail
  )
}

/**
 * Whether a failure means the session may not do this (as opposed to "not signed in").
 *
 * @param error - What a query threw.
 * @returns True for a 403.
 */
export function isForbidden(error: unknown): boolean {
  return toApiError(error).status === 403
}
