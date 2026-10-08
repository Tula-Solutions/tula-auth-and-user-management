/**
 * The worker check: a webhook delivered by the worker running as a service of its own.
 *
 * Run against the packaged stack started with `WEBHOOK_WORKER=separate` and **no worker yet**
 * (the `self-host-worker` CI job; docs/self-host.md, "The webhook worker as its own service"):
 *
 *   WORKER_CHECK_SECRET_KEY=tula_sk_… WORKER_CHECK_ADMIN_TOKEN=… \
 *     bun run scripts/worker-check/check.ts -- docker compose \
 *       -f docker-compose.yml -f docker/worker-check/compose.yml --profile app --profile worker
 *
 * What follows `--` is the Compose command of the stack; the check adds `up -d worker receiver`
 * and `logs` to it. It shows, in this order:
 *
 * 1. With no worker, **an API instance makes no delivery**: an event waits, the delivery log
 *    stays empty, a test event is refused (501, `worker_separate`) by every instance, and the
 *    diagnostics say so (`webhook_worker` fails once the event has waited a minute).
 * 2. Then the worker and the receiver are started, and **the worker delivers it**: the
 *    delivery log says `delivered` with the receiver's status code after one request; the
 *    receiver, which only the worker can reach (`receiver.ts`), was sent exactly that event,
 *    signed with the endpoint's secret; the worker's log has the round that delivered it and
 *    no API instance's log has one.
 *
 * It prints what it saw and never a key, a token or a signing secret. Exit code 0 only when
 * every step held.
 */
import {
  deliveriesLogged,
  OWED_WAIT_MS,
  receivedRequests,
  STUCK_WITHIN_MS,
  signedEvent,
} from './lib'

/** The receiver's address, as the worker sees it: its own loopback (`receiver.ts`). */
const RECEIVER_URL = 'http://127.0.0.1:8787/hook'
/** The status the receiver answers with. */
const RECEIVER_STATUS = 204
/** How long the worker has, once started, to make the delivery (a round every 5 s). */
const DELIVERED_WITHIN_MS = 90_000
/** How long the worker has to settle every environment's waiting events after that. */
const SETTLED_WITHIN_MS = 30_000
const POLL_MS = 3_000
const REQUEST_TIMEOUT_MS = 15_000
/** `up` pulls nothing (the image is built), but starts two containers and waits for neither. */
const COMPOSE_TIMEOUT_MS = 180_000

interface Delivery {
  id: string
  eventId: string | null
  eventType: string
  test: boolean
  state: string
  attemptCount: number
  statusCode: number | null
}

class CheckFailed extends Error {}

function fail(message: string): never {
  throw new CheckFailed(message)
}

function say(message: string): void {
  console.log(`worker check: ${message}`)
}

function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') {
    fail(`${name} is not set`)
  }
  return value
}

// `bun run <file> -- a b` hands the script `a b` and keeps the `--` to itself.
const separator = process.argv.indexOf('--')
const compose = process.argv.slice(separator === -1 ? 2 : separator + 1)
if (compose.length === 0) {
  console.error('usage: bun run scripts/worker-check/check.ts -- <the stack’s compose command>')
  process.exit(2)
}

const apiUrls = (process.env.WORKER_CHECK_API_URLS ?? 'http://localhost:3003,http://localhost:3004')
  .split(',')
  .map((url) => url.trim().replace(/\/$/, ''))
  .filter((url) => url !== '')
const [firstApi = ''] = apiUrls

async function call(
  base: string,
  path: string,
  init: { method?: string; token: string; body?: unknown }
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${base}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${init.token}`,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    redirect: 'error',
  })
  const text = await response.text()
  let body: unknown = null
  try {
    body = text === '' ? null : JSON.parse(text)
  } catch {
    body = null
  }
  return { status: response.status, body }
}

function field(value: unknown, ...path: string[]): unknown {
  let current = value
  for (const key of path) {
    if (typeof current !== 'object' || current === null) {
      return undefined
    }
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

/** Run the stack's Compose command with further arguments; its output, or a failed check. */
function docker(...args: string[]): string {
  const result = Bun.spawnSync([...compose, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: COMPOSE_TIMEOUT_MS,
  })
  if (result.exitedDueToTimeout) {
    fail(`\`${args.join(' ')}\` did not finish within ${COMPOSE_TIMEOUT_MS} ms`)
  }
  if (result.exitCode !== 0) {
    fail(`\`${args.join(' ')}\` exited with ${result.exitCode}: ${result.stderr.toString().trim()}`)
  }
  return result.stdout.toString()
}

