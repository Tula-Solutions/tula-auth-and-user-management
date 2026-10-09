import { PROVIDER_TIMEOUT_MS } from '~/adapters/oauth/id-token'
import * as logger from '~/lib/logger'
import { type SmsMessage, SmsSendError, type SmsSender } from '~/ports/sms-sender'

/**
 * Twilio's REST host. A constant on purpose: the address a message is sent to is never an
 * operator's or a request's to choose, so this is not an address the outbound guard judges
 * (`~/lib/outbound` is for those). It is the default region (US1); a Twilio account of another
 * region is not supported (ADR 0037).
 */
export const TWILIO_API_ORIGIN = 'https://api.twilio.com'

/**
 * The most of an answer that is read. A Message resource is under two kilobytes; an answer
 * beyond this is not one, and the rest is cancelled unread.
 */
export const TWILIO_MAX_RESPONSE_BYTES = 64 * 1024

/** The most of Twilio's own error text that reaches a log line, after masking. */
export const TWILIO_MAX_LOGGED_MESSAGE = 300

/**
 * Why Twilio did not take a message, for the operator's log. Fixed words:
 *
 * - `timeout`: no whole answer within the deadline;
 * - `no_answer`: the request failed before an answer (the network, TLS, or a redirect, which
 *   is refused and never followed);
 * - `refused`: an answer that is not a 2xx, whatever its body;
 * - `too_large`: a 2xx whose body is over {@link TWILIO_MAX_RESPONSE_BYTES};
 * - `not_json`: a 2xx whose body is not JSON;
 * - `no_sid`: a 2xx whose JSON carries no message `sid`.
 */
export type TwilioFailure =
  | 'timeout'
  | 'no_answer'
  | 'refused'
  | 'too_large'
  | 'not_json'
  | 'no_sid'

/** How the adapter authenticates: an API key (preferred) or the account's auth token. */
export type TwilioCredentials =
  | { kind: 'api_key'; sid: string; secret: string }
  | { kind: 'auth_token'; token: string }

/** What a message is sent from: a Messaging Service's pool, or one number. */
export type TwilioSenderId =
  | { kind: 'messaging_service'; sid: string }
  | { kind: 'number'; number: string }

/** What {@link createTwilioSmsSender} is built from. `env.ts` has judged every value's shape. */
export interface TwilioSmsOptions {
  /** The account messages are sent from (`AC…`). It is part of the request's path. */
  accountSid: string
  credentials: TwilioCredentials
  sender: TwilioSenderId
  /** The deadline of one send, in milliseconds ({@link PROVIDER_TIMEOUT_MS} unless said). */
  timeoutMs?: number
}

/** A message's identifier, as Twilio documents it: `SM` or `MM` and 32 hexadecimal digits. */
const MESSAGE_SID = /^(SM|MM)[0-9a-fA-F]{32}$/

/** Any Twilio identifier: two capitals and 32 hexadecimal digits. */
const ANY_SID = /[A-Z]{2}[0-9a-fA-F]{32}/g

/**
 * Four or more digits, with up to two separators (space, dot, hyphen, bracket) between any
 * two of them and an optional `+` in front: a number however it is written out. Linear: one
 * bounded gap between two digits, nothing nested.
 */
const DIGIT_RUN = /\+?[0-9](?:[ ().-]{0,2}[0-9]){3,}/g

/** What a log line must not carry raw: control characters, and the line and paragraph separators. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is removed
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g

/** The deadline passed before a whole answer arrived. */
class DeadlinePassed extends Error {}

/**
 * Twilio's error text, made safe for a log line.
 *
 * Twilio's messages can repeat the destination number and the account's identifier. So, in
 * this order: every value this adapter was configured with and the recipient are taken out
 * wherever they occur; every identifier of Twilio's shape is; every run of four or more
 * digits is (a number, however it is written); control characters become a space; and what
 * is left is cut to {@link TWILIO_MAX_LOGGED_MESSAGE} characters.
 *
 * @param text - Twilio's `message`.
 * @param known - Values that must not appear whatever their shape: the credentials, the
 *   sender, the recipient, the text that was sent.
 * @returns The masked text.
 */
