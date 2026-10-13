import {
  type EnvironmentSettings,
  type ErrorCode,
  evaluatePassword,
  type FlowAttempt,
  HOOK_MAX_DEADLINE_MS,
  SIGN_IN_TEST_STEPS,
  type SignInTestCleanup,
  type SignInTestOutcome,
  type SignInTestReason,
  type SignInTestReport,
  type SignInTestStep,
  type SignInTestStepResult,
  testAddress,
  testSignInAllowed,
} from '@tula-tech/contract'
import type { Deps, Tenant } from '~/dependencies'
import { AuthError, RateLimitError, ServiceException } from '~/exceptions'
import type { Actor } from '~/lib/actor'
import { captureMail, type MailCapture } from '~/lib/captured-mail'
import { randomToken } from '~/lib/crypto'
import { testAddressPermit } from '~/lib/email'
import * as logger from '~/lib/logger'
import * as Audit from '~/modules/audit/service'
import * as Flows from '~/modules/flow/service'
import * as Sessions from '~/modules/session/service'
import * as Settings from '~/modules/settings/service'
import * as Users from '~/modules/user/service'

/**
 * How many sign-in tests one credential (a key, or a dashboard session) may run in an hour
 * (ADR 0058). A test makes a user, asks the
 * environment's hooks and sends its events to the environment's receivers: a handful an hour
 * is what checking an integration takes, and an agent talked into repeating itself gets no
 * further.
 */
export const SIGN_IN_TESTS_PER_KEY_PER_HOUR = 4

/** How many sign-in tests an environment runs in an hour, whichever keys ask. */
export const SIGN_IN_TESTS_PER_ENVIRONMENT_PER_HOUR = 8

/**
 * The window in which an environment runs one test: what "no second run while one is in
 * flight" is made of. Longer than a run can last ({@link SIGN_IN_TEST_DEADLINE_MS} and
 * {@link SIGN_IN_TEST_CLEANUP_MS} twice over), counted in the shared limiter, so it holds
 * across instances and needs nobody to release it.
 */
export const SIGN_IN_TEST_RUN_WINDOW_MS = 60_000

/** How long the steps of one run may take together, before the deletion. */
export const SIGN_IN_TEST_DEADLINE_MS = 40_000

/**
 * How long a step's own work may take: what it does besides waiting for a hook. A step that
 * asks hooks gets {@link SIGN_IN_TEST_HOOK_MS} more for each ({@link stepLimitMs}).
 */
export const SIGN_IN_TEST_STEP_MS = 16_000

/**
 * What a step is given for each hook it may ask: the longest a hook may take to answer (ADR
 * 0035), so that an integration that is slow and working is never reported as `timeout`.
 */
export const SIGN_IN_TEST_HOOK_MS = HOOK_MAX_DEADLINE_MS

/**
 * How many hooks a step may ask, one after another (ADR 0035): the verification of a sign-up
 * creates the account and its first session (`before_sign_up`, `before_session`,
 * `before_token`), the first factor of the sign-in a session (`before_session`,
 * `before_token`). No other step asks one.
 *
 * The sum that keeps a run inside what waits for it (ADR 0058, "Limits"):
 * - `verify_email` has 16 s + 3 × 5 s = 31 s and `first_factor` 16 s + 2 × 5 s = 26 s: the
 *   hooks' worst case (15 s, 10 s) and 16 s over it, where there was one second;
 * - the steps together have {@link SIGN_IN_TEST_DEADLINE_MS} (40 s), whatever their own
 *   limits add up to: the hooks' worst case in one run is 25 s, which leaves 15 s for all
 *   the rest;
 * - the end of a run has {@link SIGN_IN_TEST_CLEANUP_MS} twice (16 s): an answer inside 56 s,
 *   under the MCP tool's 60 s (`SIGN_IN_TEST_TIMEOUT_MS`) and inside the window of a minute
 *   ({@link SIGN_IN_TEST_RUN_WINDOW_MS}).
 */
export const SIGN_IN_TEST_HOOKS_ASKED: Readonly<Partial<Record<SignInTestStep, number>>> = {
  verify_email: 3,
  first_factor: 2,
}

