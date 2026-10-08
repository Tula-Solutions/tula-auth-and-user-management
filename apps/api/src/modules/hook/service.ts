import {
  type CreatedHook,
  type CreateHookRequest,
  type CustomClaimValue,
  HOOK_FIELDS,
  HOOK_MAX_DEADLINE_MS,
  HOOK_QUESTION_TYPES,
  HOOK_SCHEMA_VERSION,
  type Hook,
  HookAnswerSchema,
  type HookFailureReason,
  type HookPoint,
  type HookQuestionOf,
  hookWeakenings,
  readHookClaimsAnswer,
  type UpdateHookRequest,
} from '@tula/contract'
import type { Deps, Tenant } from '~/dependencies'
import { AuthError, ConflictError, NotFoundError, RateLimitError } from '~/exceptions'
import type { Actor } from '~/lib/actor'
import * as logger from '~/lib/logger'
import * as Outbound from '~/lib/outbound'
import { errorReason } from '~/lib/safe-error'
import { newSigningSecret, openSigningSecret, signedHeaders } from '~/lib/signing-secret'
import * as Audit from '~/modules/audit/service'
import type { HookChanges, HookRecord } from '~/ports/hook-store'

// Hooks (ADR 0035): a signed question the server asks an operator's endpoint before it acts,
// whose answer decides what happens. This module registers them (`/v1/admin/hooks`) and asks
// them. Three points: `before_sign_up` (the flow engine and `OAuth.resolveAccount`, where a
// sign-up is about to create an account), `before_session` (the flow engine's `finish`,
// before a sign-in's session is created) and `before_token` (the session service, when a
// session is created and when its user proves a factor again).

/** Key-separation label of the sealed signing secrets (`~/lib/secret-box`). Not the webhooks'. */
export const HOOK_SECRET_PURPOSE = 'hook-secrets'

/**
 * Most bytes of a deciding hook's answer that are read. An answer is
 * `{"decision":"deny","code":"…"}` at its longest, about a hundred bytes; anything past this
 * is not an answer.
 */
export const HOOK_MAX_RESPONSE_BYTES = 1024

/**
 * Most bytes of a claims hook's answer that are read. The claims themselves are capped at
 * 1,024 bytes of compact JSON (`MAX_CUSTOM_CLAIMS_BYTES`); this leaves room for the key
 * around them and for an endpoint that writes its JSON with spaces and line breaks.
 */
export const HOOK_MAX_CLAIMS_RESPONSE_BYTES = 4096

/**
 * Most calls of its hooks one environment causes in a minute, across all callers. The flow's
 * own limits already bound them (a call needs a proven address); this is the bound that is
 * about the operator's endpoint and does not depend on which path led to the call. The same
 * number as the sign-up ceiling: ten a second.
 */
export const HOOK_CALLS_PER_MINUTE = 600

/**
 * Most calls of its `before_session` hook, and most of its `before_token` hook, one
 * environment causes in a minute: each point has a count of its own. The same number as the
 * flow engine's ceiling on steps that check a secret (`verify`), because that is what leads
 * to a call: a call of either needs a sign-in or a step-up whose every factor was proven.
 */
export const HOOK_SESSION_CALLS_PER_MINUTE = 3000

/** The ceiling of each point's calls per environment and minute. */
const HOOK_POINT_CALLS_PER_MINUTE: Record<HookPoint, number> = {
  before_sign_up: HOOK_CALLS_PER_MINUTE,
  before_session: HOOK_SESSION_CALLS_PER_MINUTE,
  before_token: HOOK_SESSION_CALLS_PER_MINUTE,
}

/**
 * Rate-limiter key of an environment's calls of one point's hook. Each point is counted
 * apart, so that a sign-in that asks two hooks uses one unit of each, and no point's calls
 * can use up another's.
 *
 * @param tenant - The environment.
 * @param point - The point; a sign-up's unless given (its key is what it has always been).
 * @returns The bucket key.
 */
export function hookCallsKey(
  tenant: Pick<Tenant, 'environmentId'>,
  point: HookPoint = 'before_sign_up'
): string {
  const key = `environment_hook:${tenant.environmentId}`
  return point === 'before_sign_up' ? key : `${key}:${point}`
}

/** What binds a sealed secret to its row: copied to another environment or hook, it fails. */
function aad(environmentId: string, hookId: string): string {
  return `${environmentId}:${hookId}`
}

