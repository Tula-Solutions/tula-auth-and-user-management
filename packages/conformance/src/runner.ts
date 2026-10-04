import {
  durationToMs,
  EMAIL_LINK_ATTEMPT_PARAM,
  EMAIL_LINK_TOKEN_PARAM,
  FLOW_ATTEMPT_HEADER,
} from '@tula/contract'
import { jwtClaims, match, pick } from './match'
import type { Scenario, ScenarioRequest, Step } from './scenario'
import { expandJson, fill } from './template'
import { base32Decode, totp, wrongTotp } from './totp'

/** Header carrying the publishable key. */
export const PUBLISHABLE_KEY_HEADER = 'x-tula-publishable-key'

/** One API instance of the deployment under test. */
export interface Instance {
  /** Origin of the instance, e.g. `http://localhost:3004`. No trailing slash. */
  baseUrl: string
  /** Sends a request to it. */
  fetch: (request: Request) => Promise<Response>
}

/** The server under test and the test doubles around it. */
export interface Target {
  /** Origin of the API, e.g. `http://localhost:3003`. No trailing slash. */
  baseUrl: string
  publishableKey: string
  /** Scenarios that need one are skipped when it is missing. */
  secretKey?: string
  /** Sends a request: `fetch` for a live server, `app.request` for an in-process one. */
  fetch: (request: Request) => Promise<Response>
  /**
   * A second instance of the same deployment (same database, same keys), reached separately.
   * Requests marked `instance: "second"` go here; without it they go to the first.
   */
  second?: Instance
  /**
   * The 6-digit code in the newest email to an address.
   *
   * @param to - The recipient.
   * @returns The code.
   * @throws Error when no such email arrived.
   */
  emailCode: (to: string) => Promise<string>
  /**
   * The sign-in link in the newest email to an address that carries a code. Optional: a target
   * that cannot read email bodies fails the `emailLink` steps and runs everything else.
   *
   * @param to - The recipient.
   * @returns The link's whole URL, fragment included.
   * @throws Error when no such email arrived, or it holds no link.
   */
  emailLink?: (to: string) => Promise<string>
  /**
   * Let time pass on the server: a real sleep for a live one, a clock advance in-process.
   *
   * @param ms - How long.
   */
  wait: (ms: number) => Promise<void>
  /**
   * The time on the server, for `totp` steps: the same clock {@link Target.wait} moves. Left out
   * for a live server, where it is the wall clock; an in-process target gives its test clock.
   *
   * @returns Milliseconds since the Unix epoch.
   */
  now?: () => number
}

/** How one step went. */
export interface StepResult {
  name: string
  ok: boolean
  /** Why it failed; empty when `ok`. */
  problems: string[]
}

/** How one scenario went. */
export interface ScenarioResult {
  name: string
  status: 'passed' | 'failed' | 'skipped'
  /**
   * Steps that ran, in order. A failed step is the last of the scenario's own steps; the
   * cleanup steps, when the scenario has them, follow it.
   */
  steps: StepResult[]
  /** Why it was skipped, when it was. */
  reason?: string
}

/** Thrown inside a step to fail it with a list of problems. */
class StepFailure extends Error {
  readonly problems: string[]

  constructor(problems: string[]) {
    super(problems.join('; '))
    this.problems = problems
  }
}

/** What a contract error code looks like; anything else in `code` is not printed. */
const ERROR_CODE = /^[a-z_]{1,40}(\.[a-z_]{1,40})?$/

/**
 * Replace every value the scenario knows (generated passwords, emailed codes, captured tokens
 * and ids) with its placeholder, so a server that echoes one back cannot get it printed, whether
 * it appears as written or JSON-escaped.
 * Longest first, so a value containing another is replaced whole.
 */
function redact(message: string, variables: Readonly<Record<string, string>>): string {
  return Object.entries(variables)
    .filter(([name, value]) => name !== 'origin' && value.length >= 4)
    .sort(([, a], [, b]) => b.length - a.length)
    .reduce(
      (text, [name, value]) =>
        text
          .replaceAll(value, `{{${name}}}`)
          // Messages quote strings as JSON, so a value holding quotes (captured JSON) shows up
          // escaped.
          .replaceAll(JSON.stringify(value).slice(1, -1), `{{${name}}}`),
      message
    )
}

/** A code of the same length that cannot be the right one: its last digit is shifted by one. */
function wrongCode(code: string): string {
  return `${code.slice(0, -1)}${(Number(code.at(-1)) + 1) % 10}`
}