/**
 * The steps that can create the throwaway user, stated once. Only the verification of the
 * sign-up does (`Flows.verifyEmail` is where `users.create` is called for a sign-up): the
 * sign-up's start makes an attempt and an email, and the sign-in's steps find a user or none.
 * A run that left one of **these** at its time limit cannot say that no user will be made;
 * a run that left any other can.
 */
export const SIGN_IN_TEST_STEPS_THAT_CREATE: ReadonlySet<SignInTestStep> = new Set(['verify_email'])

/**
 * How long the end of a run may take, twice at most: once waiting for a step that was left
 * at its time limit, once for the deletion itself.
 */
export const SIGN_IN_TEST_CLEANUP_MS = 8_000

/**
 * How long {@link settled} waits for the steps that were left at their time limit: as long as
 * the end of a run waits for one, shorter than a step's own limit and than the shutdown
 * timeout (10 s), so a stuck step never holds a process that is stopping.
 */
export const SIGN_IN_TEST_SETTLE_MS = SIGN_IN_TEST_CLEANUP_MS

/**
 * The user agent recorded with the flow's own entries of a run. Fixed: the agent's own
 * address and user agent are on the run's entries, never under the throwaway user's id.
 */
export const SIGN_IN_TEST_USER_AGENT = 'tula-sign-in-test'

/** The time limits of a run. Only a test passes its own. */
export interface SignInTestLimits {
  deadlineMs: number
  /** A step's own work ({@link SIGN_IN_TEST_STEP_MS}). */
  stepMs: number
  /** What a step gets on top for each hook it may ask ({@link SIGN_IN_TEST_HOOK_MS}). */
  hookMs: number
  cleanupMs: number
}

/**
 * The time limit of one step: its own work, and the longest wait for every hook it may ask.
 *
 * @param step - The step.
 * @param limits - The run's limits.
 * @returns The limit in milliseconds, before the run's deadline cuts it.
 */
export function stepLimitMs(
  step: SignInTestStep,
  limits: Pick<SignInTestLimits, 'stepMs' | 'hookMs'> = {
    stepMs: SIGN_IN_TEST_STEP_MS,
    hookMs: SIGN_IN_TEST_HOOK_MS,
  }
): number {
  return limits.stepMs + (SIGN_IN_TEST_HOOKS_ASKED[step] ?? 0) * limits.hookMs
}

/** A step that was left at its time limit, and whether its work has ended since. */
interface Abandoned {
  step: SignInTestStep
  work: Promise<unknown>
  ended: boolean
}

/**
 * The work of steps left at their limit that has not ended, across runs: it goes on after its
 * run answered, and may write.
 */
const atWork = new Set<Promise<unknown>>()

/**
 * Wait for the steps that runs left at their time limit, for a bounded time
 * ({@link SIGN_IN_TEST_SETTLE_MS}).
 *
 * Such a step goes on after the run answered and what it does is a write (the verification
 * creates the account). `closeApi` awaits this after the listener stops and before the pool
 * closes; tests await it before they look at what a late step left. A step still at work when
 * the wait ends is left to the shutdown: what it makes is the retention job's to remove.
 *
 * @param maxMs - The longest wait. Only a test passes its own.
 */
export async function settled(maxMs: number = SIGN_IN_TEST_SETTLE_MS): Promise<void> {
  if (atWork.size === 0) {
    return
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    Promise.allSettled([...atWork]),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, maxMs)
    }),
  ])
  clearTimeout(timer)
}

/** What a run may be given beside who asked. */
export interface RunOptions {
  /** Aborted when the caller went away: the steps not yet run are skipped, the deletion is not. */
  signal?: AbortSignal
  /** Time limits other than the constants, for tests. */
  limits?: Partial<SignInTestLimits>
}

/** How a step that ran ended, and what the steps after it may use. */
type StepEnd =
  | { outcome: 'passed' }
  | { outcome: 'failed'; code?: ErrorCode; reason?: SignInTestReason }
  | { outcome: 'not_run'; reason: SignInTestReason }

