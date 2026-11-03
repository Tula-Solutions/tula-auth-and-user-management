import {
  SSO_TEST_REASONS,
  type SsoTestReason,
  type SsoTestResult,
  type SsoTestStart,
} from '@tula-tech/contract'
import type { Deps, Tenant } from '~/dependencies'
import { AuthError } from '~/exceptions'
import type { Actor } from '~/lib/actor'
import { randomToken, sha256Hex, timingSafeEqual } from '~/lib/crypto'
import { parseEmail } from '~/lib/email'
import * as logger from '~/lib/logger'
import * as Settings from '~/modules/settings/service'
import * as Sso from '~/modules/sso/service'
import * as SsoConnections from '~/modules/sso-connection/service'
import type { SsoConnectionRecord } from '~/ports/sso-connection-store'

// The test sign-in of an SSO connection (TULA-145, ADR 0067): the whole round through the
// identity provider, judged by the same verifiers a real sign-in uses, that stops where a
// sign-in would find an account. It creates no user, identity, membership or session and
// returns no ticket; the one thing it may write is the connection's "tested" mark. It lives in
// a flow attempt row (so it expires and is purged with the others), under a secret nobody
// holds, so no client route can continue it. The result is read by the administrator who
// started it, through the admin API, and is the one place a refusal's reason is shown.

/** How long a started test waits for the browser to come back. */
const TEST_TTL_MS = 10 * 60_000
const NO_SECRET_HASH = 'x'.repeat(64)
/** The fragment parameter that carries the test's id back to the page that started it. */
export const SSO_TEST_PARAM = 'tula_test'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const MAX_ATTRIBUTES = 50
const MAX_VALUES = 50
const MAX_VALUE_LENGTH = 256
const GROUP_ATTRIBUTE = /(^|[/:.])(groups?|memberof)$/i

interface TestState {
  connectionId: string
  /** The settings the test runs against, as {@link SsoConnections.fingerprint} hashes them. */
  fingerprint: string
  redirectUrl: string
  stateHash: string
  requestId?: string
  codeVerifier?: string
  nonce?: string
  actor: Actor
  result?: Result
}

/** What is kept of a finished test: parsed values only, never the response or a token. */
type Result = Omit<SsoTestResult, 'testId' | 'status' | 'message'> & { passed: boolean }

function stateOf(state: Record<string, unknown>): TestState | null {
  const test = state.ssoTest
  return typeof test === 'object' && test !== null ? (test as TestState) : null
}

function failure(reason: SsoTestReason, received: Partial<Result> = {}): Result {
  return { passed: false, reason, attributes: [], groups: [], mapped: null, ...received }
}

/**
 * Start a test sign-in of a connection, whatever its status.
 *
 * @param deps - All the ports the SSO round and the redirect check use.
 * @param tenant - The environment.
 * @param connectionId - The connection.
 * @param redirectUrl - The page to return the browser to; must be allowed by the environment.
 * @param actor - Who tests, for the audit entry of a pass.
 * @returns The test's id and where to send the browser. An OIDC provider whose configuration
 *   cannot be read gives a test that has already failed, and the page to return to.
 * @throws AuthError `sso.connection_not_found`, `sso.disabled`, `request.redirect_not_allowed`.
 */