function initialVariables(scenario: Scenario, origin: string): Record<string, string> {
  const variables: Record<string, string> = { origin }
  for (const [name, value] of Object.entries(scenario.variables ?? {})) {
    if (typeof value === 'string') {
      variables[name] = value
      continue
    }
    const random = crypto.randomUUID().replaceAll('-', '')
    variables[name] =
      value.generate === 'email'
        ? // A fresh address per run, so runs never collide and per-address limits start clean.
          `conformance-${random.slice(0, 20)}@example.com`
        : // Upper, lower, digit and symbol; no run of repeats; far too random to be breached.
          `Tu-${random.slice(0, 24)}-Zq7!`
  }
  return variables
}

/** The instance a request is for: the second only when it is asked for and there is one. */
function instanceFor(target: Target, request: ScenarioRequest): Instance {
  return request.instance === 'second' && target.second ? target.second : target
}

function buildRequest(target: Target, request: ScenarioRequest, origin: string): Request {
  const headers = new Headers({
    // Scenarios each come from their own address, so per-IP limits don't couple them. Only a
    // server that trusts its proxy (`TRUST_PROXY=true`, as a test deployment must) honours it.
    'x-forwarded-for': origin,
    'user-agent': 'tula-conformance/1',
  })
  if (request.auth === 'publishable') {
    headers.set(PUBLISHABLE_KEY_HEADER, target.publishableKey)
  }
  if (request.auth === 'secret') {
    headers.set('authorization', `Bearer ${target.secretKey}`)
  }
  if (request.accessToken) {
    headers.set('authorization', `Bearer ${request.accessToken}`)
  }
  if (request.client) {
    headers.set('x-tula-client', request.client)
  }
  if (request.attempt !== undefined) {
    headers.set(FLOW_ATTEMPT_HEADER, request.attempt)
  }
  if (request.body !== undefined) {
    headers.set('content-type', 'application/json')
  }
  // The schema refuses the names set above, so these only ever add.
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    headers.set(name, value)
  }
  return new Request(`${instanceFor(target, request).baseUrl}${request.path}`, {
    method: request.method,
    headers,
    body: request.body === undefined ? undefined : JSON.stringify(expandJson(request.body)),
  })
}

