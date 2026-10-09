import {
  durationToMs,
  EMAIL_LINK_ATTEMPT_PARAM,
  EMAIL_LINK_TOKEN_PARAM,
  FLOW_ATTEMPT_HEADER,
  phoneNumberCountries,
} from '@tula/contract'
import { jwtClaims, match, pick } from './match'
import { VirtualAuthenticator } from './passkey'
import type { Scenario, ScenarioRequest, Step } from './scenario'
import { expandJson, fill } from './template'
import { base32Decode, totp, wrongTotp } from './totp'
import { checkDelivery, checkQuestion, type ReceivedDelivery, WebhookReceiver } from './webhook'

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
   * The newest email to an address whose subject contains a marker, for `emailMessage`
   * steps. Optional: a target that cannot read email bodies fails those steps and runs
   * everything else.
   *
   * @param to - The recipient.
   * @param subjectContains - What the subject must contain.
   * @returns The message's subject and its plain-text part.
   * @throws Error when no such email arrived.
   */
  emailMessage?: (to: string, subjectContains: string) => Promise<{ subject: string; text: string }>
  /**
   * The 6-digit code in the newest text message to a phone number, read from the server's
   * development SMS inbox. Left out, scenarios marked `needsSmsInbox` are skipped: only a
   * server in the `local` tier started with `SMS_PROVIDER=dev` has an inbox.
   *
   * @param to - The number in E.164 form.
   * @returns The code.
   * @throws Error when no such message arrived.
   */
  smsCode?: (to: string) => Promise<string>
  /**
   * The whole text of the newest text message to a phone number that carries a code, for an
   * `smsCode` step that says what the message must hold (`textContains`, `textExcludes`).
   * Left out, such a step fails:
   * a target that can read a code can read the message it is in.
   *
   * @param to - The number in E.164 form.
   * @returns The message's text.
   * @throws Error when no such message arrived.
   */
  smsText?: (to: string) => Promise<string>
  /**
   * Let time pass on the server: a real sleep for a live one, a clock advance in-process.
   *
   * @param ms - How long.
   */
  wait: (ms: number) => Promise<void>
  /**
   * `true` when {@link Target.wait} moves the clock the server reads instead of sleeping (an
   * in-process target). Left out, scenarios marked `needsTestClock` are skipped: they wait
   * for longer than a run can sleep (a day, for a password to expire).
   */
  testClock?: boolean
  /**
   * The time on the server, for `totp` steps: the same clock {@link Target.wait} moves. Left out
   * for a live server, where it is the wall clock; an in-process target gives its test clock.
   *
   * @returns Milliseconds since the Unix epoch.
   */
  now?: () => number
  /**
   * How long to wait after a step changed the environment's settings, in milliseconds. Set it
   * when the requests are spread over several instances behind one address: an instance may
   * serve the settings it had cached for a few seconds after another instance changed them
   * (ADR 0018), and a scenario's next step may land on that instance. Left out, nothing waits:
   * one instance sees its own write at once.
   */
  settleMs?: number
  /**
   * How the server under test reaches a listener the runner starts, for `webhook` steps.
   * Left out, scenarios marked `needsWebhookReceiver` are skipped: a server in a container, or
   * one outside the `local` tier, cannot call the runner's loopback address, and the server's
   * outbound guard is never loosened to make it.
   */
  webhooks?: WebhookTarget
}

/** Where a scenario's webhook receivers listen, and how their deliveries are waited for. */
export interface WebhookTarget {
  /** The address the listener binds, e.g. `127.0.0.1`. */
  hostname: string
  /**
   * The URL the server is given for a listener on `port`. Defaults to
   * `http://<hostname>:<port>/webhooks/tula`.
   *
   * @param port - The port the listener got.
   * @returns The URL to register as the endpoint's address.
   */
  url?: (port: number) => string
  /**
   * Run one round of the server's delivery worker now. An in-process target gives it, since
   * no timer runs there; a live target leaves it out, and the runner waits for the server's
   * own worker instead.
   */
  deliver?: () => Promise<void>
  /** How long to wait for a delivery from a live server, in milliseconds. Defaults to 30,000. */
  timeoutMs?: number
}

