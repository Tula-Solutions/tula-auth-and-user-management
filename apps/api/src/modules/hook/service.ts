import {
  type CreatedHook,
  type CreateHookRequest,
  HOOK_FIELDS,
  HOOK_MAX_DEADLINE_MS,
  HOOK_QUESTION_TYPES,
  HOOK_SCHEMA_VERSION,
  type Hook,
  HookAnswerSchema,
  type HookFailureReason,
  type HookQuestionOf,
  hookWeakenings,
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
// whose answer decides whether it does. This module registers them (`/v1/admin/hooks`) and
// asks them. The one point so far is `before_sign_up`, asked by the flow engine and by
// `OAuth.resolveAccount` where a sign-up is about to create an account.

/** Key-separation label of the sealed signing secrets (`~/lib/secret-box`). Not the webhooks'. */
export const HOOK_SECRET_PURPOSE = 'hook-secrets'

/**
 * Most bytes of an answer that are read. An answer is `{"decision":"deny","code":"…"}` at its
 * longest, about a hundred bytes; anything past this is not an answer.
 */
export const HOOK_MAX_RESPONSE_BYTES = 1024

/**
 * Most calls of its hooks one environment causes in a minute, across all callers. The flow's
 * own limits already bound them (a call needs a proven address); this is the bound that is
 * about the operator's endpoint and does not depend on which path led to the call. The same
 * number as the sign-up ceiling: ten a second.
 */
export const HOOK_CALLS_PER_MINUTE = 600

/**
 * Rate-limiter key of an environment's hook calls.
 *
 * @param tenant - The environment.
 * @returns The bucket key.
 */
export function hookCallsKey(tenant: Pick<Tenant, 'environmentId'>): string {
  return `environment_hook:${tenant.environmentId}`
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
 * What a hook said, as the only two things it can say. **This is all of an answer that leaves
 * {@link call}**: not the parsed body, not a header, not the status. Whatever else an endpoint
 * puts in its answer has nowhere to go.
 */
type Verdict = { decision: 'allow' } | { decision: 'deny'; code: string | undefined }

/** One call of a hook: what it said, or why the call failed, in a fixed word. */
type Called = { verdict: Verdict } | { failed: HookFailureReason }

/**
 * The verdict in an answer's body, or `null` when the body is not exactly an answer: not
 * UTF-8, not JSON, another shape, an unknown key. Built field by field from what the
 * contract's schema accepted.
 */
function verdictOf(body: Uint8Array): Verdict | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
  } catch {
    return null
  }
  const answer = HookAnswerSchema.safeParse(parsed)
  if (!answer.success) {
    return null
  }
  return answer.data.decision === 'allow'
    ? { decision: 'allow' }
    : { decision: 'deny', code: answer.data.code }
}

type CallDeps = Pick<Deps, 'outbound' | 'secretBox' | 'ids' | 'clock'>

/**
 * Ask a hook one question.
 *
 * The request goes through the outbound guard, which judges the address again now, and is
 * signed in the same place a webhook delivery is (`signedHeaders`). It has the hook's deadline
 * (never more than {@link HOOK_MAX_DEADLINE_MS}, whatever the row says) and a small cap on the
 * answer. **Anything but a 2xx whose body is exactly an answer is a failure**: a redirect, an
 * error status (whatever its body says), a body over the cap (whatever its status), a body
 * that is not an answer, no answer in time, a guard refusal, a secret that does not open. A
 * failure is never read as an allow or as a denial.
 *
 * @param deps - The outbound guard's settings, the secret box, ids and the clock.
 * @param hook - The hook, as stored.
 * @param data - The question's allow-listed data.
 * @returns The verdict, or the fixed word for why there is none.
 */
async function call<P extends HookRecord['point']>(
  deps: CallDeps,
  hook: HookRecord & { point: P },
  data: HookQuestionOf<P>['data']
): Promise<Called> {
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
      maxResponseBytes: HOOK_MAX_RESPONSE_BYTES,
    })
    if (answer.status < 200 || answer.status >= 300) {
      return { failed: 'status_not_ok' }
    }
    const verdict = verdictOf(answer.body)
    return verdict ? { verdict } : { failed: 'answer_invalid' }
  } catch (error) {
    if (error instanceof Outbound.OutboundError) {
      return { failed: error.reason }
    }
    throw error
  }
}

/**
 * What a `before_sign_up` hook is asked about: the contract's allow-list
 * (`HookBeforeSignUpDataSchema`), and nothing else a caller might have at hand.
 */
export type SignUpQuestion = HookQuestionOf<'before_sign_up'>['data']

/**
 * What the flow may do after asking: create the account (`clear`: the hook allowed it, or
 * there is none to ask), or create it **and say that the check was down** (`bypassed`: the
 * call failed and the hook lets through on failure). A refusal is thrown, never returned.
 *
 * Two words, and nothing of the hook's answer: this is the whole of what a hook can do to a
 * sign-up. It cannot reach the user record, the attempt's proven factors or the session.
 */
export type SignUpClearance = 'clear' | 'bypassed'

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
  deps: CallDeps & Pick<Deps, 'hooks' | 'rateLimiter'>,
  tenant: Pick<Tenant, 'environmentId'>,
  question: SignUpQuestion
): Promise<SignUpClearance> {
  const found = await deps.hooks.findByPoint(tenant.environmentId, 'before_sign_up')
  if (!found?.enabled) {
    return 'clear'
  }
  const hook = { ...found, point: 'before_sign_up' as const }
  const counted = await deps.rateLimiter.hit(hookCallsKey(tenant), HOOK_CALLS_PER_MINUTE, 60_000)
  if (!counted.allowed) {
    throw new RateLimitError(counted.retryAfterMs)
  }
  // Named field by field: a caller's object with more on it sends no more than this.
  const called = await call(deps, hook, {
    email: question.email,
    method: question.method,
    client: question.client,
    ipAddress: question.ipAddress,
  })
  const ids = { environmentId: hook.environmentId, hookId: hook.id }
  if ('verdict' in called) {
    if (called.verdict.decision === 'allow') {
      return 'clear'
    }
    const { code } = called.verdict
    logger.info('a hook denied a sign-up', { ...ids, ...(code !== undefined && { code }) })
    throw new AuthError('hook.denied', code === undefined ? undefined : { code })
  }
  await noteFailure(deps, hook, called.failed)
  if (hook.failureMode === 'allow') {
    logger.warn('a hook failed and a sign-up was let through: the hook allows on failure', {
      ...ids,
      reason: called.failed,
    })
    return 'bypassed'
  }
  logger.warn('a hook failed and a sign-up was refused', { ...ids, reason: called.failed })
  throw new AuthError('hook.unavailable')
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
