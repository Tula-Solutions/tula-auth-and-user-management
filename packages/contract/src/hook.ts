import { z } from 'zod'
import { OAUTH_PROVIDERS } from './oauth'
import { SessionClientSchema } from './session'
import { MAX_WEBHOOK_URL_LENGTH } from './webhook'

// A hook (ADR 0035): a signed QUESTION the server asks an operator's endpoint before it does
// something, whose answer decides whether it happens. Not a webhook: a webhook is a notice of
// what has already happened, and its answer changes nothing.
//
// A question is signed exactly as a webhook delivery is (`./webhook-signature`) and has the
// same envelope as an event (`id`, `type`, `schemaVersion`, `occurredAt`, `data`), so one
// verifier and one mental model serve both. It is NOT an event: it has no `actor` and no
// `target`, its `type` is no activity type, and `TulaEventSchema` refuses it.

/**
 * The points at which the server can ask a hook. A closed list: an environment has at most one
 * hook per point. Later points are added here.
 *
 * @example
 * ```ts
 * const point: HookPoint = HOOK_POINTS[0] // 'before_sign_up'
 * ```
 */
export const HOOK_POINTS = ['before_sign_up'] as const

/** One of {@link HOOK_POINTS}. */
export const HookPointSchema = z.enum(HOOK_POINTS).meta({ ref: 'HookPoint' })

/** A point at which a hook is asked. */
export type HookPoint = (typeof HOOK_POINTS)[number]

/**
 * The `type` of the question asked at each point. None of them is the name of an event.
 *
 * @example
 * ```ts
 * if (question.type === HOOK_QUESTION_TYPES.before_sign_up) {
 *   // question.data.email is the address being signed up
 * }
 * ```
 */
export const HOOK_QUESTION_TYPES = {
  before_sign_up: 'hook.before_sign_up',
} as const satisfies Record<HookPoint, `hook.${HookPoint}`>

/**
 * The version of the hook questions: the `schemaVersion` of every question. Within a version a
 * question only grows.
 *
 * @example
 * ```ts
 * question.schemaVersion === HOOK_SCHEMA_VERSION
 * ```
 */
export const HOOK_SCHEMA_VERSION = 1

/**
 * How long the server waits for a hook's answer unless the hook says otherwise, in
 * milliseconds. A hook is on the path of a person signing up: they are waiting.
 *
 * @example
 * ```ts
 * const deadlineMs = input.deadlineMs ?? HOOK_DEFAULT_DEADLINE_MS
 * ```
 */
export const HOOK_DEFAULT_DEADLINE_MS = 2000

/**
 * The shortest deadline a hook can be given, in milliseconds.
 *
 * @example
 * ```ts
 * deadlineMs >= HOOK_MIN_DEADLINE_MS
 * ```
 */
export const HOOK_MIN_DEADLINE_MS = 100

/**
 * The longest deadline a hook can be given, in milliseconds. Not configurable above this: the
 * API's schema refuses a larger number and so does the database.
 *
 * @example
 * ```ts
 * deadlineMs <= HOOK_MAX_DEADLINE_MS
 * ```
 */
export const HOOK_MAX_DEADLINE_MS = 5000

/**
 * What happens when a hook cannot be asked or does not answer as the contract says: `deny`
 * refuses what was asked about (the default: a check that is down lets nobody through),
 * `allow` lets it happen as if there were no hook. Choosing `allow` is a recorded weakening.
 *
 * @example
 * ```ts
 * const mode: HookFailureMode = 'deny'
 * ```
 */
export const HOOK_FAILURE_MODES = ['deny', 'allow'] as const

/** One of {@link HOOK_FAILURE_MODES}. */
export type HookFailureMode = (typeof HOOK_FAILURE_MODES)[number]

/**
 * Why a call of a hook failed, as a hook's `lastFailureReason` says it. Fixed words of the
 * server's own: the first eight are the outbound guard's (the request was not made, or got no
 * usable answer), then an answer whose status was not 2xx, an answer that was not exactly
 * `{ "decision": … }`, and a signing secret the server could not open.
 *
 * @example
 * ```ts
 * if (hook.lastFailureReason === 'timeout') {
 *   // the endpoint did not answer inside the hook's deadline
 * }
 * ```
 */
