import { clientError } from './errors'
import type { Schemas } from './generated/api.gen'
import {
  isRecord,
  type VerifyWebhookOptions,
  verifySigned,
  type WebhookHeaders,
  type WebhookSecrets,
} from './webhook'

/**
 * A question Tula asks a hook: a union told apart by `type`. Not an event: nothing has
 * happened yet, and what you answer decides what does.
 *
 * - `hook.before_sign_up`: an account is about to be created for a proven address. Answer
 *   with a {@link TulaHookAnswer}.
 * - `hook.before_session`: every factor of a sign-in is proven and its session is about to
 *   be created. Its data names the user by id, the client kind, the session profile, what
 *   was proven (`amr`), whether the account was created by this sign-in, and the address the
 *   request came from. No email address: look the user up by id if you need one. Answer with
 *   a {@link TulaHookAnswer}.
 * - `hook.before_token`: a session is about to be created, or its user has just proven a
 *   factor again. Answer with a {@link TulaHookClaimsAnswer}. It is asked then and **not at
 *   a refresh**: what you answer is stored on the session and issued with every token until
 *   the session ends or its user proves a factor again.
 *
 * **Narrow on `type` before reading `data`**, and refuse a type you do not handle: each
 * point's data is its own.
 *
 * @example
 * ```ts
 * function decide(question: TulaHookQuestion): TulaHookAnswer | TulaHookClaimsAnswer {
 *   switch (question.type) {
 *     case 'hook.before_sign_up':
 *       return question.data.email.endsWith('@spam.example')
 *         ? { decision: 'deny', code: 'domain_blocked' }
 *         : { decision: 'allow' }
 *     case 'hook.before_session':
 *       return question.data.amr.includes('mfa') ? { decision: 'allow' } : { decision: 'deny', code: 'mfa_needed' }
 *     case 'hook.before_token':
 *       return { claims: { plan: 'pro' } }
 *   }
 * }
 * ```
 */
export type TulaHookQuestion = Schemas['HookQuestion']

/**
 * What a hook answers, as the JSON body of a `200`: allow, or deny with an optional message
 * code of your own (lower-case letters, digits and underscores, at most 64) that your app
 * turns into words. **Exactly this and nothing else**: any other key, another `decision` or a
 * status that is not 2xx is not an answer, and the hook's failure mode decides.
 *
 * @example
 * ```ts
 * const answer: TulaHookAnswer = { decision: 'deny', code: 'disposable_email' }
 * ```
 */
export type TulaHookAnswer = Schemas['HookAnswer']

/**
 * What a claims hook (`hook.before_token`) answers, as the JSON body of a `200`: the claims
 * to issue inside the `ext` claim of the session's tokens, and **nothing else**.
 *
 * Every key is letters, digits and underscores (at most 32, starting with a letter or an
 * underscore) and not a reserved claim name (`sub`, `amr`, `exp`, …); every value is one
 * string, number or boolean; the whole is at most 1,024 bytes as JSON **together with the
 * claims of the session profile's JWT template**, over which yours win a key both set. `{}`
 * means none. One claim that breaks a rule, or any key beside `claims`, fails the whole
 * answer: none of it is issued, and the hook's failure mode decides (by default the sign-in
 * is refused). A claims hook cannot deny, choose a user, mark an address verified or change
 * what a session has proven: it has no field for any of them.
 *
 * @example
 * ```ts
 * const answer: TulaHookClaimsAnswer = { claims: { plan: 'pro', seats: 5 } }
 * ```
 */
export type TulaHookClaimsAnswer = Schemas['HookClaimsAnswer']

/**
 * The `type` of every question this version knows. A closed list on purpose: a hook must
 * never allow something it does not understand, so a question of another type is refused
 * (`hook.invalid_payload`) rather than passed on.
 *
 * @example
 * ```ts
 * HOOK_QUESTION_TYPE_NAMES.includes('hook.before_sign_up') // true
 * ```
 */
export const HOOK_QUESTION_TYPE_NAMES = [
  'hook.before_sign_up',
  'hook.before_session',
  'hook.before_token',
] as const satisfies readonly TulaHookQuestion['type'][]

