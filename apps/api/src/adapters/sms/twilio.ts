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
 * Why a send is **failed**: an answer says Twilio did not take the message. Fixed words for
 * the operator's log:
 *
 * - `refused`: an answer whose status is not a 2xx, whatever its body (a 3xx included);
 * - `redirected`: a redirect the runtime refused to follow, which is never followed.
 */
export type TwilioRefusal = 'refused' | 'redirected'

/**
 * Why a send is **unconfirmed**: nothing says whether Twilio took the message. Fixed words:
 *
 * - `timeout`: no status line within the deadline;
 * - `no_answer`: the request ended without one (the network, TLS, a connection cut off).
 */
export type TwilioSilence = 'timeout' | 'no_answer'

/**
 * What could not be read of an answer that **accepted** a message (a 2xx). The message is
 * sent all the same; these are fixed words of a warning:
 *
 * - `body_unread`: the body broke off, or did not arrive within the deadline;
 * - `too_large`: the body is over {@link TWILIO_MAX_RESPONSE_BYTES};
 * - `not_json`: the body is not JSON;
 * - `no_sid`: the JSON carries no message identifier that may be written to a log.
 */
export type TwilioUnreadAnswer = 'body_unread' | 'too_large' | 'not_json' | 'no_sid'

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

/**
 * What is taken for a message's identifier, for the log only: letters and digits, no longer
 * than any identifier is. Twilio documents `SM` or `MM` and 32 hexadecimal digits; that
 * shape is not required, because nothing rests on it.
 */
const LOGGABLE_SID = /^[A-Za-z0-9]{2,64}$/

/** A run of digits long enough to be part of a number or a code. */
const DIGITS = /[0-9]{4,}/g

/** What Bun's `fetch` rejects with for a 301, 302, 303, 307 or 308 under `redirect: 'error'`. */
const REFUSED_REDIRECT = 'UnexpectedRedirect'

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

/**
 * What one request came to. Three outcomes, told apart by what is **known**:
 * `sent` (a 2xx), `failed` (an answer that refuses), `unconfirmed` (no answer either way).
 */
type Outcome =
  | { kind: 'sent'; status: number; sid: string }
  | { kind: 'sent'; status: number; unread: TwilioUnreadAnswer }
  | { kind: 'failed'; reason: TwilioRefusal; status?: number; code?: number; message?: string }
  | { kind: 'unconfirmed'; reason: TwilioSilence }

/**
 * Whether `fetch` rejected because the answer was a redirect it was told not to follow.
 * Only the error's `code` is compared with a fixed word: nothing of an error is read
 * otherwise, since its text can quote the request.
 */
function isRefusedRedirect(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === REFUSED_REDIRECT
  )
}

/** What a status line alone says, when nothing of the body was read. */
function byStatus(status: number): Outcome {
  return status >= 200 && status < 300
    ? { kind: 'sent', status, unread: 'body_unread' }
    : { kind: 'failed', reason: 'refused', status }
}