/**
 * Whether sign-in tests are allowed in an environment (ADR 0058): the environment's own
 * `agents.testSignIn`, and for `null` the default of its kind (on in development, off in
 * production). The kind is the environment's row, never `ENVIRONMENT` or `NODE_ENV`; an
 * environment that cannot be found is treated as production.
 *
 * The setting is read **past the settings cache**: switched off through one instance, a run
 * asked of another would otherwise still make a user for as long as that instance's copy
 * lives (up to 30 seconds). A run is rare, so the read costs nothing that matters.
 *
 * @param deps - Settings store, environments and config.
 * @param tenant - The environment.
 * @returns Whether a test may run.
 */
export async function allowed(
  deps: Pick<Deps, 'environmentSettings' | 'environments' | 'config'>,
  tenant: Pick<Tenant, 'environmentId'>
): Promise<boolean> {
  const [state, environment] = await Promise.all([
    Settings.get(deps, tenant, true),
    deps.environments.findById(tenant.environmentId),
  ])
  return testSignInAllowed(state.settings.agents.testSignIn, environment?.kind ?? 'production')
}

/**
 * Refuse a run that may not start, before anything is created (ADR 0058, "Limits"): the
 * setting, the caller's hour, the environment's hour, then the one run a minute. A refusal at
 * one is counted by none of the later ones, and a limiter that cannot count refuses.
 */
async function admit(deps: Deps, tenant: Tenant, actor: Actor): Promise<void> {
  if (!(await allowed(deps, tenant))) {
    throw new AuthError('auth.forbidden', { reason: 'test_sign_in_disabled' })
  }
  const hour = 3_600_000
  const limits: [key: string, limit: number, windowMs: number][] = [
    // The credential that asked: a key's id, or a dashboard session's. Ids only.
    [`sign_in_test:by:${actor.type}:${actor.id ?? 'none'}`, SIGN_IN_TESTS_PER_KEY_PER_HOUR, hour],
    [`sign_in_test:env:${tenant.environmentId}`, SIGN_IN_TESTS_PER_ENVIRONMENT_PER_HOUR, hour],
    [`sign_in_test:run:${tenant.environmentId}`, 1, SIGN_IN_TEST_RUN_WINDOW_MS],
  ]
  for (const [key, limit, windowMs] of limits) {
    const decision = await deps.rateLimiter.hit(key, limit, windowMs)
    if (!decision.allowed) {
      throw new RateLimitError(decision.retryAfterMs)
    }
  }
}

/** Thirty-two hexadecimal characters from the CSPRNG: the local part of a run's address. */
function randomHex(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex')
}

/**
 * A password for the throwaway user that the environment's policy accepts: 32 random
 * characters, one of every class a policy can ask for, cut to the policy's longest. Where
 * a policy still refuses it (a `maxLength` too short to hold every class), the sign-up says
 * so with the policy's own code, which is the report.
 */
function password(policy: EnvironmentSettings['password']): string {
  const classes = `aA1${[...policy.specialChars][0] ?? ''}`
  let random = randomToken(24)
  while (random.length + classes.length < policy.minLength) {
    random += randomToken(24)
  }
  const made = `${classes}${random}`.slice(0, Math.max(policy.maxLength, classes.length))
  return evaluatePassword(policy, made).ok ? made : `${classes}${randomToken(24)}`
}

/** The contract's code of an error a step threw; `internal` for anything that has none. */
function codeOf(error: unknown): ErrorCode {
  return error instanceof ServiceException ? error.code : 'internal'
}

/** The newest captured code of a kind of message. */
function capturedCode(mail: MailCapture, type: string): string | undefined {
  return mail.captured.findLast((message) => message.type === type && message.code)?.code
}

/** What a step that stopped short of a session says about the steps that need one. */
function withoutSession(attempt: FlowAttempt): SignInTestReason {
  const { status } = attempt.step
  return status === 'needs_second_factor' || status === 'needs_factor_enrolment'
    ? 'second_factor_required'
    : 'no_session'
}