export function maskProviderMessage(text: string, known: readonly string[]): string {
  // Only the head is looked at: nothing here runs over text of a size Twilio chose. The cap
  // and the longest known value more, so that a value beginning before the cap is whole
  // when it is looked for, and cannot leave its first characters behind.
  const longest = Math.max(0, ...known.map((value) => value.length))
  let masked = text.slice(0, TWILIO_MAX_LOGGED_MESSAGE + longest)
  for (const value of known) {
    if (value.length >= 4) {
      masked = masked.split(value).join('[redacted]')
    }
  }
  return masked
    .replace(ANY_SID, '[sid]')
    .replace(DIGIT_RUN, '[digits]')
    .replace(CONTROL, ' ')
    .slice(0, TWILIO_MAX_LOGGED_MESSAGE)
}

/**
 * Read a response body as text, up to a number of bytes.
 *
 * @returns The text, or `null` when the body is longer: the rest is cancelled, not read.
 */
async function boundedText(response: Response, maxBytes: number): Promise<string | null> {
  const reader = response.body?.getReader()
  if (!reader) {
    return ''
  }
  const decoder = new TextDecoder()
  let text = ''
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      return text + decoder.decode()
    }
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    text += decoder.decode(value, { stream: true })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** JSON, or `undefined` for text that is not. */
function parsed(text: string | null): unknown {
  if (text === null) {
    return undefined
  }
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** What one request came to: Twilio's message identifier, or why there is none. */
type Outcome =
  | { sent: true; sid: string }
  | { sent: false; failure: TwilioFailure; status?: number; code?: number; message?: string }

/**
 * The SMS sender that really sends (`SMS_PROVIDER=twilio`): one `POST` to Twilio's Messages
 * resource per message, and nothing else (ADR 0037, "Twilio").
 *
 * - **Sent means Twilio accepted the message**: a 2xx whose JSON carries a message `sid`.
 *   Anything else is a failed send, {@link TwilioFailure}. Accepted is not delivered: no
 *   delivery receipt is asked for or read.
 * - **One request, never a second**: a retry could send twice, and the limits of
 *   `Sms.sendCode` count one. A request that timed out may still have been taken by Twilio;
 *   the caller is told it failed, and the code that message holds is never stored.
 * - **The message is the caller's, unchanged**: `To`, `Body` and the sender, and no option
 *   that alters content or routing.
 * - **Nothing of the answer leaves here.** A failure is the port's fixed `failed`. The
 *   operator's log gets a fixed word, the HTTP status, Twilio's numeric error code and its
 *   message masked by {@link maskProviderMessage}: never the request's body, the recipient,
 *   the credentials or a header.
 * - **The credentials live in this closure**: not a property of the sender, not in an error,
 *   not in a log line. No redirect is followed (it would carry them wherever it points), and
 *   the certificate is checked whatever `NODE_TLS_REJECT_UNAUTHORIZED` says.
 *
 * @param options - The account, the credentials, the sender and the deadline.
 * @returns The sender.
 *
 * @example
 * ```ts
 * const sms = createTwilioSmsSender({
 *   accountSid: env.TWILIO_ACCOUNT_SID,
 *   credentials: { kind: 'api_key', sid: env.TWILIO_API_KEY_SID, secret: env.TWILIO_API_KEY_SECRET },
 *   sender: { kind: 'messaging_service', sid: env.TWILIO_MESSAGING_SERVICE_SID },
 * })
 * ```
 */
export function createTwilioSmsSender(options: TwilioSmsOptions): SmsSender {
  const timeoutMs = options.timeoutMs ?? PROVIDER_TIMEOUT_MS
  const url = `${TWILIO_API_ORIGIN}/2010-04-01/Accounts/${encodeURIComponent(options.accountSid)}/Messages.json`
  const { credentials, sender } = options
  const [user, password] =
    credentials.kind === 'api_key'
      ? [credentials.sid, credentials.secret]
      : [options.accountSid, credentials.token]
  const authorization = `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`
  const senderField: [string, string] =
    sender.kind === 'messaging_service'
      ? ['MessagingServiceSid', sender.sid]
      : ['From', sender.number]
  // What must never reach a log line, whatever Twilio's text quotes. The account's
  // identifier is not a secret, and is taken out all the same: it names the customer.
  const configured = [password, user, options.accountSid, senderField[1], authorization.slice(6)]

  async function request(message: SmsMessage, signal: AbortSignal): Promise<Outcome> {
    // `URLSearchParams` writes the form encoding: `+` as `%2B`, a space as `+`, everything
    // else as the UTF-8 bytes. The text is sent as it was written (`modules/sms/templates`).
    const form = new URLSearchParams([['To', message.to], senderField, ['Body', message.text]])
    let response: Response
    try {
      response = await globalThis.fetch(url, {
        method: 'POST',
        signal,
        // A redirect would carry the credentials to wherever it points.
        redirect: 'error',
        headers: {
          authorization,
          'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
          accept: 'application/json',
        },
        body: form.toString(),
        // Said here, so that `NODE_TLS_REJECT_UNAUTHORIZED=0`, set for some other dependency,
        // cannot send the credentials to whoever answers for the host. (Bun's `fetch`.)
        tls: { rejectUnauthorized: true },
      } as RequestInit)
    } catch {
      return { sent: false, failure: signal.aborted ? 'timeout' : 'no_answer' }
    }
    const { status } = response
    let text: string | null
    try {
      text = await boundedText(response, TWILIO_MAX_RESPONSE_BYTES)
    } catch {
      // A body cut off, by the deadline or by the connection.
      return { sent: false, failure: signal.aborted ? 'timeout' : 'no_answer', status }
    }
    const body = parsed(text)
    if (!response.ok) {
      // Of an error only its number and its text are read, and only for the log.
      const code = isRecord(body) && Number.isSafeInteger(body.code) ? (body.code as number) : null
      const said = isRecord(body) && typeof body.message === 'string' ? body.message : null
      return {
        sent: false,
        failure: 'refused',
        status,
        ...(code !== null && { code }),
        ...(said !== null && {
          message: maskProviderMessage(said, [...configured, message.to, message.text]),
        }),
      }
    }
    if (text === null) {
      return { sent: false, failure: 'too_large', status }
    }
    if (body === undefined) {
      return { sent: false, failure: 'not_json', status }
    }
    if (!isRecord(body) || typeof body.sid !== 'string' || !MESSAGE_SID.test(body.sid)) {
      return { sent: false, failure: 'no_sid', status }
    }
    return { sent: true, sid: body.sid }
  }

  /** {@link request}, given up on at the deadline even by a `fetch` that ignores its signal. */
  async function withinDeadline(message: SmsMessage): Promise<Outcome> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new DeadlinePassed()), timeoutMs)
    })
    try {
      return await Promise.race([request(message, AbortSignal.timeout(timeoutMs)), deadline])
    } catch (error) {
      if (error instanceof DeadlinePassed) {
        return { sent: false, failure: 'timeout' }
      }
      // Nothing else is expected, and nothing of it is read: it could quote the request.
      return { sent: false, failure: 'no_answer' }
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    configured: true,
    /** @inheritdoc */
    async send(message: SmsMessage): Promise<void> {
      const outcome = await withinDeadline(message)
      if (outcome.sent) {
        // Twilio's identifier of the message: what an operator looks a send up by in
        // Twilio's console. It names nobody by itself.
        logger.debug('twilio accepted a text message', { messageSid: outcome.sid })
        return
      }
      logger.warn('twilio did not take a text message', {
        reason: outcome.failure,
        ...(outcome.status !== undefined && { status: outcome.status }),
        // Not under `code` or `message`: the logger censors the first by name.
        ...(outcome.code !== undefined && { twilioCode: outcome.code }),
        ...(outcome.message !== undefined && { twilioMessage: outcome.message }),
      })
      throw new SmsSendError('failed')
    },
  }
}
