import { z } from 'zod'
import { type CustomClaimValue, checkCustomClaims, MAX_CUSTOM_CLAIMS_BYTES } from './custom-claims'
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
 * hook per point.
 *
 * - `before_sign_up`: before a sign-up creates an account. Allows or denies.
 * - `before_session`: before a sign-in (a sign-up's and a password reset's too) creates a
 *   session, after every factor was proven. Allows or denies.
 * - `before_token`: when a session is created and each time its user proves a factor again,
 *   before the token is issued. Answers with claims for the token; it cannot deny.
 *
 * @example
 * ```ts
 * const point: HookPoint = HOOK_POINTS[0] // 'before_sign_up'
 * ```
 */
export const HOOK_POINTS = ['before_sign_up', 'before_session', 'before_token'] as const

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
 *   // question.data.email is the address being signed up, or null when there is none
 * }
 * ```
 */
export const HOOK_QUESTION_TYPES = {
  before_sign_up: 'hook.before_sign_up',
  before_session: 'hook.before_session',
  before_token: 'hook.before_token',
} as const satisfies Record<HookPoint, `hook.${HookPoint}`>

/**
 * What each point takes for an answer: a `decision` ({@link HookAnswerSchema}: allow, or deny
 * with a code) or `claims` ({@link HookClaimsAnswerSchema}). A point takes one kind and never
 * the other: a claims hook cannot deny, and a deciding hook cannot add a claim.
 *
 * @example
 * ```ts
 * HOOK_ANSWER_KINDS.before_token // 'claims'
 * ```
 */
export const HOOK_ANSWER_KINDS = {
  before_sign_up: 'decision',
  before_session: 'decision',
  before_token: 'claims',
} as const satisfies Record<HookPoint, 'decision' | 'claims'>

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
 * usable answer), then an answer whose status was not 2xx, an answer that was not exactly the
 * answer its point takes, and a signing secret the server could not open. The last two are a
 * claims hook's alone: a claim that breaks a rule (a reserved name, a key outside the grammar,
 * a value that is not one string, number or boolean), and claims over the size cap, by
 * themselves or together with the claims of the session's JWT template.
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
  'claims_invalid',
  'claims_too_large',
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
 *   asked (an emailed code, or a provider that asserts it verified). **`null` when the
 *   account would have no address**: a first sign-in with a provider Tula takes none from
 *   (`oauth_x`, `oauth_facebook`; ADR 0026). The key is always there; a receiver that
 *   decides by the address decides what an account without one gets.
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
    email: z.string().min(3).max(320).nullable(),
    method: z.enum(HOOK_SIGN_UP_METHODS),
    client: SessionClientSchema,
    ipAddress: z.string().max(64).nullable(),
  })
  .meta({
    ref: 'HookBeforeSignUpData',
    description: 'What a hook is told about a sign-up before the account is created.',
  })

/** A user's or a session's id, as the server made it. */
const id = () => z.uuid()

/** The name of a session's profile, as stored on the session (`web`, `mobile`, `back-office`). */
const profile = () => z.string().min(1).max(32)

/**
 * What a session has proven, as its access token's `amr` says it (`pwd`, `email`, `otp`,
 * `mfa`, `fed`, …): names the server made, never anything a request said. A set: the order
 * means nothing. Bounded names, so that a later server's new method still parses.
 */
const amr = () => z.array(z.string().regex(/^[a-z][a-z0-9_]{0,31}$/)).max(16)

/**
 * The `data` of a `hook.before_session` question: who is about to get a session, and how
 * they proved it. An allow-list, and strict.
 *
 * - `userId`: the user. Every factor the sign-in needed has been **proven** by the time the
 *   question is asked.
 * - `client`: the kind of client the sign-in was started from.
 * - `profile`: the name of the session profile the session would get.
 * - `amr`: what was proven, as the token's `amr` will say it. A set.
 * - `signUp`: `true` when the session is the one a sign-up ends with (the account was created
 *   by the same attempt), `false` for a sign-in and for a password reset.
 * - `ipAddress`: the address the request that would create the session came from, as the
 *   server knows it; `null` when it does not.
 *
 * **No email address**: the account exists, and its id names it (an operator reads the
 * address from the admin API by that id). Never a password, a code, a token, an attempt's id
 * or secret, a name or a user agent.
 */
export const HookBeforeSessionDataSchema = z
  .strictObject({
    userId: id(),
    client: SessionClientSchema,
    profile: profile(),
    amr: amr(),
    signUp: z.boolean(),
    ipAddress: z.string().max(64).nullable(),
  })
  .meta({
    ref: 'HookBeforeSessionData',
    description: 'What a hook is told about a sign-in before its session is created.',
  })

/**
 * The `data` of a `hook.before_token` question: the session whose token is about to carry the
 * claims the hook answers with. An allow-list, and strict.
 *
 * - `userId`, `sessionId`: the user and the session. When the question is asked for a new
 *   session, the session **does not exist yet** and may never (the environment's
 *   concurrent-session rule can still refuse it): do not act on the id, only answer.
 * - `client`: the kind of client the session was created from.
 * - `profile`: the name of the session's profile.
 * - `amr`: everything the session has proven so far, as the token's `amr` says it. A set.
 *
 * **No email address and no IP address.** The id names the user; and a claim that depends on
 * where one request came from would be signed into every later token of the session, long
 * after the request. Never a password, a code, a token or a user agent.
 */
export const HookBeforeTokenDataSchema = z
  .strictObject({
    userId: id(),
    sessionId: id(),
    client: SessionClientSchema,
    profile: profile(),
    amr: amr(),
  })
  .meta({
    ref: 'HookBeforeTokenData',
    description: 'What a hook is told about a session before its token is issued.',
  })

/** The envelope of a question around its `data`: the same four fields at every point. */
function question<P extends HookPoint, D extends z.ZodObject>(
  point: P,
  data: D,
  meta: { ref: string; description: string }
) {
  return z
    .strictObject({
      id: z.uuid(),
      type: z.literal(HOOK_QUESTION_TYPES[point]),
      schemaVersion: z.literal(HOOK_SCHEMA_VERSION),
      occurredAt: z.iso.datetime(),
      data,
    })
    .meta(meta)
}

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
  before_sign_up: question('before_sign_up', HookBeforeSignUpDataSchema, {
    ref: 'HookBeforeSignUpQuestion',
    description:
      'What the server posts, signed, to the hook registered for `before_sign_up`, before it creates an account by a sign-up. Not an event: nothing has happened yet.',
  }),
  before_session: question('before_session', HookBeforeSessionDataSchema, {
    ref: 'HookBeforeSessionQuestion',
    description:
      'What the server posts, signed, to the hook registered for `before_session`, after every factor of a sign-in was proven and before it creates the session. Not an event: nothing has happened yet.',
  }),
  before_token: question('before_token', HookBeforeTokenDataSchema, {
    ref: 'HookBeforeTokenQuestion',
    description:
      'What the server posts, signed, to the hook registered for `before_token`, when a session is created and each time its user proves a factor again. The answer is the claims the session’s tokens carry until the next question. Not an event.',
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
  .discriminatedUnion('type', [
    HOOK_QUESTION_SCHEMAS.before_sign_up,
    HOOK_QUESTION_SCHEMAS.before_session,
    HOOK_QUESTION_SCHEMAS.before_token,
  ])
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
  before_session: {
    id: '0199c2f6-0000-7000-8000-000000000002',
    type: 'hook.before_session',
    schemaVersion: HOOK_SCHEMA_VERSION,
    occurredAt: '2026-10-08T09:30:00.000Z',
    data: {
      userId: '0199c2f4-7a10-7c3e-9b1a-5d2e8f4a6c01',
      client: 'web',
      profile: 'web',
      amr: ['pwd', 'otp', 'mfa'],
      signUp: false,
      ipAddress: '203.0.113.7',
    },
  },
  before_token: {
    id: '0199c2f6-0000-7000-8000-000000000003',
    type: 'hook.before_token',
    schemaVersion: HOOK_SCHEMA_VERSION,
    occurredAt: '2026-10-08T09:30:00.000Z',
    data: {
      userId: '0199c2f4-7a10-7c3e-9b1a-5d2e8f4a6c01',
      sessionId: '0199c2f4-7a12-7d4f-8c2b-6e3f9a5b7d02',
      client: 'web',
      profile: 'web',
      amr: ['pwd', 'otp', 'mfa'],
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

/**
 * The answer of a claims hook (`before_token`): the claims to issue under the namespace claim
 * (`ext`) of the session's tokens, and **nothing else**.
 *
 * - `claims`: an object of at most {@link MAX_CUSTOM_CLAIMS_BYTES} bytes as JSON whose every
 *   key passes `isCustomClaimKey` (letters, digits and underscores, at most 32, not a reserved
 *   claim name) and whose every value is one string, number or boolean. `{}` is an answer and
 *   means none.
 *
 * Any other key beside `claims` (a `decision` among them) is not an answer. A claim that
 * breaks a rule fails the **whole** answer: nothing of it is issued, and the hook's failure
 * mode decides. The claims sit inside `ext`, so no answer can set `sub`, `amr`, `auth_time`
 * or any other claim Tula issues; a claims hook cannot deny, choose a user, mark an address
 * verified or skip a second factor.
 *
 * This schema describes the shape and holds every rule but one: a schema library copies an
 * object and drops a `__proto__` key on the way. The server judges the body as it was parsed,
 * with {@link readHookClaimsAnswer}, which refuses that key too.
 *
 * @example
 * ```ts
 * return Response.json({ claims: { role: 'admin', plan: 'team' } } satisfies HookClaimsAnswer)
 * ```
 */
export const HookClaimsAnswerSchema = z
  .strictObject({
    claims: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .refine((claims) => 'claims' in checkCustomClaims(claims), {
        message: `Every key must be a custom claim key that is not reserved, every value one string, number or boolean, and the whole at most ${MAX_CUSTOM_CLAIMS_BYTES} bytes as JSON.`,
      }),
  })
  .meta({ ref: 'HookClaimsAnswer' })

/** What a claims hook answers. */
export type HookClaimsAnswer = z.infer<typeof HookClaimsAnswerSchema>

/**
 * What {@link readHookClaimsAnswer} found in a body: the claims, or which of the fixed failure
 * words ({@link HOOK_FAILURE_REASONS}) says why there are none.
 */
export type HookClaimsRead =
  | { claims: Record<string, CustomClaimValue> }
  | { problem: 'answer_invalid' | 'claims_invalid' | 'claims_too_large' }

/**
 * Read a claims hook's answer from a parsed body, **as the server does**: the one definition
 * of what such an answer is.
 *
 * - `answer_invalid`: not an object with exactly the one key `claims` holding a plain object.
 * - `claims_invalid`: the shape is right and a claim is not: a reserved name, a key outside
 *   the grammar (`__proto__` included), a value that is not one string, number or boolean.
 * - `claims_too_large`: every claim is fine and together they are over the cap.
 *
 * Whole or nothing: no problem leaves some claims standing. Pass the value `JSON.parse`
 * returned, not one a schema has rebuilt.
 *
 * @param body - The parsed body.
 * @returns A copy of the claims (possibly none), or the problem.
 *
 * @example
 * ```ts
 * readHookClaimsAnswer({ claims: { role: 'admin' } }) // { claims: { role: 'admin' } }
 * readHookClaimsAnswer({ claims: { sub: 'x' } }) // { problem: 'claims_invalid' }
 * ```
 */
export function readHookClaimsAnswer(body: unknown): HookClaimsRead {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { problem: 'answer_invalid' }
  }
  const keys = Object.keys(body)
  if (keys.length !== 1 || keys[0] !== 'claims') {
    return { problem: 'answer_invalid' }
  }
  const { claims } = body as { claims: unknown }
  if (typeof claims !== 'object' || claims === null || Array.isArray(claims)) {
    return { problem: 'answer_invalid' }
  }
  const checked = checkCustomClaims(claims)
  if ('claims' in checked) {
    return checked
  }
  return { problem: checked.problem === 'too_large' ? 'claims_too_large' : 'claims_invalid' }
}

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