/**
 * The SMS sender that really sends (`SMS_PROVIDER=twilio`): one `POST` to Twilio's Messages
 * resource per message, and nothing else (ADR 0037, "Twilio").
 *
 * - **Sent means Twilio accepted the message: any 2xx.** The body is read for the log only
 *   (the message's identifier); a 2xx whose body is missing, cut off, too large or not what
 *   is documented is a warning ({@link TwilioUnreadAnswer}) and still a sent message.
 *   Accepted is not delivered: no delivery receipt is asked for or read.
 * - **Failed means Twilio answered and refused** ({@link TwilioRefusal}): a status that is
 *   not a 2xx, or a redirect, which is never followed. The port's `failed`.
 * - **Everything else is unconfirmed** ({@link TwilioSilence}): no status line in time, or a
 *   request that ended without one. The message may have been taken and billed, so the
 *   port's `unconfirmed`, and `Sms.sendCode` keeps it counted. The adapter does not try to
 *   tell an error from before the first byte (a refused connection, a failed lookup) from
 *   one after it: what a runtime reports for each is not a contract, and a wrong guess
 *   would un-count a message that went out.
 * - **One request, never a second**: a retry could send twice, and the limits of
 *   `Sms.sendCode` count one.
 * - **The message is the caller's, unchanged**: `To`, `Body` and the sender, and no option
 *   that alters content or routing.
 * - **Nothing of the answer leaves here.** A failure is one of the port's fixed words. The
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

  /** The identifier of an accepted message, when it is one that may be logged. */
  function loggableSid(body: unknown, message: SmsMessage): string | null {
    if (!isRecord(body) || typeof body.sid !== 'string' || !LOGGABLE_SID.test(body.sid)) {
      return null
    }
    const { sid } = body
    // Twilio writes this value, and it goes to a log line: never one this adapter was
    // configured with, and never one that carries digits of the number or of the text.
    if (configured.some((value) => value.length >= 4 && sid.includes(value))) {
      return null
    }
    const digits = sid.match(DIGITS) ?? []
    if (digits.some((run) => message.to.includes(run) || message.text.includes(run))) {
      return null
    }
    return sid
  }

  /**
   * @param seen - Where the status is put the moment it is known, so that a deadline that
   *   passes while the body is read is judged by the status and not as silence.
   */
  async function request(
    message: SmsMessage,
    signal: AbortSignal,
    seen: { status?: number }
  ): Promise<Outcome> {
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
    } catch (error) {
      if (signal.aborted) {
        return { kind: 'unconfirmed', reason: 'timeout' }
      }
      // A redirect is an answer, and not an acceptance. Any other rejection says nothing
      // about how far the request got.
      return isRefusedRedirect(error)
        ? { kind: 'failed', reason: 'redirected' }
        : { kind: 'unconfirmed', reason: 'no_answer' }
    }
    const { status } = response
    seen.status = status
    let text: string | null
    try {
      text = await boundedText(response, TWILIO_MAX_RESPONSE_BYTES)
    } catch {
      // A body cut off, by the deadline or by the connection. The status line was read.
      return byStatus(status)
    }
    const body = parsed(text)
    if (!response.ok) {
      // Of an error only its number and its text are read, and only for the log.
      const code = isRecord(body) && Number.isSafeInteger(body.code) ? (body.code as number) : null
      const said = isRecord(body) && typeof body.message === 'string' ? body.message : null
      return {
        kind: 'failed',
        reason: 'refused',
        status,
        ...(code !== null && { code }),
        ...(said !== null && {
          message: maskProviderMessage(said, [...configured, message.to, message.text]),
        }),
      }
    }
    // A 2xx: Twilio has the message. What follows only decides what the log can say.
    if (text === null) {
      return { kind: 'sent', status, unread: 'too_large' }
    }
    if (body === undefined) {
      return { kind: 'sent', status, unread: 'not_json' }
    }
    const sid = loggableSid(body, message)
    return sid === null ? { kind: 'sent', status, unread: 'no_sid' } : { kind: 'sent', status, sid }
  }

  /** {@link request}, given up on at the deadline even by a `fetch` that ignores its signal. */
  async function withinDeadline(message: SmsMessage): Promise<Outcome> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new DeadlinePassed()), timeoutMs)
    })
    const seen: { status?: number } = {}
    try {
      return await Promise.race([request(message, AbortSignal.timeout(timeoutMs), seen), deadline])
    } catch (error) {
      if (seen.status !== undefined) {
        // The deadline passed over the body. The answer had been given.
        return byStatus(seen.status)
      }
      // Nothing else is expected, and nothing of it is read: it could quote the request.
      return {
        kind: 'unconfirmed',
        reason: error instanceof DeadlinePassed ? 'timeout' : 'no_answer',
      }
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    configured: true,
    /** @inheritdoc */
    async send(message: SmsMessage): Promise<void> {
      const outcome = await withinDeadline(message)
      if (outcome.kind === 'sent') {
        if ('sid' in outcome) {
          // Twilio's identifier of the message: what an operator looks a send up by in
          // Twilio's console. It names nobody by itself.
          logger.debug('twilio accepted a text message', { messageSid: outcome.sid })
        } else {
          logger.warn('twilio accepted a text message, and its answer could not be read', {
            reason: outcome.unread,
            status: outcome.status,
          })
        }
        return
      }
      if (outcome.kind === 'unconfirmed') {
        logger.warn('twilio gave no answer for a text message', { reason: outcome.reason })
        throw new SmsSendError('unconfirmed')
      }
      logger.warn('twilio did not take a text message', {
        reason: outcome.reason,
        ...(outcome.status !== undefined && { status: outcome.status }),
        // Not under `code` or `message`: the logger censors the first by name.
        ...(outcome.code !== undefined && { twilioCode: outcome.code }),
        ...(outcome.message !== undefined && { twilioMessage: outcome.message }),
      })
      throw new SmsSendError('failed')
    },
  }
}