export async function start(
  deps: Deps,
  tenant: Tenant,
  connectionId: string,
  redirectUrl: string,
  actor: Actor
): Promise<SsoTestStart> {
  await SsoConnections.requireEnabled(deps, tenant)
  const connection = await deps.ssoConnections.find(tenant.environmentId, connectionId)
  if (!connection) {
    throw new AuthError('sso.connection_not_found')
  }
  const allowed = await Settings.requireRedirectUrl(deps, tenant, redirectUrl, { client: 'web' })
  const now = deps.clock.now()
  const id = deps.ids.next()
  const ssoState = `${tenant.environmentId}.${id}.${randomToken()}`
  const test: TestState = {
    connectionId,
    fingerprint: SsoConnections.fingerprint(connection),
    redirectUrl: allowed,
    stateHash: sha256Hex(ssoState),
    actor,
  }
  let authorizationUrl: string
  try {
    if (connection.protocol === 'saml') {
      test.requestId = `_${randomToken()}`
      authorizationUrl = Sso.samlRedirectUrl(deps, connection, {
        requestId: test.requestId,
        relayState: ssoState,
      })
    } else {
      test.codeVerifier = randomToken()
      test.nonce = randomToken()
      authorizationUrl = await Sso.authorizationUrl(deps, connection, {
        state: ssoState,
        nonce: test.nonce,
        codeVerifier: test.codeVerifier,
      })
    }
  } catch (error) {
    if (!(error instanceof Sso.SsoRefusal)) {
      throw error
    }
    test.result = failure(error.reason)
    authorizationUrl = back(allowed, id)
  }
  await deps.flowAttempts.create({
    id,
    projectId: tenant.projectId,
    environmentId: tenant.environmentId,
    // A sign-in attempt that no one holds the secret of: no client route can load it.
    kind: 'sign_in',
    status: 'needs_first_factor',
    userId: null,
    identifier: `sso-test:${connectionId}`,
    secretHash: sha256Hex(randomToken()),
    state: { phase: test.result ? 'done' : 'started', ssoTest: test },
    expiresAt: new Date(now.getTime() + TEST_TTL_MS),
    createdAt: now,
  })
  return { testId: id, authorizationUrl }
}

function back(redirectUrl: string, id: string): string {
  return `${redirectUrl}#${SSO_TEST_PARAM}=${id}`
}

function describe(result: Result): Pick<SsoTestResult, 'status' | 'reason' | 'message'> {
  return result.passed
    ? { status: 'passed', reason: null, message: null }
    : {
        status: 'failed',
        reason: result.reason,
        message: result.reason ? SSO_TEST_REASONS[result.reason] : null,
      }
}

/**
 * Read a test's result.
 *
 * @param deps - Flow attempts.
 * @param tenant - The environment.
 * @param connectionId - The connection the path names.
 * @param testId - The test.
 * @returns `pending` until the browser has come back.
 * @throws AuthError `sso.test_not_found` for a test of another connection or environment.
 */
export async function result(
  deps: Pick<Deps, 'flowAttempts'>,
  tenant: Pick<Tenant, 'environmentId'>,
  connectionId: string,
  testId: string
): Promise<SsoTestResult> {
  const attempt = await deps.flowAttempts.findById(tenant.environmentId, testId)
  const test = attempt && stateOf(attempt.state)
  if (!test || test.connectionId !== connectionId) {
    throw new AuthError('sso.test_not_found')
  }
  const kept = test.result
  return kept
    ? {
        testId,
        ...describe(kept),
        attributes: kept.attributes,
        groups: kept.groups,
        mapped: kept.mapped,
      }
    : {
        testId,
        status: 'pending',
        reason: null,
        message: null,
        attributes: [],
        groups: [],
        mapped: null,
      }
}

function received(
  seen: Record<string, string[]>,
  profile: Sso.SsoProfile,
  connection: SsoConnectionRecord
): Result {
  const clip = (value: string) => value.slice(0, MAX_VALUE_LENGTH)
  const attributes = Object.entries(seen)
    .slice(0, MAX_ATTRIBUTES)
    .map(([name, values]) => ({ name: clip(name), values: values.slice(0, MAX_VALUES).map(clip) }))
  const groups = Object.entries(seen)
    .filter(([name]) => GROUP_ATTRIBUTE.test(name))
    .flatMap(([, values]) => values)
    .slice(0, MAX_VALUES)
    .map(clip)
  const parsed = profile.email === null ? null : parseEmail(profile.email)
  const domain = parsed?.normalized.slice(parsed.normalized.lastIndexOf('@') + 1)
  const onDomain = domain !== undefined && connection.domains.includes(domain)
  const mapped = {
    email: parsed?.normalized ?? null,
    givenName: profile.givenName ?? null,
    familyName: profile.familyName ?? null,
    emailOnVerifiedDomain: onDomain,
  }
  const reason: SsoTestReason | null = !parsed
    ? 'email_missing'
    : onDomain
      ? null
      : 'email_outside_domains'
  return { passed: reason === null, reason, attributes, groups, mapped }
}

/** A refused signature against certificates that have all expired is the expiry's fault. */
function refine(reason: SsoTestReason, connection: SsoConnectionRecord, now: Date): SsoTestReason {
  const certificates = connection.saml?.certificates ?? []
  return (reason === 'signature_invalid' || reason === 'certificate_not_trusted') &&
    certificates.length > 0 &&
    certificates.every((c) => new Date(c.notAfter).getTime() <= now.getTime())
    ? 'certificate_expired'
    : reason
}