export const HOOK_FAILURE_REASONS = [
  'invalid_url',
  'invalid_request',
  'scheme_not_allowed',
  'resolve_failed',
  'address_not_allowed',
  'connection_failed',
  'timeout',
  'response_too_large',
  'status_not_ok',
  'answer_invalid',
  'secret_unreadable',
] as const

/** One of {@link HOOK_FAILURE_REASONS}. */
export type HookFailureReason = (typeof HOOK_FAILURE_REASONS)[number]

/**
 * The fields of a hook an update can change, as `hook.updated` names them. `url` says the
 * address changed, never what it is or was.
 *
 * @example
 * ```ts
 * const changed: (typeof HOOK_FIELDS)[number][] = ['failureMode']
 * ```
 */
export const HOOK_FIELDS = ['url', 'enabled', 'deadlineMs', 'failureMode'] as const

/**
 * Longest message code a hook may deny with.
 *
 * @example
 * ```ts
 * code.length <= HOOK_MAX_DENIAL_CODE_LENGTH
 * ```
 */
export const HOOK_MAX_DENIAL_CODE_LENGTH = 64

/**
 * What a denial's message code looks like: lower-case letters, digits and underscores. The
 * operator's own name for why (`disposable_email`), which their app turns into words: narrow
 * enough that it can be shown, logged and put in an error's `params` without being markup,
 * a sentence or a secret.
 *
 * @example
 * ```ts
 * HOOK_DENIAL_CODE_PATTERN.test('disposable_email') // true
 * ```
 */
export const HOOK_DENIAL_CODE_PATTERN = /^[a-z0-9_]{1,64}$/

/** A hook's address as typed: bounded here, judged by the server's outbound guard. */
const url = () =>
  z
    .string()
    .min(1)
    .max(MAX_WEBHOOK_URL_LENGTH)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point.
    .regex(/^[^\s\u0000-\u001f\u007f]+$/, 'Must not contain spaces or control characters.')

const deadlineMs = () => z.number().int().min(HOOK_MIN_DEADLINE_MS).max(HOOK_MAX_DEADLINE_MS)

/**
 * A hook as the admin API lists it. The signing secret is never part of it: it is returned
 * once, by the call that registered the hook.
 */
export const HookSchema = z
  .object({
    id: z.uuid(),
    /**
     * When the server asks it: one of {@link HOOK_POINTS}. A plain string, so a client built
     * against this version keeps reading a list a later server wrote.
     */
    point: z.string(),
    /** Where the question is posted. */
    url: z.string(),
    /** A hook that is off is not asked: what it guards happens as if there were none. */
    enabled: z.boolean(),
    /** How long the server waits for the answer, in milliseconds. */
    deadlineMs: z.number().int(),
    /** One of {@link HOOK_FAILURE_MODES}. A plain string, for the same reason as `point`. */
    failureMode: z.string(),
    /** When a call of the hook last failed, whenever that was; `null` when none ever has. */
    lastFailedAt: z.iso.datetime().nullable(),
    /**
     * Why that call failed: one of {@link HOOK_FAILURE_REASONS}, a fixed word of the server's
     * own and never anything the endpoint said. `null` exactly when `lastFailedAt` is.
     */
    lastFailureReason: z.string().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ ref: 'Hook' })

/**
 * A newly registered hook. `secret` is its signing secret (`whsec_…`), in this response only:
 * the server keeps it sealed and never returns it again.
 */
export const CreatedHookSchema = HookSchema.extend({
  secret: z.string().describe('The signing secret. Store it now: it is shown only once.'),
}).meta({ ref: 'CreatedHook' })

/** An environment's hooks, oldest first: at most one per point. */
export const HookListSchema = z.object({ data: z.array(HookSchema) }).meta({ ref: 'HookList' })

/**
 * Body of `POST /v1/admin/hooks`.
 *
 * `url` must be one the server may call: `https`, no credentials, and a host that resolves to
 * public addresses only (`hook.url_not_allowed` otherwise). There is no `secret` field: the
 * server generates it. `failureMode: 'allow'` is recorded as a weakening.
 */
export const CreateHookRequestSchema = z
  .strictObject({
    point: z.enum(HOOK_POINTS),
    url: url(),
    enabled: z.boolean().default(true),
    deadlineMs: deadlineMs().default(HOOK_DEFAULT_DEADLINE_MS),
    failureMode: z.enum(HOOK_FAILURE_MODES).default('deny'),
  })
  .meta({ ref: 'CreateHookRequest' })