/** The public view of a stored hook: everything but the secret. */
function view(record: HookRecord): Hook {
  return {
    id: record.id,
    point: record.point,
    url: record.url,
    enabled: record.enabled,
    deadlineMs: record.deadlineMs,
    failureMode: record.failureMode,
    lastFailedAt: record.lastFailedAt?.toISOString() ?? null,
    lastFailureReason: record.lastFailureReason,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}

/**
 * Refuse an address the server may not call, as the outbound guard judges it now. The answer
 * carries the guard's fixed word and nothing else: not the address, nor what it resolved to.
 *
 * @throws AuthError `hook.url_not_allowed`.
 */
async function requireCallable(deps: Pick<Deps, 'outbound'>, url: string): Promise<void> {
  try {
    await Outbound.check(deps.outbound, url)
  } catch (error) {
    if (error instanceof Outbound.OutboundError) {
      throw new AuthError('hook.url_not_allowed', { reason: error.reason })
    }
    throw error
  }
}

/** The stored hook, or the 404 every route answers for one that is not this environment's. */
async function requireHook(
  deps: Pick<Deps, 'hooks'>,
  tenant: Pick<Tenant, 'environmentId'>,
  id: string
): Promise<HookRecord> {
  const record = await deps.hooks.find(tenant.environmentId, id)
  if (!record) {
    throw new NotFoundError()
  }
  return record
}

/**
 * List the environment's hooks.
 *
 * @param deps - The hook store.
 * @param tenant - The environment.
 * @returns The hooks, oldest first, without their secrets.
 */
export async function list(
  deps: Pick<Deps, 'hooks'>,
  tenant: Pick<Tenant, 'environmentId'>
): Promise<Hook[]> {
  return (await deps.hooks.list(tenant.environmentId)).map(view)
}

/**
 * Read one hook.
 *
 * @param deps - The hook store.
 * @param tenant - The environment.
 * @param id - The hook.
 * @returns The hook, without its secret.
 * @throws NotFoundError when the environment has no hook with that id.
 */
export async function get(
  deps: Pick<Deps, 'hooks'>,
  tenant: Pick<Tenant, 'environmentId'>,
  id: string
): Promise<Hook> {
  return view(await requireHook(deps, tenant, id))
}

/**
 * Register a hook.
 *
 * The signing secret is made here (256 random bits, in the Standard Webhooks format), sealed
 * before it is stored, and returned in this result only: nothing reads it back out. The caller
 * cannot supply one. A hook registered to let through on failure is recorded as a weakening.
 *
 * @param deps - The hook store, the outbound guard's settings, the secret box, ids, clock.
 * @param tenant - The environment to register it in.
 * @param input - The point, the address, the deadline, the failure mode and the switch.
 * @param actor - Who registers it, for the audit log.
 * @returns The hook and its secret.
 * @throws AuthError `hook.url_not_allowed` when the server may not call the address.
 * @throws ConflictError when the environment already has a hook for the point.
 */
export async function create(
  deps: Pick<Deps, 'hooks' | 'outbound' | 'secretBox' | 'ids' | 'clock'>,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  input: CreateHookRequest,
  actor: Actor
): Promise<CreatedHook> {
  await requireCallable(deps, input.url)
  const id = deps.ids.next()
  const secret = newSigningSecret()
  const weakened = hookWeakenings(null, input).length > 0
  const activity = Audit.entry(deps, tenant, {
    type: 'hook.created',
    actor,
    target: { type: 'hook', id },
    data: {
      point: input.point,
      enabled: input.enabled,
      failureMode: input.failureMode,
      ...(weakened && { weakened }),
    },
  })
  const record = await deps.hooks.insert(
    {
      id,
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      point: input.point,
      url: input.url,
      secret: await deps.secretBox.seal(
        HOOK_SECRET_PURPOSE,
        new TextEncoder().encode(secret),
        aad(tenant.environmentId, id)
      ),
      enabled: input.enabled,
      deadlineMs: input.deadlineMs,
      failureMode: input.failureMode,
      lastFailedAt: null,
      lastFailureReason: null,
      createdAt: activity.occurredAt,
      updatedAt: activity.occurredAt,
    },
    activity
  )
  if (!record) {
    // The unique key decided: of two registrations at once, one is stored.
    throw new ConflictError({
      message: 'This environment already has a hook for that point. Change it, or remove it first.',
    })
  }
  return { ...view(record), secret }
}

/**
 * Change a hook's address, switch, deadline or failure mode.
 *
 * A new address is judged by the outbound guard before it is stored. The audit entry names the
 * fields that changed and never their values, and says `weakened` when the change lets through
 * what the hook used to stop (it was switched off, or set to let through on failure:
 * `hookWeakenings`). A request that changes nothing writes nothing. The point and the secret
 * are not something an update can touch.
 *
 * The write is made only over the hook as it was read: one that was switched off or loosened
 * meanwhile is not written over, so the record of a weakening is about the change made.
 *
 * @param deps - The hook store, the outbound guard's settings, ids and clock.
 * @param tenant - The environment.
 * @param id - The hook.
 * @param input - The fields to change.
 * @param actor - Who changes it, for the audit log.
 * @returns The hook as it is now, without its secret.
 * @throws NotFoundError when the environment has no hook with that id.
 * @throws AuthError `hook.url_not_allowed` when the server may not call the new address.
 * @throws ConflictError when the hook changed between the read and the write.
 */
export async function update(
  deps: Pick<Deps, 'hooks' | 'outbound' | 'ids' | 'clock'>,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  id: string,
  input: UpdateHookRequest,
  actor: Actor
): Promise<Hook> {
  const current = await requireHook(deps, tenant, id)
  const changes: HookChanges = {}
  if (input.url !== undefined && input.url !== current.url) {
    await requireCallable(deps, input.url)
    changes.url = input.url
  }
  if (input.enabled !== undefined && input.enabled !== current.enabled) {
    changes.enabled = input.enabled
  }
  if (input.deadlineMs !== undefined && input.deadlineMs !== current.deadlineMs) {
    changes.deadlineMs = input.deadlineMs
  }
  if (input.failureMode !== undefined && input.failureMode !== current.failureMode) {
    changes.failureMode = input.failureMode
  }
  const changed = HOOK_FIELDS.filter((field) => changes[field] !== undefined)
  if (changed.length === 0) {
    return view(current)
  }
  const weakened = hookWeakenings(current, { ...current, ...changes }).length > 0
  const updated = await deps.hooks.update(
    tenant.environmentId,
    id,
    current,
    changes,
    deps.clock.now(),
    Audit.entry(deps, tenant, {
      type: 'hook.updated',
      actor,
      target: { type: 'hook', id },
      data: { point: current.point, changed, ...(weakened && { weakened }) },
    })
  )
  if (!updated) {
    throw await gone(deps, tenant, id)
  }
  return view(updated)
}

/** Why a guarded write matched nothing: the hook was removed, or changed since it was read. */
async function gone(
  deps: Pick<Deps, 'hooks'>,
  tenant: Pick<Tenant, 'environmentId'>,
  id: string
): Promise<NotFoundError | ConflictError> {
  return (await deps.hooks.find(tenant.environmentId, id))
    ? new ConflictError({ message: 'The hook changed since it was read. Read it again and retry.' })
    : new NotFoundError()
}

/**
 * Remove a hook. It is asked no more: what it guarded happens as if there had been none.
 * Removing a hook that is on is recorded as a weakening.
 *
 * @param deps - The hook store, ids and clock.
 * @param tenant - The environment.
 * @param id - The hook.
 * @param actor - Who removes it, for the audit log.
 * @throws NotFoundError when the environment has no hook with that id.
 * @throws ConflictError when the hook changed between the read and the write.
 */
export async function remove(
  deps: Pick<Deps, 'hooks' | 'ids' | 'clock'>,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  id: string,
  actor: Actor
): Promise<void> {
  const current = await requireHook(deps, tenant, id)
  const weakened = hookWeakenings(current, null).length > 0
  const deleted = await deps.hooks.delete(
    tenant.environmentId,
    id,
    current,
    Audit.entry(deps, tenant, {
      type: 'hook.deleted',
      actor,
      target: { type: 'hook', id },
      data: { point: current.point, ...(weakened && { weakened }) },
    })
  )
  if (!deleted) {
    throw await gone(deps, tenant, id)
  }
}

/**
 * What a deciding hook said, as the only two things it can say. **This is all of such an
 * answer that leaves {@link call}**: not the parsed body, not a header, not the status.
 * Whatever else an endpoint puts in its answer has nowhere to go.
 */
type Verdict = { decision: 'allow' } | { decision: 'deny'; code: string | undefined }

/** What reading an answer's parsed body gave: what the hook said, or why that is nothing. */
type Read<S> = { said: S } | { failed: HookFailureReason }

/** One call of a hook: what it said, or why the call failed, in a fixed word. */
type Called<S> = Read<S>

/**
 * The verdict in a deciding hook's parsed body, or the failure when the body is not exactly an
 * answer: another shape, an unknown key. Built field by field from what the contract's schema
 * accepted.
 */
function readVerdict(parsed: unknown): Read<Verdict> {
  const answer = HookAnswerSchema.safeParse(parsed)
  if (!answer.success) {
    return { failed: 'answer_invalid' }
  }
  return {
    said:
      answer.data.decision === 'allow'
        ? { decision: 'allow' }
        : { decision: 'deny', code: answer.data.code },
  }
}

/** A hook's claims: checked, copied, with own keys only. */
export type HookClaims = Record<string, CustomClaimValue>

/**
 * Whether a claims hook's claims can be issued beside what else the session's tokens carry
 * under the namespace claim (its JWT template's claims): the size cap is on the whole. Given
 * by the caller that knows the template; without one, the claims are measured alone. It may
 * wait (the template may read the user), and is asked only for claims that passed every
 * other rule.
 */
export type ClaimsFit = (claims: HookClaims) => boolean | Promise<boolean>

/**
 * The claims in a claims hook's parsed body, **whole or not at all**: the body is judged as
 * it was parsed, by the contract's one definition (`readHookClaimsAnswer`: exactly one key,
 * every claim a custom claim key that is not reserved and one scalar, the cap), and then
 * against what they must fit beside. Any problem is the fixed word for it, and no claim of a
 * bad answer is kept.
 */
function readClaims(fits: ClaimsFit | undefined): (parsed: unknown) => Promise<Read<HookClaims>> {
  return async (parsed) => {
    const read = readHookClaimsAnswer(parsed)
    if ('problem' in read) {
      return { failed: read.problem }
    }
    return fits && !(await fits(read.claims))
      ? { failed: 'claims_too_large' }
      : { said: read.claims }
  }
}

type CallDeps = Pick<Deps, 'outbound' | 'secretBox' | 'ids' | 'clock'>

/** How one point's answer is read, and how many bytes of it. */
interface Answering<S> {
  /** Most bytes of the answer that are read. */
  maxBytes: number
  /** Reads the parsed body. The parsed body goes nowhere else. */
  read: (parsed: unknown) => Read<S> | Promise<Read<S>>
}

/**
 * Ask a hook one question.
 *
 * The request goes through the outbound guard, which judges the address again now, and is
 * signed in the same place a webhook delivery is (`signedHeaders`). It has the hook's deadline
 * (never more than {@link HOOK_MAX_DEADLINE_MS}, whatever the row says) and a small cap on the
 * answer. **Anything but a 2xx whose body is exactly an answer is a failure**: a redirect, an
 * error status (whatever its body says), a body over the cap (whatever its status), a body
 * that is not an answer, no answer in time, a guard refusal, a secret that does not open. A
 * failure is never read as an allow, as a denial or as "no claims".
 *
 * **Nothing of the answer leaves this function but what `answering.read` returns**: the
 * status, the headers and the parsed body are dropped here.
 *
 * @param deps - The outbound guard's settings, the secret box, ids and the clock.
 * @param hook - The hook, as stored.
 * @param data - The question's allow-listed data.
 * @param answering - The point's answer: its size cap and its reader.
 * @returns What the hook said, or the fixed word for why it said nothing usable.
 */
async function call<P extends HookRecord['point'], S>(
  deps: CallDeps,
  hook: HookRecord & { point: P },
  data: HookQuestionOf<P>['data'],
  answering: Answering<S>
): Promise<Called<S>> {
  const opened = await openSigningSecret(
    deps.secretBox,
    HOOK_SECRET_PURPOSE,
    hook.secret,
    aad(hook.environmentId, hook.id)
  )
  if (!opened) {
    return { failed: 'secret_unreadable' }
  }
  const askedAt = deps.clock.now()
  const id = deps.ids.next()
  const body = JSON.stringify({
    id,
    type: HOOK_QUESTION_TYPES[hook.point],
    schemaVersion: HOOK_SCHEMA_VERSION,
    occurredAt: askedAt.toISOString(),
    data,
  })
  const keys = { current: opened.key, previous: null, previousUnreadable: false }
  try {
    const answer = await Outbound.request(deps.outbound, hook.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(await signedHeaders(keys, id, askedAt, body)),
      },
      body,
      timeoutMs: Math.min(hook.deadlineMs, HOOK_MAX_DEADLINE_MS),
      maxResponseBytes: answering.maxBytes,
    })
    if (answer.status < 200 || answer.status >= 300) {
      return { failed: 'status_not_ok' }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(answer.body))
    } catch {
      return { failed: 'answer_invalid' }
    }
    return await answering.read(parsed)
  } catch (error) {
    if (error instanceof Outbound.OutboundError) {
      return { failed: error.reason }
    }
    throw error
  }
}