function parseBody(text: string): unknown {
  if (text === '') {
    return undefined
  }
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

async function runStep(
  target: Target,
  step: Step,
  variables: Record<string, string>
): Promise<void> {
  if ('wait' in step) {
    await target.wait(durationToMs(step.wait))
    return
  }
  if ('emailCode' in step) {
    const code = await target.emailCode(fill(step.emailCode.to, variables))
    variables[step.emailCode.capture] = code
    if (step.emailCode.captureWrong) {
      variables[step.emailCode.captureWrong] = wrongCode(code)
    }
    return
  }
  if ('emailLink' in step) {
    readEmailLink(await linkFor(target, fill(step.emailLink.to, variables)), step, variables)
    return
  }
  if ('oauth' in step) {
    await runOAuth(target, step, variables)
    return
  }
  if ('totp' in step) {
    const secret = base32Decode(fill(step.totp.secret, variables))
    const now = target.now ? target.now() : Date.now()
    variables[step.totp.capture] = await totp(secret, now)
    if (step.totp.captureWrong) {
      variables[step.totp.captureWrong] = await wrongTotp(secret, now)
    }
    return
  }
  const request = fill(step.request, variables)
  const expected = fill(step.expect, variables)
  for (let attempt = 1; attempt <= (step.times ?? 1); attempt++) {
    const response = await instanceFor(target, request).fetch(
      buildRequest(target, request, variables.origin ?? '')
    )
    const text = await response.text()
    const body = parseBody(text)
    const problems = match(expected.body, expected.body === undefined ? undefined : body).map(
      (mismatch) => mismatch.message
    )
    for (const [index, excluded] of (expected.bodyExcludes ?? []).entries()) {
      if (text.includes(excluded)) {
        // Named by position: the value is what must not be printed.
        problems.push(`the response contains a value it must not (bodyExcludes[${index}])`)
      }
    }
    for (const [path, claims] of Object.entries(expected.claims ?? {})) {
      const payload = jwtClaims(pick(body, path))
      problems.push(
        ...(payload === undefined
          ? [`expected a JWT at ${path}`]
          : match(claims, payload, `claims(${path})`).map((mismatch) => mismatch.message))
      )
    }
    if (response.status !== expected.status) {
      // The error code says far more than the status alone; never print the whole body, which
      // can hold tokens.
      const code = pick(body, 'code')
      problems.unshift(
        `expected status ${expected.status}, got ${response.status}${
          typeof code === 'string' && ERROR_CODE.test(code) ? ` (${code})` : ''
        }`
      )
    }
    if (problems.length > 0) {
      throw new StepFailure(
        step.times ? problems.map((problem) => `request ${attempt}: ${problem}`) : problems
      )
    }
    for (const [name, path] of Object.entries(step.capture ?? {})) {
      const value = pick(body, path)
      if (typeof value !== 'string') {
        throw new StepFailure([`cannot capture ${name}: no string at ${path}`])
      }
      variables[name] = value
    }
    for (const [name, header] of Object.entries(step.captureHeaders ?? {})) {
      const value = response.headers.get(header)
      if (value === null) {
        throw new StepFailure([`cannot capture ${name}: no ${header} header`])
      }
      variables[name] = value
    }
    for (const [name, path] of Object.entries(step.captureJson ?? {})) {
      const value = pick(body, path)
      if (value === undefined) {
        throw new StepFailure([`cannot capture ${name}: nothing at ${path}`])
      }
      variables[name] = JSON.stringify(value)
    }
  }
}

/** The path and query of a URL the server handed out, to be requested on the target itself. */
function pathOf(url: string): string {
  const parsed = new URL(url, 'http://placeholder.invalid')
  return `${parsed.pathname}${parsed.search}`
}

/**
 * Send one hop of an OAuth round trip, following nothing: the runner reads each `Location`
 * itself, as a browser's address bar would show it.
 */
async function hop(
  target: Target,
  path: string,
  origin: string,
  form?: URLSearchParams
): Promise<{ status: number; location: string | null }> {
  const headers = new Headers({ 'x-forwarded-for': origin, 'user-agent': 'tula-conformance/1' })
  if (form) {
    headers.set('content-type', 'application/x-www-form-urlencoded')
  }
  const response = await target.fetch(
    new Request(`${target.baseUrl}${path}`, {
      method: form ? 'POST' : 'GET',
      headers,
      body: form?.toString(),
      redirect: 'manual',
    })
  )
  await response.body?.cancel()
  return { status: response.status, location: response.headers.get('location') }
}

/** Play the user at the mock OAuth provider and read what the callback sends the app's page. */
async function runOAuth(
  target: Target,
  step: Extract<Step, { oauth: unknown }>,
  variables: Record<string, string>
): Promise<void> {
  const oauth = fill(step.oauth, variables)
  const origin = variables.origin ?? ''
  let callback = oauth.callback
  if (oauth.authorizationUrl !== undefined) {
    const authorization = new URL(oauth.authorizationUrl)
    const form = new URLSearchParams(authorization.searchParams)
    form.set('email', oauth.email ?? '')
    form.set('subject', oauth.subject ?? '')
    form.set('action', oauth.deny ? 'deny' : 'allow')
    if (oauth.unverified) {
      form.set('unverified', '1')
    }
    const consented = await hop(target, authorization.pathname, origin, form)
    if (consented.status !== 302 || !consented.location) {
      throw new Error(
        `the provider's consent endpoint answered ${consented.status} without a redirect (is OAUTH_MOCK_PROVIDER on?)`
      )
    }
    callback = pathOf(consented.location)
  }
  if (callback === undefined) {
    throw new Error('the step names neither an authorization URL nor a callback')
  }
  if (oauth.captureCallback) {
    variables[oauth.captureCallback] = callback
  }
  const answered = await hop(target, callback, origin)
  const fragment = answered.location?.split('#')[1]
  if (answered.status !== 303 || fragment === undefined) {
    throw new Error(`the callback answered ${answered.status}, not a redirect with a fragment`)
  }
  if (answered.location?.split('#')[0]?.includes('?')) {
    throw new Error('the callback put something in the query of the app’s URL')
  }
  const params = new URLSearchParams(fragment)
  const ticket = params.get('tula_ticket')
  const error = params.get('tula_error')
  if (oauth.captureTicket) {
    if (!ticket) {
      throw new Error(`the callback sent no ticket (error: ${error ?? 'none'})`)
    }
    variables[oauth.captureTicket] = ticket
  }
  if (oauth.expectError !== undefined && (ticket || error !== oauth.expectError)) {
    throw new Error(
      `expected the callback to send the error ${oauth.expectError}, got ${ticket ? 'a ticket' : (error ?? 'nothing')}`
    )
  }
  if (oauth.captureAttempt) {
    variables[oauth.captureAttempt] = params.get('tula_attempt') ?? ''
  }
}

async function linkFor(target: Target, to: string): Promise<string> {
  if (!target.emailLink) {
    throw new StepFailure(['this target cannot read links from emails'])
  }
  return target.emailLink(to)
}

/**
 * Take an emailed link apart and store its pieces. Nothing of the link is ever put in a
 * problem: its token is a credential until it is used.
 */
function readEmailLink(
  link: string,
  step: Extract<Step, { emailLink: unknown }>,
  variables: Record<string, string>
): void {
  const at = link.indexOf('#')
  const fragment = new URLSearchParams(at === -1 ? '' : link.slice(at + 1))
  const token = fragment.get(EMAIL_LINK_TOKEN_PARAM)
  const attempt = fragment.get(EMAIL_LINK_ATTEMPT_PARAM)
  if (!token || !attempt) {
    throw new StepFailure(['the link carries no token and attempt id in its fragment'])
  }
  variables[step.emailLink.captureToken] = token
  if (step.emailLink.captureAttempt) {
    variables[step.emailLink.captureAttempt] = attempt
  }
  const expected =
    step.emailLink.url === undefined ? undefined : fill(step.emailLink.url, variables)
  if (expected !== undefined && link.slice(0, at) !== expected) {
    throw new StepFailure(['the link, without its fragment, is not the expected URL'])
  }
}

/** How many distinct addresses {@link nextOrigin} cycles through. */
const ORIGINS = 250 * 250

// Starts somewhere different in every process, so two CLI runs in a row don't present the same
// addresses and inherit each other's per-IP counters. Not a secret; any spread will do.
let counter = (crypto.getRandomValues(new Uint32Array(1))[0] ?? 0) % ORIGINS

/**
 * The client address a scenario run presents in `X-Forwarded-For`.
 *
 * @returns An IPv4 address in 198.18.0.0/16 (reserved for benchmarking, never routed), different
 *   from the previous 62,499.
 */
export function nextOrigin(): string {
  counter = (counter + 1) % ORIGINS
  return `198.18.${Math.floor(counter / 250)}.${(counter % 250) + 1}`
}

/**
 * The exit code of a run.
 *
 * @param counts - How many scenarios passed, failed and were skipped.
 * @returns 1 when a scenario failed or none passed (a run that checked nothing must not look
 *   green), otherwise 0.
 */
export function exitCode(counts: { passed: number; failed: number; skipped: number }): 0 | 1 {
  return counts.failed > 0 || counts.passed === 0 ? 1 : 0
}

/**
 * Run one scenario against a server.
 *
 * Steps run in order and stop at the first failure; the scenario's `cleanup` steps then run
 * in any case. A failing step reports what differed: the
 * status, the error code and short plain values. Tokens, long strings, objects and arrays are
 * described, never quoted, and any value the scenario generated or captured is shown as its
 * `{{placeholder}}`, because the report is read in CI logs.
 *
 * @param scenario - A parsed scenario.
 * @param target - The server and its test doubles.
 * @returns The outcome and the steps that ran.
 *
 * @example
 * ```ts
 * const result = await runScenario(scenario, { baseUrl, publishableKey, fetch, emailCode, wait })
 * if (result.status === 'failed') throw new Error(result.steps.at(-1)?.problems.join('\n'))
 * ```
 */
export async function runScenario(scenario: Scenario, target: Target): Promise<ScenarioResult> {
  if (scenario.needsSecretKey && !target.secretKey) {
    return { name: scenario.name, status: 'skipped', steps: [], reason: 'needs a secret key' }
  }
  const variables = initialVariables(scenario, nextOrigin())
  const steps: StepResult[] = []
  /** Run steps in order until one fails. Returns whether all of them passed. */
  async function run(list: readonly Step[]): Promise<boolean> {
    for (const step of list) {
      try {
        await runStep(target, step, variables)
        steps.push({ name: step.name, ok: true, problems: [] })
      } catch (error) {
        const problems =
          error instanceof StepFailure
            ? error.problems
            : [error instanceof Error ? error.message : String(error)]
        steps.push({
          name: step.name,
          ok: false,
          problems: problems.map((problem) => redact(problem, variables)),
        })
        return false
      }
    }
    return true
  }
  const passed = await run(scenario.steps)
  // Whatever happened above: a scenario that changed the server's settings puts them back.
  const cleaned = await run(scenario.cleanup ?? [])
  return { name: scenario.name, status: passed && cleaned ? 'passed' : 'failed', steps }
}

/**
 * Describe a result for a test failure message or the CLI.
 *
 * @param result - A scenario result.
 * @returns One line per step, with the problems of a failed step indented under it.
 */
export function formatResult(result: ScenarioResult): string {
  const lines = [`${result.status.toUpperCase()} ${result.name}`]
  if (result.reason) {
    lines.push(`  (${result.reason})`)
  }
  for (const step of result.steps) {
    lines.push(`  ${step.ok ? 'ok  ' : 'FAIL'} ${step.name}`)
    lines.push(...step.problems.map((problem) => `         ${problem}`))
  }
  return lines.join('\n')
}
