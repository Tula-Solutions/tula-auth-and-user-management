import { TulaEventSchema } from '@tula/contract'
import {
  signWebhook,
  WEBHOOK_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  WEBHOOK_TOLERANCE_SECONDS,
  webhookSecretBytes,
} from '@tula/contract/webhook-signature'
import { match } from './match'

/** One request a receiver was sent. */
export interface ReceivedDelivery {
  method: string
  /** Header names in lower case. */
  headers: Record<string, string>
  /** The body exactly as it arrived: what the signature is over. */
  body: string
}

/**
 * The operator's backend of a scenario: an HTTP listener on a port the system picks, which
 * keeps what it is sent and answers `204`, unless it was told to answer its next deliveries
 * otherwise ({@link WebhookReceiver.answerNext}): that is how a scenario plays a backend that
 * is failing and then recovers.
 *
 * @example
 * ```ts
 * const receiver = new WebhookReceiver('127.0.0.1')
 * await registerEndpoint(`http://127.0.0.1:${receiver.port}/webhooks/tula`)
 * const delivery = receiver.take('user.created')
 * receiver.stop()
 * ```
 */
export class WebhookReceiver {
  readonly #server: ReturnType<typeof Bun.serve>
  readonly #waiting: ReceivedDelivery[]
  readonly #answers: number[]

  /** @param hostname - The address to listen on, e.g. `127.0.0.1`. */
  constructor(hostname: string) {
    this.#waiting = []
    this.#answers = []
    this.#server = Bun.serve({
      port: 0,
      hostname,
      fetch: async (request) => {
        this.#waiting.push({
          method: request.method,
          headers: Object.fromEntries(request.headers),
          body: await request.text(),
        })
        // What a receiver should do: take the event, answer, and work afterwards. A status a
        // scenario asked for is used once, in order; after those, 204 again.
        return new Response(null, { status: this.#answers.shift() ?? 204 })
      },
    })
  }

  /**
   * Answer the next deliveries with these statuses, one each, in order; then `204` again.
   *
   * @param statuses - HTTP statuses, e.g. `[500]` to fail the next delivery once.
   */
  answerNext(statuses: readonly number[]): void {
    this.#answers.push(...statuses)
  }

  /** The port the listener got. */
  get port(): number {
    return this.#server.port ?? 0
  }

  /**
   * Remove and return the oldest delivery that has arrived and not been taken.
   *
   * @param type - Only a delivery whose body is an event of this type; any, when left out.
   * @returns The delivery, or `undefined` when none (of that type) is waiting.
   */
  take(type?: string): ReceivedDelivery | undefined {
    const index = this.#waiting.findIndex(
      (delivery) => type === undefined || eventType(delivery.body) === type
    )
    return index === -1 ? undefined : this.#waiting.splice(index, 1)[0]
  }

  /** Stop listening and drop what was not taken. */
  stop(): void {
    void this.#server.stop(true)
    this.#waiting.length = 0
    this.#answers.length = 0
  }
}

/** The `type` of a body that is a JSON object, or `undefined`. */
function eventType(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body)
    const type =
      typeof parsed === 'object' && parsed !== null ? (parsed as { type?: unknown }).type : null
    return typeof type === 'string' ? type : undefined
  } catch {
    return undefined
  }
}

/** What a `webhook` step may say about the signatures beyond "one is right for `secret`". */
export interface SignatureExpectation {
  /** Secrets that must each have a signature in the header too. */
  alsoSecrets?: readonly string[]
  /** Secrets that must have none. */
  notSecrets?: readonly string[]
  /** How many entries the header holds, exactly. */
  signatures?: number
}

/** What {@link checkDelivery} found. */
export interface DeliveryCheck {
  /** Why the delivery is not what a Tula server sends; empty when it is. */
  problems: string[]
  /** The event's id (the `webhook-id` header), when the delivery had one. */
  id?: string
}

/**
 * Check one delivery as a receiver must: the Standard Webhooks headers, a signature that is
 * right for the endpoint's secret, a timestamp close to now, and a body that is an event of
 * the contract with the delivery's id.
 *
 * No problem quotes a secret, a signature or the body: the report is read in CI logs. A
 * secret of `signing` is named by its place in the step (`alsoSecrets[0]`), never by value.
 *
 * @param delivery - What arrived.
 * @param secret - The endpoint's signing secret (`whsec_…`).
 * @param now - The time on the server, in milliseconds since the Unix epoch.
 * @param expected - A subset the event must match, as a request step's `expect.body`.
 * @param signing - For a secret rotation: a secret that must sign as well, secrets that must
 *   not, and how many signatures there are.
 * @returns The problems found, and the event's id.
 *
 * @example
 * ```ts
 * const { problems } = await checkDelivery(delivery, secret, Date.now(), { type: 'user.created' })
 * ```
 */