/**
 * Whether a parsed body is a question this version knows, and the one the request names.
 *
 * An event has an `actor` and a `target`; a question has neither. That, and the closed list
 * of types, is what keeps an event (also one about a hook, whose type begins with `hook.`
 * too) from ever being read as a question.
 */
function isQuestion(value: unknown, id: string): value is TulaHookQuestion {
  return (
    isRecord(value) &&
    value.id === id &&
    (HOOK_QUESTION_TYPE_NAMES as readonly unknown[]).includes(value.type) &&
    typeof value.schemaVersion === 'number' &&
    typeof value.occurredAt === 'string' &&
    isRecord(value.data) &&
    !('actor' in value) &&
    !('target' in value) &&
    !('test' in value)
  )
}

/**
 * Verify a hook's question from Tula and return it.
 *
 * A question is a `POST` whose body is JSON and whose headers are signed exactly as a webhook
 * delivery's are (`webhook-id`, `webhook-timestamp`, `webhook-signature`: the Standard
 * Webhooks scheme, HMAC-SHA256 over `<id>.<timestamp>.<body>` with the hook's secret), so this
 * checks what {@link verifyWebhook} checks: the signature in constant time, and a timestamp
 * within five minutes of this server's clock. It then requires the body to be a **question**:
 * an event is refused here, and a question is refused by `verifyWebhook`, whatever secret
 * signed either.
 *
 * **Answer inside the hook's deadline** (two seconds unless you set another, never more than
 * five) with a `200` and exactly `{ "decision": "allow" }` or
 * `{ "decision": "deny", "code": "your_code" }` ({@link TulaHookAnswer}), or, for
 * `hook.before_token`, exactly `{ "claims": { … } }` ({@link TulaHookClaimsAnswer}).
 * Anything else (an error status, a redirect, another key, no answer in time) is a failure,
 * and the hook's failure mode decides: by default the sign-up, the sign-in or the step-up is
 * refused. Answer first and do slow work afterwards; a question is asked once and never
 * repeated.
 *
 * **One endpoint per hook is the simple way.** If one endpoint receives several points,
 * narrow on `question.type` and answer each with its own kind of answer; an answer of the
 * other kind is a failure.
 *
 * **Refuse what you cannot verify**: answer a non-2xx when this throws. Never answer `allow`
 * to a request that did not verify.
 *
 * **Pass the body exactly as it arrived**: the raw text or bytes of the request, never an
 * object your framework parsed and you wrote out again.
 *
 * Runs on any server runtime (it uses Web Crypto). Never call it from a browser: it takes the
 * hook's secret.
 *
 * @param body - The request body as received: text or bytes.
 * @param headers - The request's headers.
 * @param secret - The hook's signing secret (`whsec_…`), as its registration returned it.
 * @param options - The clock to judge the timestamp by; the real one unless given.
 * @returns The question.
 * @throws TulaAdminError with `status` 0 and one of these codes, and never with the secret, a
 *   signature or the body in it: `hook.invalid_secret`, `hook.invalid_headers`,
 *   `hook.timestamp_out_of_tolerance`, `hook.invalid_signature`, `hook.invalid_payload`
 *   (signed correctly, but not a question this version knows with the request's id).
 *
 * @example
 * ```ts
 * // A complete receiver (Next.js, Hono, any `Request`-based server).
 * export async function POST(request: Request) {
 *   let question: TulaHookQuestion
 *   try {
 *     question = await verifyHook(await request.text(), request.headers, process.env.TULA_HOOK_SECRET ?? '')
 *   } catch {
 *     return new Response(null, { status: 400 })
 *   }
 *   if (question.type !== 'hook.before_sign_up') {
 *     return new Response(null, { status: 400 })
 *   }
 *   const answer: TulaHookAnswer = question.data.email.endsWith('@mailinator.com')
 *     ? { decision: 'deny', code: 'disposable_email' }
 *     : { decision: 'allow' }
 *   return Response.json(answer)
 * }
 * ```
 */
export async function verifyHook(
  body: string | Uint8Array,
  headers: WebhookHeaders,
  secret: WebhookSecrets,
  options: VerifyWebhookOptions = {}
): Promise<TulaHookQuestion> {
  const { id, payload } = await verifySigned('hook', body, headers, secret, options)
  if (!isQuestion(payload, id)) {
    throw clientError('hook.invalid_payload')
  }
  return payload
}