type AskDeps = CallDeps & Pick<Deps, 'hooks' | 'rateLimiter'>

/**
 * What asking a point's hook came to, before the point gives it a meaning:
 *
 * - `none`: the environment has no hook for the point, or it is off. Nothing was called or
 *   counted.
 * - `said`: the hook answered as its point's contract says.
 * - `bypassed`: the call failed and the hook lets through on failure. The failure is noted on
 *   the hook and logged.
 *
 * A failed call of a hook that refuses on failure is thrown (`hook.unavailable`), never
 * returned: no caller can read a failure as anything else by forgetting a branch.
 */
type Asked<S> =
  | { outcome: 'none' }
  | { outcome: 'said'; said: S; hook: HookRecord }
  | { outcome: 'bypassed' }

/**
 * Ask the environment's hook for a point, if it has one that is on: the part every point
 * shares. The hook is read now (so one changed since an attempt started applies as it is at
 * this moment), the call is counted against the point's ceiling just before it is made, a
 * failure is noted on the hook, and the hook's failure mode decides what a failure does.
 *
 * @param what - What is being asked about, for the log lines (`a sign-in`).
 * @throws AuthError `hook.unavailable` when the call failed and the hook refuses on failure.
 * @throws RateLimitError when the environment's calls of this point are over their ceiling.
 * @throws ServiceUnavailableError when the limiter cannot count.
 */