export async function checkDelivery(
  delivery: ReceivedDelivery,
  secret: string,
  now: number,
  expected?: unknown,
  signing: SignatureExpectation = {}
): Promise<DeliveryCheck> {
  const problems: string[] = []
  if (delivery.method !== 'POST') {
    problems.push(`the delivery was a ${delivery.method}, not a POST`)
  }
  if (!(delivery.headers['content-type'] ?? '').startsWith('application/json')) {
    problems.push('the delivery’s content-type is not application/json')
  }
  const id = delivery.headers[WEBHOOK_ID_HEADER]
  const sentAt = delivery.headers[WEBHOOK_TIMESTAMP_HEADER]
  const signatures = delivery.headers[WEBHOOK_SIGNATURE_HEADER]
  for (const [name, value] of [
    [WEBHOOK_ID_HEADER, id],
    [WEBHOOK_TIMESTAMP_HEADER, sentAt],
    [WEBHOOK_SIGNATURE_HEADER, signatures],
  ] as const) {
    if (!value) {
      problems.push(`the delivery has no ${name} header`)
    }
  }
  if (!id || !sentAt || !signatures) {
    return { problems }
  }
  if (!/^[0-9]+$/.test(sentAt)) {
    problems.push(`${WEBHOOK_TIMESTAMP_HEADER} is not a whole number of seconds`)
    return { problems, id }
  }
  const timestamp = Number(sentAt)
  if (Math.abs(Math.floor(now / 1000) - timestamp) > WEBHOOK_TOLERANCE_SECONDS) {
    problems.push(`${WEBHOOK_TIMESTAMP_HEADER} is more than five minutes from the server’s clock`)
  }
  const key = webhookSecretBytes(secret)
  if (!key) {
    problems.push('the secret given to the step is not a signing secret (whsec_…)')
  } else {
    const right = await signWebhook(key, id, timestamp, delivery.body)
    if (!signatures.split(' ').includes(right)) {
      problems.push(`no entry of ${WEBHOOK_SIGNATURE_HEADER} is the signature for the secret`)
    }
  }
  const entries = signatures.split(' ')
  /** Whether the header holds the signature `listed` makes; `null` when it is no secret. */
  const signedBy = async (listed: string): Promise<boolean | null> => {
    const other = webhookSecretBytes(listed)
    return other && entries.includes(await signWebhook(other, id, timestamp, delivery.body))
  }
  for (const [name, list, wanted, problem] of [
    ['alsoSecrets', signing.alsoSecrets ?? [], true, 'no entry of'],
    ['notSecrets', signing.notSecrets ?? [], false, 'an entry of'],
  ] as const) {
    for (const [index, listed] of list.entries()) {
      const found = await signedBy(listed)
      if (found === null) {
        problems.push(`${name}[${index}] is not a signing secret (whsec_…)`)
      } else if (found !== wanted) {
        problems.push(
          `${problem} ${WEBHOOK_SIGNATURE_HEADER} is the signature for a secret that should ${
            wanted ? 'also' : 'no longer'
          } sign (${name}[${index}])`
        )
      }
    }
  }
  if (signing.signatures !== undefined && entries.length !== signing.signatures) {
    problems.push(
      `${WEBHOOK_SIGNATURE_HEADER} has ${entries.length} entries, expected ${signing.signatures}`
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(delivery.body)
  } catch {
    problems.push('the delivery’s body is not JSON')
    return { problems, id }
  }
  const event = TulaEventSchema.safeParse(parsed)
  if (!event.success) {
    // The path of an issue is a field name of the schema, never a value.
    const fields = [...new Set(event.error.issues.map((issue) => issue.path.join('.') || 'body'))]
    problems.push(`the delivery’s body is not an event of the contract (${fields.join(', ')})`)
  } else if (event.data.id !== id) {
    problems.push(`the event’s id is not the ${WEBHOOK_ID_HEADER} header`)
  }
  if (expected !== undefined) {
    problems.push(...match(expected, parsed, 'event').map((mismatch) => mismatch.message))
  }
  return { problems, id }
}