/**
 * Body of `PATCH /v1/admin/hooks/{id}`: the fields to change, at least one. The point a hook
 * was registered for and its secret cannot be changed.
 */
export const UpdateHookRequestSchema = z
  .strictObject({
    url: url().optional(),
    enabled: z.boolean().optional(),
    deadlineMs: deadlineMs().optional(),
    failureMode: z.enum(HOOK_FAILURE_MODES).optional(),
  })
  .refine((update) => Object.values(update).some((value) => value !== undefined), {
    message: 'Name at least one field to change.',
  })
  .meta({ ref: 'UpdateHookRequest' })

/**
 * How a sign-up is being made, as a `hook.before_sign_up` question says it: with a password,
 * without one (an emailed code proved the address), or by a first sign-in with a provider.
 *
 * @example
 * ```ts
 * const method: (typeof HOOK_SIGN_UP_METHODS)[number] = 'oauth_google'
 * ```
 */
export const HOOK_SIGN_UP_METHODS = [
  'password',
  'passwordless',
  ...OAUTH_PROVIDERS.map((provider) => `oauth_${provider}` as const),
] as const

/**
 * The `data` of a `hook.before_sign_up` question. An allow-list, and strict: nothing reaches a
 * question by being passed along.
 *
 * - `email`: the address the account would be created for, normalised (lower case): the form
 *   an account is unique by. The address has been **proven** by the time the question is
 *   asked (an emailed code, or a provider that asserts it verified).
 * - `method`: one of {@link HOOK_SIGN_UP_METHODS}.
 * - `client`: the kind of client the sign-up was started from.
 * - `ipAddress`: the address the request that would create the account came from, as the
 *   server knows it; `null` when it does not.
 *
 * Never a password, a code, a token, an attempt's id or secret, a name, a user agent or
 * anything of a provider's profile.
 */
export const HookBeforeSignUpDataSchema = z
  .strictObject({
    email: z.string().min(3).max(320),
    method: z.enum(HOOK_SIGN_UP_METHODS),
    client: SessionClientSchema,
    ipAddress: z.string().max(64).nullable(),
  })
  .meta({
    ref: 'HookBeforeSignUpData',
    description: 'What a hook is told about a sign-up before the account is created.',
  })

/**
 * The question of each point: the envelope around its `data`.
 *
 * - `id`: the question's id, also the `webhook-id` header. Every question has a new one.
 * - `type`: {@link HOOK_QUESTION_TYPES} of the point.
 * - `schemaVersion`: {@link HOOK_SCHEMA_VERSION}.
 * - `occurredAt`: when the question was asked, ISO 8601, UTC.
 *
 * @example
 * ```ts
 * const question = HOOK_QUESTION_SCHEMAS.before_sign_up.parse(JSON.parse(body))
 * ```
 */
export const HOOK_QUESTION_SCHEMAS = {
  before_sign_up: z
    .strictObject({
      id: z.uuid(),
      type: z.literal(HOOK_QUESTION_TYPES.before_sign_up),
      schemaVersion: z.literal(HOOK_SCHEMA_VERSION),
      occurredAt: z.iso.datetime(),
      data: HookBeforeSignUpDataSchema,
    })
    .meta({
      ref: 'HookBeforeSignUpQuestion',
      description:
        'What the server posts, signed, to the hook registered for `before_sign_up`, before it creates an account by a sign-up. Not an event: nothing has happened yet.',
    }),
} as const satisfies Record<HookPoint, z.ZodObject>

/** The question asked at point `P`. */
export type HookQuestionOf<P extends HookPoint> = z.infer<(typeof HOOK_QUESTION_SCHEMAS)[P]>

/** Any question a hook is asked: a union told apart by `type`. */
export type HookQuestion = { [P in HookPoint]: HookQuestionOf<P> }[HookPoint]

/**
 * Any question, told apart by `type`: what a hook's receiver parses a request with.
 *
 * @example
 * ```ts
 * const question = HookQuestionSchema.parse(JSON.parse(body))
 * ```
 */