async function ask<P extends HookPoint, S>(
  deps: AskDeps,
  tenant: Pick<Tenant, 'environmentId'>,
  point: P,
  data: HookQuestionOf<P>['data'],
  answering: Answering<S>,
  what: string
): Promise<Asked<S>> {
  const found = await deps.hooks.findByPoint(tenant.environmentId, point)
  if (!found?.enabled) {
    return { outcome: 'none' }
  }
  const hook = { ...found, point }
  const counted = await deps.rateLimiter.hit(
    hookCallsKey(tenant, point),
    HOOK_POINT_CALLS_PER_MINUTE[point],
    60_000
  )
  if (!counted.allowed) {
    throw new RateLimitError(counted.retryAfterMs)
  }
  const called = await call(deps, hook, data, answering)
  if ('said' in called) {
    return { outcome: 'said', said: called.said, hook }
  }
  const ids = { environmentId: hook.environmentId, hookId: hook.id, point }
  await noteFailure(deps, hook, called.failed)
  if (hook.failureMode === 'allow') {
    logger.warn(`a hook failed and ${what} was let through: the hook allows on failure`, {
      ...ids,
      reason: called.failed,
    })
    return { outcome: 'bypassed' }
  }
  logger.warn(`a hook failed and ${what} was refused`, { ...ids, reason: called.failed })
  throw new AuthError('hook.unavailable')
}