/**
 * Take the identity provider's answer to a test, if `state` belongs to one.
 *
 * As a sign-in's callback: the attempt is found by `state` alone, compared in constant time,
 * and the state is used up before the answer is judged. The answer is judged by the verifiers a
 * sign-in uses, and then **nothing more happens**: no account is looked up, created or linked.
 *
 * @param deps - All dependencies.
 * @param connectionId - The connection in the callback's path.
 * @param input - What the provider sent.
 * @returns `null` when `state` is not a test's (the caller treats it as a sign-in),
 *   `{ invalid: true }` when it is one that cannot be taken, else where to send the browser.
 */
export async function callback(
  deps: Deps,
  connectionId: string,
  input: { state?: string; code?: string; error?: string; samlResponse?: string }
): Promise<{ redirectTo: string } | { invalid: true } | null> {
  const [environmentId, attemptId, random] = (input.state ?? '').split('.')
  if (
    !environmentId ||
    !attemptId ||
    !random ||
    !UUID.test(environmentId) ||
    !UUID.test(attemptId)
  ) {
    return null
  }
  const attempt = await deps.flowAttempts.findById(environmentId, attemptId)
  const test = attempt && stateOf(attempt.state)
  if (!attempt || !test) {
    return null
  }
  if (
    !timingSafeEqual(sha256Hex(input.state ?? ''), test.stateHash ?? NO_SECRET_HASH) ||
    test.connectionId !== connectionId
  ) {
    return { invalid: true }
  }
  const tenant: Tenant = { projectId: attempt.projectId, environmentId, apiKeyId: '' }
  const consumed = await deps.flowAttempts.transition(
    environmentId,
    attempt.id,
    'needs_first_factor',
    { status: 'needs_first_factor', state: { ...attempt.state, phase: 'returned' } },
    deps.clock.now(),
    { key: 'phase', value: 'started' }
  )
  if (!consumed) {
    return { invalid: true }
  }
  const connection = await deps.ssoConnections.find(environmentId, connectionId)
  if (!connection) {
    return { invalid: true }
  }
  const finished = await judge(deps, connection, test, input)
  if (finished.passed) {
    await SsoConnections.markTested(deps, tenant, connectionId, test.fingerprint, test.actor)
  }
  const stored = await deps.flowAttempts.transition(
    environmentId,
    attempt.id,
    'needs_first_factor',
    {
      status: 'needs_first_factor',
      state: {
        // The verifier and nonce have done their job and are not kept.
        phase: 'done',
        ssoTest: {
          connectionId,
          fingerprint: test.fingerprint,
          redirectUrl: test.redirectUrl,
          stateHash: test.stateHash,
          actor: test.actor,
          result: finished,
        },
      },
    },
    deps.clock.now(),
    { key: 'phase', value: 'returned' }
  )
  return stored ? { redirectTo: back(test.redirectUrl, attempt.id) } : { invalid: true }
}

async function judge(
  deps: Deps,
  connection: SsoConnectionRecord,
  test: TestState,
  input: { code?: string; error?: string; samlResponse?: string }
): Promise<Result> {
  const { requestId } = test
  if (requestId === undefined && input.error !== undefined) {
    return failure('idp_refused')
  }
  if (
    requestId !== undefined ? !input.samlResponse : !input.code || !test.codeVerifier || !test.nonce
  ) {
    return failure('malformed_response')
  }
  const seen: Sso.Seen = {}
  try {
    const profile =
      requestId !== undefined
        ? await Sso.verifySaml(deps, connection, input.samlResponse ?? '', requestId, seen)
        : await Sso.exchange(
            deps,
            connection,
            {
              code: input.code ?? '',
              codeVerifier: test.codeVerifier ?? '',
              nonce: test.nonce ?? '',
            },
            seen
          )
    return received(seen.attributes ?? {}, profile, connection)
  } catch (error) {
    if (error instanceof Sso.SsoRefusal) {
      return failure(refine(error.reason, connection, deps.clock.now()))
    }
    // The replay guard or the network failing is not the configuration's fault.
    logger.warn('an SSO test sign-in could not be judged', {
      failure: error instanceof Error ? error.name : 'unknown',
    })
    throw error
  }
}