/** How long a `webhook` step waits for a live server's worker unless the target says. */
export const WEBHOOK_WAIT_MS = 30_000

/** How often a waiting `webhook` step looks at what has arrived. */
const WEBHOOK_POLL_MS = 100

/** Whether a request replaces the environment's settings, which instances cache (ADR 0018). */
function changesSettings(request: ScenarioRequest): boolean {
  return request.method !== 'GET' && request.path.split('?')[0] === '/v1/admin/settings'
}

/** Why a scenario marked `needsWebhookReceiver` is skipped by a target that offers none. */
export const WEBHOOK_RECEIVER_SKIP_REASON = 'needs a webhook receiver the server can reach'

/** Why a scenario marked `needsTestClock` is skipped by a target whose `wait` is a real sleep. */
export const TEST_CLOCK_SKIP_REASON = 'needs a clock the runner can move'

/** How long an `smsCode` step with `not` waits for a newer message, in milliseconds. */
export const SMS_NEW_CODE_TIMEOUT_MS = 5_000

/** How often such a step looks again. */
const SMS_NEW_CODE_POLL_MS = 50

/** Why a scenario marked `needsSmsInbox` is skipped by a target that offers none. */
export const SMS_INBOX_SKIP_REASON = 'needs a development SMS inbox the runner can read'

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

/**
 * A United States number nobody has: `555-0100` to `555-0199` is kept for fiction in every
 * area code. The area code is random (first digit 2 to 9, never an `N11` service code), so
 * runs rarely share a number and its per-number limits.
 *
 * `+1` is shared by some twenty-five countries, and an area code such as 242 (the Bahamas)
 * is another country's own calling prefix: a scenario that allows text messages to the
 * United States alone would be refused for such a number. A draw that is not a number of the
 * United States moves on to the next area code.
 *
 * @param values - Three random numbers: the area code's first digit, its other two, the
 *   number's last two.
 * @returns The number in E.164 form.
 */
export function fictionalPhoneNumber(values: readonly [number, number, number]): string {
  const [a, b, c] = values
  const last = String(c % 100).padStart(2, '0')
  // 200 to 999, as an offset from 200.
  let offset = (a % 8) * 100 + (b % 100)
  for (let tries = 0; tries < 800; tries += 1) {
    const area = String(200 + offset)
    const number = `+1${area}55501${last}`
    if (!area.endsWith('11') && phoneNumberCountries(number).includes('US')) {
      return number
    }
    offset = (offset + 1) % 800
  }
  throw new Error('no area code of the United States: the calling-prefix table is wrong')
}

/**
 * A French mobile number nobody has: `06 39 98 00 00` to `06 39 98 99 99` is kept for
 * fiction. A second country lets a scenario read, from the operator's counts by destination,
 * that nothing was sent to it: no other scenario sends to France.
 *
 * @param value - A random number: the number's last four digits.
 * @returns The number in E.164 form.
 */
export function fictionalFrenchPhoneNumber(value: number): string {
  return `+3363998${String(value % 10_000).padStart(4, '0')}`
}

/** Three random numbers for {@link fictionalPhoneNumber}. */
function randomValues(): [number, number, number] {
  const [a = 0, b = 0, c = 0] = crypto.getRandomValues(new Uint32Array(3))
  return [a, b, c]
}