/** A deciding point's answer: a kilobyte at most, read as a verdict. */
const DECISION: Answering<Verdict> = { maxBytes: HOOK_MAX_RESPONSE_BYTES, read: readVerdict }

/**
 * What a caller may do after asking a deciding hook: go on (`clear`: the hook allowed it, or
 * there is none to ask), or go on **and say that the check was down** (`bypassed`: the call
 * failed and the hook lets through on failure). A refusal is thrown, never returned.
 *
 * Two words, and nothing of the hook's answer: this is the whole of what a deciding hook can
 * do. It cannot reach the user record, an attempt's proven factors or the session.
 */
export type Clearance = 'clear' | 'bypassed'

/**
 * The two-word outcome of a deciding point: the denial is thrown with the operator's code,
 * and nothing else of the verdict goes anywhere.
 */
function clearance(asked: Asked<Verdict>, what: string): Clearance {
  if (asked.outcome === 'none') {
    return 'clear'
  }
  if (asked.outcome === 'bypassed') {
    return 'bypassed'
  }
  if (asked.said.decision === 'allow') {
    return 'clear'
  }
  const { code } = asked.said
  logger.info(`a hook denied ${what}`, {
    environmentId: asked.hook.environmentId,
    hookId: asked.hook.id,
    point: asked.hook.point,
    ...(code !== undefined && { code }),
  })
  throw new AuthError('hook.denied', code === undefined ? undefined : { code })
}

