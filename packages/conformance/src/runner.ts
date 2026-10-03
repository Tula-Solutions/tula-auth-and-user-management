import { durationToMs } from '@tula/contract'
import { match, pick } from './match'
import type { Scenario, ScenarioRequest, Step } from './scenario'
import { fill } from './template'

/** Header carrying the publishable key. */
export const PUBLISHABLE_KEY_HEADER = 'x-tula-publishable-key'

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
   * The 6-digit code in the newest email to an address.
   *
   * @param to - The recipient.
   * @returns The code.
   * @throws Error when no such email arrived.
   */
  emailCode: (to: string) => Promise<string>
  /**
   * Let time pass on the server: a real sleep for a live one, a clock advance in-process.
   *
   * @param ms - How long.
   */
  wait: (ms: number) => Promise<void>
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
  /** Steps that ran, in order. A failed step is the last one. */
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
  if (request.body !== undefined) {
    headers.set('content-type', 'application/json')
  }
  return new Request(`${target.baseUrl}${request.path}`, {
    method: request.method,
    headers,
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
  })
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text()
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
  const request = fill(step.request, variables)
  const expected = fill(step.expect, variables)
  for (let attempt = 1; attempt <= (step.times ?? 1); attempt++) {
    const response = await target.fetch(buildRequest(target, request, variables.origin ?? ''))
    const body = await readBody(response)
    const problems = match(expected.body, expected.body === undefined ? undefined : body).map(
      (mismatch) => mismatch.message
    )
    if (response.status !== expected.status) {
      // The error code says far more than the status alone; never print the whole body, which
      // can hold tokens.
      const code = pick(body, 'code')
      problems.unshift(
        `expected status ${expected.status}, got ${response.status}${
          typeof code === 'string' ? ` (${code})` : ''
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
  }
}

let counter = 0

/** A documentation-range IPv4 address (198.18.0.0/15) that is different for every scenario run. */
function nextOrigin(): string {
  counter = (counter + 1) % 65_000
  return `198.18.${Math.floor(counter / 250)}.${(counter % 250) + 1}`
}

/**
 * Run one scenario against a server.
 *
 * Steps run in order and stop at the first failure. A failing step reports what differed, never
 * the response body, because bodies contain tokens.
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
  for (const step of scenario.steps) {
    try {
      await runStep(target, step, variables)
      steps.push({ name: step.name, ok: true, problems: [] })
    } catch (error) {
      const problems =
        error instanceof StepFailure
          ? error.problems
          : [error instanceof Error ? error.message : String(error)]
      steps.push({ name: step.name, ok: false, problems })
      return { name: scenario.name, status: 'failed', steps }
    }
  }
  return { name: scenario.name, status: 'passed', steps }
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