export const HookQuestionSchema = z
  .discriminatedUnion('type', [HOOK_QUESTION_SCHEMAS.before_sign_up])
  .meta({ ref: 'HookQuestion' })

/**
 * A valid example of every question, keyed by point: for documentation and for a receiver's
 * tests. Plain data: nothing here is a real id or a real address.
 *
 * @example
 * ```ts
 * test('refuses a disposable address', async () => {
 *   expect(await decide(HOOK_QUESTION_FIXTURES.before_sign_up)).toEqual({ decision: 'allow' })
 * })
 * ```
 */
export const HOOK_QUESTION_FIXTURES: { readonly [P in HookPoint]: HookQuestionOf<P> } = {
  before_sign_up: {
    id: '0199c2f6-0000-7000-8000-000000000001',
    type: 'hook.before_sign_up',
    schemaVersion: HOOK_SCHEMA_VERSION,
    occurredAt: '2026-10-08T09:30:00.000Z',
    data: {
      email: 'ada@example.com',
      method: 'password',
      client: 'web',
      ipAddress: '203.0.113.7',
    },
  },
}

/**
 * The answer of a hook: allow, or deny with an optional message code of the operator's own.
 *
 * **Exactly this and nothing else.** A body that is not JSON, another `decision`, a `code`
 * beside an `allow`, a code outside {@link HOOK_DENIAL_CODE_PATTERN} or **any other key** is
 * not an answer: the call has failed and the hook's failure mode decides. An unknown key is
 * not ignored, because a later version may give one meaning and a server that does not know
 * it must not act on half of an answer. A hook can allow or deny; it cannot mark an address
 * verified, skip a second factor, choose a user or add anything to an account.
 *
 * @example
 * ```ts
 * return Response.json({ decision: 'deny', code: 'disposable_email' } satisfies HookAnswer)
 * ```
 */
export const HookAnswerSchema = z
  .discriminatedUnion('decision', [
    z.strictObject({ decision: z.literal('allow') }),
    z.strictObject({
      decision: z.literal('deny'),
      code: z.string().regex(HOOK_DENIAL_CODE_PATTERN).optional(),
    }),
  ])
  .meta({ ref: 'HookAnswer' })

/** What a hook answers. */
export type HookAnswer = z.infer<typeof HookAnswerSchema>
/** A hook as listed. */
export type Hook = z.infer<typeof HookSchema>
/** A hook with its secret, as its registration returns it. */
export type CreatedHook = z.infer<typeof CreatedHookSchema>
/** Body of a hook's registration. */
export type CreateHookRequest = z.infer<typeof CreateHookRequestSchema>
/** Body of a hook's update. */
export type UpdateHookRequest = z.infer<typeof UpdateHookRequestSchema>

/** What of a hook decides how much it protects. */
export interface HookStrength {
  enabled: boolean
  failureMode: HookFailureMode
}

/**
 * Which fields of a hook were changed in a way that lets through what it used to stop: the
 * same idea as `settingsWeakenings` for an environment's settings, and meant for the same
 * uses (the audit entry's `weakened`; later, `tula apply --yes` and the dashboard's
 * confirmation).
 *
 * - `failureMode` from `deny` to `allow`, or a hook registered with `allow`: a check that is
 *   down no longer refuses. Whether the hook is on at that moment does not matter: the choice
 *   is what is recorded, and it takes effect whenever the hook is on.
 * - `enabled` to `false`, or the removal of a hook that was on: the check is gone.
 *
 * @param was - The hook before; `null` when it is being registered.
 * @param is - The hook after; `null` when it is being removed.
 * @returns The names of the weakened fields, in the order of {@link HOOK_FIELDS}; empty when
 *   the change weakens nothing.
 *
 * @example
 * ```ts
 * hookWeakenings({ enabled: true, failureMode: 'deny' }, { enabled: true, failureMode: 'allow' })
 * // ['failureMode']
 * ```
 */
export function hookWeakenings(
  was: HookStrength | null,
  is: HookStrength | null
): ('enabled' | 'failureMode')[] {
  const weakened: ('enabled' | 'failureMode')[] = []
  if (was?.enabled && !is?.enabled) {
    weakened.push('enabled')
  }
  if (is?.failureMode === 'allow' && was?.failureMode !== 'allow') {
    weakened.push('failureMode')
  }
  return weakened
}