/**
 * What a `before_sign_up` hook is asked about: the contract's allow-list
 * (`HookBeforeSignUpDataSchema`), and nothing else a caller might have at hand.
 */
export type SignUpQuestion = HookQuestionOf<'before_sign_up'>['data']

/** What a sign-up may do after asking: see {@link Clearance}. */
export type SignUpClearance = Clearance

/**
 * Ask the environment's `before_sign_up` hook whether an account may be created.
 *
 * **Call it only where a new account is about to be created for an address the caller has
 * already proven** (the flow's `verifyEmail` after the code, `OAuth.resolveAccount` on its
 * "no user has that address" row), and never from a step that answers the same for every
 * address: called earlier, whether a hook was asked would tell an observer whether the
 * address has an account (ADR 0035). An administrator's `Users.create` does not call it.
 *
 * The hook is read now, so one that was removed, switched off or changed since the attempt
 * started is asked (or not) as it is at this moment. A hook that is off, or absent, costs
 * nothing and is not counted.
 *
 * @param deps - The hook store, the limiter, the outbound guard's settings, the secret box,
 *   ids and the clock.
 * @param tenant - The environment. Another environment's hook is never asked.
 * @param question - The address, how the sign-up is made, the client kind and the IP address.
 * @returns `clear` or `bypassed`.
 * @throws AuthError `hook.denied` when the hook refused; `params.code` is its message code,
 *   when it gave one. `hook.unavailable` when the call failed and the hook refuses on failure.
 * @throws RateLimitError when the environment's hook calls are over their ceiling.
 * @throws ServiceUnavailableError when the limiter cannot count.
 */
export async function beforeSignUp(
  deps: AskDeps,
  tenant: Pick<Tenant, 'environmentId'>,
  question: SignUpQuestion
): Promise<SignUpClearance> {
  const asked = await ask(
    deps,
    tenant,
    'before_sign_up',
    // Named field by field: a caller's object with more on it sends no more than this.
    {
      email: question.email,
      method: question.method,
      client: question.client,
      ipAddress: question.ipAddress,
    },
    DECISION,
    'a sign-up'
  )
  return clearance(asked, 'a sign-up')
}

/**
 * What a `before_session` hook is asked about: the contract's allow-list
 * (`HookBeforeSessionDataSchema`), and nothing else a caller might have at hand.
 */
export type SessionQuestion = HookQuestionOf<'before_session'>['data']

/**
 * Ask the environment's `before_session` hook whether a sign-in may get its session.
 *
 * **Call it only from the flow engine's `finish`**, the one place a sign-in creates a
 * session: after every factor the sign-in needed was proven (first factor, second factor,
 * an enrolment) and immediately before `Sessions.create`. Never earlier. Asked before the
 * factors are proven, whether it was asked would tell someone without the credentials about
 * the account, and an allow would be standing in for a factor. Never for a refresh, a
 * step-up or an administrator's act: none of them is a sign-in.
 *
 * It decides and nothing more: the caller gets one of two words. The answer cannot name a
 * user, add a method to what was proven, mark an address verified or pick a profile.
 *
 * @param deps - The hook store, the limiter, the outbound guard's settings, the secret box,
 *   ids and the clock.
 * @param tenant - The environment. Another environment's hook is never asked.
 * @param question - The user, the client kind, the profile, what was proven, whether the
 *   session ends a sign-up, and the IP address.
 * @returns `clear` or `bypassed`.
 * @throws AuthError `hook.denied` when the hook refused; `params.code` is its message code,
 *   when it gave one. `hook.unavailable` when the call failed and the hook refuses on failure.
 * @throws RateLimitError when the environment's calls of this point are over their ceiling.
 * @throws ServiceUnavailableError when the limiter cannot count.
 */