/**
 * Sign a throwaway user up and in through the real flow, delete it, and report each step
 * (ADR 0058).
 *
 * Everything the flow handles on the way (the emailed code, the attempts' secrets, the
 * password, the sessions' tokens) is a local variable of this function and is in nothing it
 * returns, records or logs. The user holds an address of the reserved test domain, is made
 * only by this function (it alone has the permit `parseEmail` asks for) and is deleted in a
 * `finally`, looked up by that address, whatever a step did.
 *
 * @param deps - Everything the flow, the sessions and the users need.
 * @param tenant - The environment, and the key that asked.
 * @param actor - Who asked: an `agent`, an `admin` for a secret key, an `instance_admin` for
 *   the dashboard. Recorded on the run's two entries and on the deletion, and what the
 *   caller's own limit is counted under.
 * @param options - The caller's abort signal; time limits for tests.
 * @returns The report: one entry per step of `SIGN_IN_TEST_STEPS`, in order.
 * @throws AuthError `auth.forbidden` (`params.reason: 'test_sign_in_disabled'`) where the
 *   environment does not allow it.
 * @throws RateLimitError when the key, the environment or the minute has had its runs.
 * @throws ServiceUnavailableError when a limit cannot be counted.
 */
export async function run(
  deps: Deps,
  tenant: Tenant,
  actor: Actor,
  options: RunOptions = {}
): Promise<SignInTestReport> {
  await admit(deps, tenant, actor)
  const limits: SignInTestLimits = {
    deadlineMs: SIGN_IN_TEST_DEADLINE_MS,
    stepMs: SIGN_IN_TEST_STEP_MS,
    hookMs: SIGN_IN_TEST_HOOK_MS,
    cleanupMs: SIGN_IN_TEST_CLEANUP_MS,
    ...options.limits,
  }
  const environment = { type: 'environment', id: tenant.environmentId } as const
  await deps.users.reportSignInTest(
    tenant.environmentId,
    Audit.entry(deps, tenant, { type: 'sign_in_test.started', actor, target: environment })
  )

  const address = testAddress(randomHex())
  const mail = captureMail()
  // The flow's own mailer for this run only: the code is read here and nothing is sent.
  const flow: Deps = { ...deps, mailer: mail }
  const context: Flows.ClientContext = {
    client: 'web',
    userAgent: SIGN_IN_TEST_USER_AGENT,
    ipAddress: null,
    originAllowed: true,
    origin: null,
    testAddress: testAddressPermit(),
  }
  const results = new Map<SignInTestStep, SignInTestStepResult>()
  /** Steps left at their time limit: they may still finish, and one may still create the user. */
  const abandoned: Abandoned[] = []
  const startedAt = deps.clock.now().getTime()

  /**
   * Run one step under its time limit and record how it ended. A step that is not due (the
   * caller left, the run's time is spent) is recorded as not run and its work never starts.
   */
  async function step(name: SignInTestStep, work: () => Promise<StepEnd>): Promise<boolean> {
    const began = deps.clock.now().getTime()
    const left = limits.deadlineMs - (began - startedAt)
    let end: StepEnd
    if (options.signal?.aborted) {
      end = { outcome: 'not_run', reason: 'cancelled' }
    } else if (left <= 0) {
      end = { outcome: 'not_run', reason: 'timeout' }
    } else {
      end = await bounded(work(), Math.min(stepLimitMs(name, limits), left), (late) => {
        const entry: Abandoned = { step: name, work: late, ended: false }
        abandoned.push(entry)
        atWork.add(late)
        void late.then(() => {
          entry.ended = true
          atWork.delete(late)
        })
      })
    }
    results.set(name, {
      step: name,
      durationMs: Math.max(0, deps.clock.now().getTime() - began),
      ...end,
    })
    return end.outcome === 'passed'
  }
  const skip = (name: SignInTestStep, reason: SignInTestReason) => {
    results.set(name, { step: name, outcome: 'not_run', durationMs: 0, reason })
  }

  let userId: string | null = null
  let cleanup: SignInTestCleanup = 'none'
  try {
    const settings = await Settings.current(deps, tenant)
    const secret = settings.signIn.methods.password.enabled
      ? password(settings.password)
      : undefined

    let signUp: Flows.FlowResult | undefined
    let session: Sessions.IssuedSession | undefined
    let afterSignUp: SignInTestReason = 'earlier_step'
    let verified = false
    if (
      await step('sign_up', async () => {
        signUp = await Flows.signUp(flow, tenant, { email: address, password: secret }, context)
        return signUp.attempt.step.status === 'needs_email_verification'
          ? { outcome: 'passed' }
          : { outcome: 'failed', code: 'flow.invalid_step' }
      })
    ) {
      verified = await step('verify_email', async () => {
        const code = capturedCode(mail, 'email_verification')
        const attempt = signUp?.attempt
        if (!code || !attempt) {
          return { outcome: 'failed', code: 'internal' }
        }
        const result = await Flows.verifyEmail(
          flow,
          tenant,
          'sign_up',
          { id: attempt.id, secret: attempt.attemptSecret },
          code,
          context
        )
        session = result.tokens
        afterSignUp = withoutSession(result.attempt)
        return { outcome: 'passed' }
      })
    } else {
      skip('verify_email', 'earlier_step')
    }

    const first = session as Sessions.IssuedSession | undefined
    if (first) {
      await step('sign_out', async () => {
        await Sessions.signOut(flow, tenant, first.refreshToken ?? first.sessionToken, {
          userAgent: SIGN_IN_TEST_USER_AGENT,
        })
        return { outcome: 'passed' }
      })
    } else {
      skip('sign_out', afterSignUp)
    }

    let signIn: Flows.FlowResult | undefined
    let second: Sessions.IssuedSession | undefined
    let afterSignIn: SignInTestReason = 'earlier_step'
    if (
      verified &&
      (await step('sign_in', async () => {
        signIn = await Flows.signIn(flow, tenant, { identifier: address }, context)
        return { outcome: 'passed' }
      }))
    ) {
      await step('first_factor', async () => {
        const attempt = (signIn as Flows.FlowResult).attempt
        const ref = { id: attempt.id, secret: attempt.attemptSecret }
        const offered =
          attempt.step.status === 'needs_password'
            ? ['password']
            : attempt.step.status === 'needs_first_factor'
              ? attempt.step.strategies
              : []
        if (!secret || !offered.includes('password')) {
          // An emailed code is the other factor a run could prove, and it cannot ask for one:
          // the address was emailed its verification code seconds ago, and a second code
          // within `RESEND_COOLDOWN` is refused, as it is for anyone. Asking would only be
          // counted. Nothing else on offer can be proven without a person or a device.
          afterSignIn = offered.includes('email_code') ? 'email_cooldown' : 'no_provable_method'
          return { outcome: 'not_run', reason: afterSignIn }
        }
        const result = await Flows.submitPassword(flow, tenant, ref, secret, context)
        second = result.tokens
        afterSignIn = withoutSession(result.attempt)
        return { outcome: 'passed' }
      })
    } else {
      if (!verified) {
        skip('sign_in', 'earlier_step')
      }
      skip('first_factor', 'earlier_step')
    }

    const last = second as Sessions.IssuedSession | undefined
    if (last) {
      await step('revoke_session', async () => {
        const user = await deps.users.findByEmail(tenant.environmentId, address)
        if (!user) {
          return { outcome: 'failed', code: 'resource.not_found' }
        }
        await Sessions.revoke(flow, tenant, {
          userId: user.id,
          sessionId: last.sessionId,
          reason: 'revoked_by_admin',
          actor,
        })
        return { outcome: 'passed' }
      })
    } else {
      skip('revoke_session', afterSignIn)
    }
  } finally {
    // A step left at its limit may be creating the user right now: wait for it, for a bounded
    // time, before looking. What it creates after that is the retention job's to remove, and
    // the report must not say that no user was made. Only a step that can create the user
    // says so (`SIGN_IN_TEST_STEPS_THAT_CREATE`): a sign-up's start that never ended made no
    // account and never will, and its run has nothing to clean up.
    await bounded(
      Promise.allSettled(abandoned.map((left) => left.work)).then(
        () => ({ outcome: 'passed' }) as const
      ),
      limits.cleanupMs
    )
    const stillAtWork = abandoned.some(
      (left) => !left.ended && SIGN_IN_TEST_STEPS_THAT_CREATE.has(left.step)
    )
    const began = deps.clock.now().getTime()
    let end: StepEnd = { outcome: 'not_run', reason: 'earlier_step' }
    try {
      // By the address, never by an id a step returned: a step that failed after it made the
      // account returned none.
      const user = await deps.users.findByEmail(tenant.environmentId, address)
      if (user) {
        userId = user.id
        cleanup = 'failed'
        end = await bounded(
          Users.remove(flow, tenant, user.id, actor).then(() => ({ outcome: 'passed' }) as const),
          limits.cleanupMs
        )
        cleanup = end.outcome === 'passed' ? 'deleted' : 'failed'
      } else if (stillAtWork) {
        // No user yet, and a step that can still make one: nothing was deleted and nothing
        // can be said to be clean. There is no id to give; the retention job finds the user
        // by its address.
        cleanup = 'failed'
        end = { outcome: 'failed', reason: 'timeout' }
      }
    } catch (error) {
      cleanup = 'failed'
      end = { outcome: 'failed', code: codeOf(error) }
      logFailure('sign-in test: looking for the throwaway user failed', tenant, userId, error)
    }
    if (cleanup === 'failed') {
      // The only trace besides the report: the retention job removes the user later.
      logger.error('sign-in test: the throwaway user was not deleted', {
        environmentId: tenant.environmentId,
        userId,
      })
    }
    results.set('delete_user', {
      step: 'delete_user',
      durationMs: Math.max(0, deps.clock.now().getTime() - began),
      ...end,
    })
    for (const name of SIGN_IN_TEST_STEPS) {
      // A step the run never reached (something outside a step threw).
      if (!results.has(name)) {
        skip(name, 'earlier_step')
      }
    }
  }

  const steps = SIGN_IN_TEST_STEPS.map((name) => results.get(name) as SignInTestStepResult)
  const outcome: SignInTestOutcome = steps.some((result) => result.outcome === 'failed')
    ? 'failed'
    : steps.every((result) => result.outcome === 'passed')
      ? 'passed'
      : 'incomplete'
  try {
    await deps.users.reportSignInTest(
      tenant.environmentId,
      Audit.entry(deps, tenant, {
        type: 'sign_in_test.finished',
        actor,
        target: environment,
        data: { outcome, cleanup, ...(userId && { userId }) },
      })
    )
  } catch (error) {
    // The run happened and its other entries stand; the answer is not failed for this one.
    logFailure('sign-in test: its end could not be recorded', tenant, userId, error)
  }
  return { outcome, steps, userId, cleanup }
}

/** Log a failure by fixed words, ids and the error's name: its message can quote the address. */
function logFailure(words: string, tenant: Tenant, userId: string | null, error: unknown): void {
  logger.error(words, {
    environmentId: tenant.environmentId,
    userId,
    error: error instanceof Error ? error.name : 'unknown',
  })
}

/**
 * Wait for a step's work for at most `ms`. Work that throws is a failed step with the
 * contract's code; work that is not done in time is a failed step with `timeout`, and is
 * handed to `onLate`: it goes on, and what it does is cleaned up after.
 */
async function bounded(
  work: Promise<StepEnd>,
  ms: number,
  onLate?: (work: Promise<unknown>) => void
): Promise<StepEnd> {
  const settled = work.catch((error: unknown): StepEnd => {
    if (!(error instanceof ServiceException)) {
      logger.error('sign-in test: a step threw', {
        error: error instanceof Error ? error.name : 'unknown',
      })
    }
    return { outcome: 'failed', code: codeOf(error) }
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), ms)
  })
  const first = await Promise.race([settled, late])
  clearTimeout(timer)
  if (first === 'late') {
    onLate?.(settled)
    return { outcome: 'failed', reason: 'timeout' }
  }
  return first
}