const logs = (service: string) => docker('logs', '--no-color', '--no-log-prefix', service)

async function deliveries(secretKey: string, endpoint: string): Promise<Delivery[]> {
  const answer = await call(firstApi, `/v1/admin/webhook-endpoints/${endpoint}/deliveries`, {
    token: secretKey,
  })
  const data = field(answer.body, 'data')
  if (answer.status !== 200 || !Array.isArray(data)) {
    fail(`the delivery log answered ${answer.status}`)
  }
  return data as Delivery[]
}

async function workerCheck(adminToken: string): Promise<{ status: string; summary: string }> {
  const answer = await call(firstApi, '/v1/instance/diagnostics', { token: adminToken })
  const checks = field(answer.body, 'checks')
  if (answer.status !== 200 || !Array.isArray(checks)) {
    fail(`the diagnostics answered ${answer.status}`)
  }
  const found = checks.find((check) => field(check, 'id') === 'webhook_worker')
  if (found === undefined) {
    fail('the diagnostics have no `webhook_worker` check')
  }
  return { status: String(field(found, 'status')), summary: String(field(found, 'summary')) }
}

async function main(): Promise<void> {
  const secretKey = required('WORKER_CHECK_SECRET_KEY')
  const adminToken = required('WORKER_CHECK_ADMIN_TOKEN')
  if (apiUrls.length === 0) {
    fail('WORKER_CHECK_API_URLS names no API instance')
  }

  // The stack as the job started it: API instances, and no worker.
  const running = docker('ps', '--services', '--status', 'running').split('\n')
  if (running.includes('worker') || running.includes('receiver')) {
    fail('the worker is already running: start the stack without it, the check starts it')
  }

  const registered = await call(firstApi, '/v1/admin/webhook-endpoints', {
    method: 'POST',
    token: secretKey,
    body: { url: RECEIVER_URL, eventTypes: ['user.created'] },
  })
  const endpoint = field(registered.body, 'id')
  const secret = field(registered.body, 'secret')
  if (registered.status !== 201 || typeof endpoint !== 'string' || typeof secret !== 'string') {
    fail(
      `registering ${RECEIVER_URL} answered ${registered.status} ${String(field(registered.body, 'code') ?? '')}`
    )
  }
  say(`registered an endpoint at ${RECEIVER_URL} (the worker’s own loopback)`)

  const created = await call(firstApi, '/v1/admin/users', {
    method: 'POST',
    token: secretKey,
    body: { email: `worker-check-${Date.now()}@example.com` },
  })
  const user = field(created.body, 'id')
  if (created.status !== 201 || typeof user !== 'string') {
    fail(`creating a user answered ${created.status}`)
  }
  const owedSince = Date.now()
  say('created a user: one `user.created` event is owed to the endpoint')

  // 1. No worker: an API instance makes no delivery, and says so.
  for (const base of apiUrls) {
    const test = await call(base, `/v1/admin/webhook-endpoints/${endpoint}/test`, {
      method: 'POST',
      token: secretKey,
      body: { eventType: 'user.created' },
    })
    const code = field(test.body, 'code')
    const reason = field(test.body, 'params', 'reason')
    if (test.status !== 501 || code !== 'not_implemented' || reason !== 'worker_separate') {
      fail(
        `${base} answered a test event with ${test.status} ${String(code)} ${String(reason)}, not 501 not_implemented worker_separate`
      )
    }
  }
  say(`a test event is refused by ${apiUrls.length} API instance(s): 501, worker_separate`)

  // Until the diagnostics fail AND the owed event itself has waited its minute: an older
  // event (the key's creation) can turn the check before this one has waited at all.
  const stuckBy = owedSince + STUCK_WITHIN_MS
  let stuck = await workerCheck(adminToken)
  while (stuck.status !== 'fail' || Date.now() - owedSince < OWED_WAIT_MS) {
    if (Date.now() > stuckBy) {
      fail(`with no worker, \`webhook_worker\` stayed ${stuck.status}: ${stuck.summary}`)
    }
    if ((await deliveries(secretKey, endpoint)).length > 0) {
      fail('a delivery exists although no worker is running')
    }
    await Bun.sleep(POLL_MS)
    stuck = await workerCheck(adminToken)
  }
  say(`diagnostics, no worker: webhook_worker is fail (“${stuck.summary}”)`)

  const before = await deliveries(secretKey, endpoint)
  if (before.length !== 0) {
    fail(`${before.length} delivery row(s) exist although no worker is running`)
  }
  for (const service of ['api', 'api-2']) {
    const log = logs(service)
    if (deliveriesLogged(log) !== 0 || log.includes('webhook delivery round finished')) {
      fail(`${service} ran a delivery round`)
    }
    if (!log.includes('this API instance makes no webhook delivery')) {
      fail(`${service} did not say at start-up that it makes no webhook delivery`)
    }
  }
  say('after more than a minute: no delivery row, and no API instance ran a delivery round')

  // 2. The worker, as its own service, and the receiver only it can reach.
  docker('up', '-d', 'worker', 'receiver')
  say('started the worker and the receiver')

  const deliveredBy = Date.now() + DELIVERED_WITHIN_MS
  let rows = await deliveries(secretKey, endpoint)
  while (rows.length === 0 || rows.some((row) => row.state === 'pending')) {
    if (Date.now() > deliveredBy) {
      fail(`the worker did not deliver within ${DELIVERED_WITHIN_MS} ms: ${JSON.stringify(rows)}`)
    }
    await Bun.sleep(POLL_MS)
    rows = await deliveries(secretKey, endpoint)
  }
  const [delivery, ...others] = rows
  if (delivery === undefined || others.length > 0) {
    fail(`expected one delivery, found ${rows.length}`)
  }
  if (
    delivery.state !== 'delivered' ||
    delivery.statusCode !== RECEIVER_STATUS ||
    delivery.attemptCount !== 1 ||
    delivery.test ||
    delivery.eventType !== 'user.created' ||
    delivery.eventId === null
  ) {
    fail(`the delivery is not one delivered user.created: ${JSON.stringify(delivery)}`)
  }
  say(
    `delivery log: delivered, status ${delivery.statusCode}, after ${delivery.attemptCount} request`
  )

  // The requests that are this endpoint's: the ones its secret verifies. On a stack the check
  // has run against before, an endpoint of the earlier run is owed the same event at the same
  // address, signed with a secret of its own; those are not counted here.
  const received = receivedRequests(logs('receiver'))
  const ours: { request: (typeof received)[number]; id: string; type: string; test: boolean }[] = []
  for (const request of received) {
    const event = await signedEvent(request, secret)
    if (event !== null) {
      ours.push({ request, ...event })
    }
  }
  const [mine, ...more] = ours
  if (mine === undefined || more.length > 0) {
    fail(
      `of the ${received.length} request(s) the receiver was sent, ${ours.length} verify with the endpoint’s secret, not one`
    )
  }
  if (mine.id !== delivery.eventId || mine.type !== 'user.created' || mine.test) {
    fail('the request the receiver was sent is not the event of the delivery')
  }
  const { request } = mine
  if (request.method !== 'POST' || request.path !== '/hook' || request.peer !== '127.0.0.1') {
    fail(`the receiver was sent ${request.method} ${request.path} from ${String(request.peer)}`)
  }
  say('receiver: one POST from 127.0.0.1, the delivery’s event, signed with the endpoint’s secret')

  // At least one: the worker's log also counts what it delivered to an earlier run's endpoint.
  const workerDelivered = deliveriesLogged(logs('worker'))
  if (workerDelivered < 1) {
    fail('the worker’s log reports no delivery')
  }
  for (const service of ['api', 'api-2']) {
    if (deliveriesLogged(logs(service)) !== 0) {
      fail(`${service} reports a delivery of its own`)
    }
  }
  say(`logs: the worker’s rounds delivered ${workerDelivered}; neither API instance ran one`)

  // The round that delivered also settles what the other environments had waiting, one
  // environment after another: give it a few rounds before calling the check wrong.
  const settledBy = Date.now() + SETTLED_WITHIN_MS
  let settled = await workerCheck(adminToken)
  while (settled.status !== 'ok') {
    if (Date.now() > settledBy) {
      fail(`with the worker running, \`webhook_worker\` is ${settled.status}: ${settled.summary}`)
    }
    await Bun.sleep(POLL_MS)
    settled = await workerCheck(adminToken)
  }
  say('diagnostics, worker running: webhook_worker is ok')
  say('passed')
}

try {
  await main()
} catch (error) {
  // A failed check is said plainly; anything else (the API away, a timeout) with its own text.
  console.error(`worker check failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