export async function beforeSession(
  deps: AskDeps,
  tenant: Pick<Tenant, 'environmentId'>,
  question: SessionQuestion
): Promise<Clearance> {
  const asked = await ask(
    deps,
    tenant,
    'before_session',
    // Named field by field: a caller's object with more on it sends no more than this.
    {
      userId: question.userId,
      client: question.client,
      profile: question.profile,
      amr: [...question.amr],
      signUp: question.signUp,
      ipAddress: question.ipAddress,
    },
    DECISION,
    'a sign-in'
  )
  return clearance(asked, 'a sign-in')
}

/**
 * What a `before_token` hook is asked about: the contract's allow-list
 * (`HookBeforeTokenDataSchema`), and nothing else a caller might have at hand.
 */
export type TokenQuestion = HookQuestionOf<'before_token'>['data']

/**
 * What asking the claims hook came to. **All a claims hook can do to a session is in
 * `claims`**, and those are issued only inside the namespace claim: it cannot deny, and it
 * cannot reach the subject, the methods, the profile or any other claim.
 */
export interface TokenClaims {
  /**
   * The claims to store on the session and issue with its tokens, or `null` for none: no
   * hook, a hook that is off, one that answered with none, or one that failed and lets
   * through on failure.
   */
  claims: HookClaims | null
  /** Whether a hook was called: the claims (or their absence) are then an answer about `amr`. */
  asked: boolean
  /** The call failed and the hook lets through on failure: the session goes without its claims. */
  bypassed: boolean
}

/**
 * Ask the environment's `before_token` hook for the claims of a session.
 *
 * **Call it only from the session service, when a session is created and when its user
 * proves a factor again** (`Sessions.create`, `Sessions.recordAuthentication`). Its result is
 * stored on the session and issued from there: **never call it from a refresh**, from the
 * grace-window replay or from the check of a stateful session, which run about once a minute
 * for every session there is.
 *
 * Whole or nothing: an answer with one claim that breaks a rule, or claims that do not fit,
 * is a failed call and none of its claims is returned. A failure is never read as "no claims"
 * unless the hook says to let through on failure, and then the result says `bypassed`.
 *
 * @param deps - The hook store, the limiter, the outbound guard's settings, the secret box,
 *   ids and the clock.
 * @param tenant - The environment. Another environment's hook is never asked.
 * @param question - The user, the session, the client kind, the profile and what the session
 *   has proven.
 * @param fits - Whether the claims fit beside the session's template claims; without it they
 *   are measured alone.
 * @returns The claims, whether a hook was asked, and whether it was bypassed.
 * @throws AuthError `hook.unavailable` when the call failed and the hook refuses on failure.
 * @throws RateLimitError when the environment's calls of this point are over their ceiling.
 * @throws ServiceUnavailableError when the limiter cannot count.
 */
export async function beforeToken(
  deps: AskDeps,
  tenant: Pick<Tenant, 'environmentId'>,
  question: TokenQuestion,
  fits?: ClaimsFit
): Promise<TokenClaims> {
  const asked = await ask(
    deps,
    tenant,
    'before_token',
    // Named field by field: a caller's object with more on it sends no more than this.
    {
      userId: question.userId,
      sessionId: question.sessionId,
      client: question.client,
      profile: question.profile,
      amr: [...question.amr],
    },
    { maxBytes: HOOK_MAX_CLAIMS_RESPONSE_BYTES, read: readClaims(fits) },
    'a token'
  )
  if (asked.outcome === 'none') {
    return { claims: null, asked: false, bypassed: false }
  }
  if (asked.outcome === 'bypassed') {
    return { claims: null, asked: true, bypassed: true }
  }
  // An answer with no claims is stored as none: a session without claims is one thing.
  const claims = Object.keys(asked.said).length > 0 ? asked.said : null
  return { claims, asked: true, bypassed: false }
}

/** Note a failed call on the hook. Bookkeeping: failing to write it changes no decision. */
async function noteFailure(
  deps: Pick<Deps, 'hooks' | 'clock'>,
  hook: HookRecord,
  reason: HookFailureReason
): Promise<void> {
  try {
    await deps.hooks.noteFailure(hook.environmentId, hook.id, deps.clock.now(), reason)
  } catch (error) {
    logger.warn('could not note that a hook failed', {
      environmentId: hook.environmentId,
      hookId: hook.id,
      err: errorReason(error),
    })
  }
}