function initialVariables(scenario: Scenario, origin: string): Record<string, string> {
  const variables: Record<string, string> = { origin }
  for (const [name, value] of Object.entries(scenario.variables ?? {})) {
    if (typeof value === 'string') {
      variables[name] = value
      continue
    }
    if (value.generate === 'phone') {
      variables[name] = fictionalPhoneNumber(randomValues())
      continue
    }
    if (value.generate === 'phone_fr') {
      variables[name] = fictionalFrenchPhoneNumber(randomValues()[0])
      continue
    }
    if (value.generate === 'uuid') {
      variables[name] = crypto.randomUUID()
      continue
    }
    const random = crypto.randomUUID().replaceAll('-', '')
    if (value.generate === 'snowflake') {
      // Sixty random bits, plus one so that it is never zero: at most nineteen digits.
      variables[name] = String(BigInt(`0x${random.slice(0, 15)}`) + 1n)
      continue
    }
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
  if ('smsCode' in step) {
    if (!target.smsCode) {
      throw new Error('this target cannot read text messages')
    }
    const to = fill(step.smsCode.to, variables)
    const earlier = step.smsCode.not === undefined ? undefined : fill(step.smsCode.not, variables)
    let code = await target.smsCode(to)
    for (let waited = 0; code === earlier; waited += SMS_NEW_CODE_POLL_MS) {
      if (waited >= SMS_NEW_CODE_TIMEOUT_MS) {
        throw new Error('no newer text message with a code arrived for that number')
      }
      await Bun.sleep(SMS_NEW_CODE_POLL_MS)
      code = await target.smsCode(to)
    }
    variables[step.smsCode.capture] = code
    if (step.smsCode.captureWrong) {
      variables[step.smsCode.captureWrong] = wrongCode(code)
    }
    const { textContains, textExcludes } = step.smsCode
    if (textContains !== undefined || textExcludes !== undefined) {
      if (!target.smsText) {
        throw new StepFailure(['this target cannot read the text of text messages'])
      }
      const text = await target.smsText(to)
      // Nothing of the message goes into a problem: it holds a code.
      const problems = [
        ...(textContains ?? []).flatMap((part, index) =>
          text.includes(fill(part, variables))
            ? []
            : [`the text does not contain textContains[${index}]`]
        ),
        ...(textExcludes ?? []).flatMap((part, index) =>
          text.includes(fill(part, variables)) ? [`the text contains textExcludes[${index}]`] : []
        ),
      ]
      if (problems.length > 0) {
        throw new StepFailure(problems)
      }
    }
    return
  }
  if ('emailLink' in step) {
    readEmailLink(await linkFor(target, fill(step.emailLink.to, variables)), step, variables)
    return
  }
  if ('emailMessage' in step) {
    await readEmailMessage(target, step, variables)
    return
  }
  if ('oauth' in step) {
    await runOAuth(target, step, variables)
    return
  }
  if ('passkey' in step) {
    await runPasskey(step, variables)
    return
  }
  if ('hook' in step) {
    await runHook(target, step, variables)
    return
  }
  if ('webhook' in step) {
    await runWebhook(target, step, variables)
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
    for (const [name, value] of Object.entries(expected.headers ?? {})) {
      const header = name.toLowerCase()
      problems.push(
        ...match(value, response.headers.get(header) ?? undefined, `header(${header})`).map(
          (mismatch) => mismatch.message
        )
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
    if (target.settleMs && response.ok && changesSettings(request)) {
      await target.wait(target.settleMs)
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
    if (step.captureCookie) {
      const { match: part, pair, value } = step.captureCookie
      const found = response.headers
        .getSetCookie()
        .map((cookie) => cookie.split(';', 1)[0] ?? '')
        .find((cookie) => {
          const at = cookie.indexOf('=')
          return at > 0 && cookie.slice(0, at).includes(part) && cookie.length > at + 1
        })
      if (found === undefined) {
        throw new StepFailure([`cannot capture a cookie: none set whose name contains ${part}`])
      }
      if (pair) {
        variables[pair] = found
      }
      if (value) {
        variables[value] = found.slice(found.indexOf('=') + 1)
      }
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

// The software authenticators of each scenario run, by name. Keyed by the run's variables
// object, which lives exactly as long as the run.
const AUTHENTICATORS = new WeakMap<object, Map<string, VirtualAuthenticator>>()

/** Run one WebAuthn ceremony on a named software authenticator and store its response. */
async function runPasskey(
  step: Extract<Step, { passkey: unknown }>,
  variables: Record<string, string>
): Promise<void> {
  const { passkey } = step
  const named = AUTHENTICATORS.get(variables) ?? new Map<string, VirtualAuthenticator>()
  AUTHENTICATORS.set(variables, named)
  const authenticator = named.get(passkey.authenticator) ?? new VirtualAuthenticator()
  named.set(passkey.authenticator, authenticator)
  const input = {
    origin: fill(passkey.origin, variables),
    userVerified: passkey.userVerified,
    counter: passkey.counter,
    synced: passkey.synced,
  }
  let options: unknown
  try {
    options = JSON.parse(fill(passkey.create ?? passkey.get ?? '', variables))
  } catch {
    // The text is a captured response value: never quote it.
    throw new StepFailure(['the passkey options are not valid JSON'])
  }
  try {
    const response =
      passkey.create === undefined
        ? await authenticator.get(options, input)
        : await authenticator.create(options, input)
    variables[passkey.capture] = JSON.stringify(response)
  } catch (error) {
    throw new StepFailure([error instanceof Error ? error.message : 'the authenticator failed'])
  }
}

// The webhook receivers of each scenario run, by name. Keyed like the authenticators, and
// stopped when the run ends.
const RECEIVERS = new WeakMap<object, Map<string, WebhookReceiver>>()

/** Stop every listener a scenario run started. */
function stopReceivers(variables: object): void {
  for (const receiver of RECEIVERS.get(variables)?.values() ?? []) {
    receiver.stop()
  }
  RECEIVERS.delete(variables)
}

/**
 * Script a named receiver as a hook's endpoint and store its URL, or check the next question
 * that reached it (or that none did). The receiver is the `webhook` step's.
 */
async function runHook(
  target: Target,
  step: Extract<Step, { hook: unknown }>,
  variables: Record<string, string>
): Promise<void> {
  const { webhooks } = target
  if (!webhooks) {
    throw new StepFailure(['this target has no webhook receiver the server can reach'])
  }
  const named = RECEIVERS.get(variables) ?? new Map<string, WebhookReceiver>()
  RECEIVERS.set(variables, named)
  const { hook } = step
  if (hook.expect === undefined) {
    const receiver = named.get(hook.receiver) ?? new WebhookReceiver(webhooks.hostname)
    named.set(hook.receiver, receiver)
    if (hook.answer !== undefined) {
      receiver.answerHook(hook.answer)
    }
    if (hook.captureUrl !== undefined) {
      variables[hook.captureUrl] = webhooks.url
        ? webhooks.url(receiver.port)
        : `http://${webhooks.hostname}:${receiver.port}/webhooks/tula`
    }
    return
  }
  const receiver = named.get(hook.receiver)
  if (!receiver) {
    throw new StepFailure([`the receiver ${hook.receiver} was not started by an earlier step`])
  }
  // A hook is asked inside the request that caused it: what was asked has arrived by now.
  const question = receiver.take()
  if ('nothing' in hook.expect) {
    if (question) {
      throw new StepFailure(['the hook was asked, and should not have been'])
    }
    return
  }
  if (!question) {
    throw new StepFailure(['no question arrived at the receiver: the hook was not asked'])
  }
  const expected = fill(hook.expect, variables)
  const now = target.now ? target.now() : Date.now()
  const { problems } = await checkQuestion(question, expected.secret, now, expected.body)
  if (problems.length > 0) {
    throw new StepFailure(problems)
  }
}

/** Start a named receiver and store its URL, or check the next delivery that reached it. */
async function runWebhook(
  target: Target,
  step: Extract<Step, { webhook: unknown }>,
  variables: Record<string, string>
): Promise<void> {
  const { webhooks } = target
  if (!webhooks) {
    throw new StepFailure(['this target has no webhook receiver the server can reach'])
  }
  const named = RECEIVERS.get(variables) ?? new Map<string, WebhookReceiver>()
  RECEIVERS.set(variables, named)
  const { webhook } = step
  if (webhook.captureUrl !== undefined) {
    const receiver = named.get(webhook.receiver) ?? new WebhookReceiver(webhooks.hostname)
    named.set(webhook.receiver, receiver)
    receiver.answerNext(webhook.answers ?? [])
    variables[webhook.captureUrl] = webhooks.url
      ? webhooks.url(receiver.port)
      : `http://${webhooks.hostname}:${receiver.port}/webhooks/tula`
    return
  }
  const receiver = named.get(webhook.receiver)
  // The schema guarantees `expect` where there is no `captureUrl`.
  const expected = fill(webhook.expect, variables)
  if (!receiver || !expected) {
    throw new StepFailure([`the receiver ${webhook.receiver} was not started by an earlier step`])
  }
  let delivery: ReceivedDelivery | undefined
  if (webhooks.deliver) {
    // In process nothing runs on a timer: one round, and what it sent has arrived.
    await webhooks.deliver()
    delivery = receiver.take(expected.type)
  } else {
    const deadline = Date.now() + (webhooks.timeoutMs ?? WEBHOOK_WAIT_MS)
    for (;;) {
      delivery = receiver.take(expected.type)
      if (delivery || Date.now() >= deadline) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, WEBHOOK_POLL_MS))
    }
  }
  if (!delivery) {
    throw new StepFailure([
      expected.type === undefined
        ? 'no delivery arrived at the receiver'
        : `no delivery of ${expected.type} arrived at the receiver`,
    ])
  }
  const now = target.now ? target.now() : Date.now()
  const { problems, id } = await checkDelivery(delivery, expected.secret, now, expected.body, {
    alsoSecrets: expected.alsoSecrets,
    notSecrets: expected.notSecrets,
    signatures: expected.signatures,
  })
  if (problems.length > 0) {
    throw new StepFailure(problems)
  }
  if (expected.captureId && id !== undefined) {
    variables[expected.captureId] = id
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
    if (oauth.tenantId !== undefined) {
      form.set('tenant_id', oauth.tenantId)
    }
    if (oauth.objectId !== undefined) {
      form.set('object_id', oauth.objectId)
    }
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

/** A run of exactly six digits: a code as an email's text carries it. */
const SIX_DIGITS = /(?<![0-9])[0-9]{6}(?![0-9])/g

/**
 * Read an email and hold it to what the step says. Nothing of the message is ever put in a
 * problem: it holds a code, and may hold a link.
 */
async function readEmailMessage(
  target: Target,
  step: Extract<Step, { emailMessage: unknown }>,
  variables: Record<string, string>
): Promise<void> {
  if (!target.emailMessage) {
    throw new StepFailure(['this target cannot read the text of emails'])
  }
  const { emailMessage: expected } = step
  const message = await target.emailMessage(
    fill(expected.to, variables),
    fill(expected.subjectContains, variables)
  )
  if (expected.captureCode !== undefined) {
    const codes = new Set(message.text.match(SIX_DIGITS) ?? [])
    const [code] = codes
    if (codes.size !== 1 || code === undefined) {
      throw new StepFailure(['the text does not hold exactly one six-digit code'])
    }
    variables[expected.captureCode] = code
  }
  const problems: string[] = []
  if (expected.subject !== undefined && message.subject !== fill(expected.subject, variables)) {
    problems.push('the subject is not the expected one')
  }
  ;(expected.textContains ?? []).forEach((part, index) => {
    if (!message.text.includes(fill(part, variables))) {
      problems.push(`the text does not contain textContains[${index}]`)
    }
  })
  ;(expected.textExcludes ?? []).forEach((part, index) => {
    if (message.text.includes(fill(part, variables))) {
      problems.push(`the text contains textExcludes[${index}]`)
    }
  })
  if (problems.length > 0) {
    throw new StepFailure(problems)
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
  if (scenario.needsWebhookReceiver && !target.webhooks) {
    return {
      name: scenario.name,
      status: 'skipped',
      steps: [],
      reason: WEBHOOK_RECEIVER_SKIP_REASON,
    }
  }
  if (scenario.needsSmsInbox && !target.smsCode) {
    return { name: scenario.name, status: 'skipped', steps: [], reason: SMS_INBOX_SKIP_REASON }
  }
  if (scenario.needsTestClock && !target.testClock) {
    return { name: scenario.name, status: 'skipped', steps: [], reason: TEST_CLOCK_SKIP_REASON }
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
  try {
    const passed = await run(scenario.steps)
    // Whatever happened above: a scenario that changed the server's settings puts them back.
    const cleaned = await run(scenario.cleanup ?? [])
    return { name: scenario.name, status: passed && cleaned ? 'passed' : 'failed', steps }
  } finally {
    // No listener of a scenario outlives its run, however the run ended.
    stopReceivers(variables)
  }
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
