/** How long one request to a development SMS inbox may take. */
export const SMS_INBOX_REQUEST_TIMEOUT_MS = 3_000

/** How long to wait for a text message to appear in an inbox before giving up. */
export const SMS_INBOX_TIMEOUT_MS = 5_000

/** The path of the development SMS inbox on an API in the `local` tier (`SMS_PROVIDER=dev`). */
export const SMS_INBOX_PATH = '/v1/dev/sms/messages'

/** A run of exactly six digits that is not part of a longer number. */
const SIX_DIGITS = /(?<![0-9])[0-9]{6}(?![0-9])/g

/**
 * The 6-digit code a text message carries.
 *
 * A message names the code in its sentence and, where the environment has an origin, again
 * in its last line (`@host #123456`, the origin-bound format). The **last** run of six digits
 * is taken, so a digit in an app's name earlier in the text is never mistaken for the code.
 *
 * @param text - The message's text.
 * @returns The code, or `null` when the text holds none.
 *
 * @example
 * ```ts
 * smsCodeIn('Your Acme verification code is 482913.\n\n@app.example.com #482913') // '482913'
 * ```
 */
export function smsCodeIn(text: string): string | null {
  return text.match(SIX_DIGITS)?.at(-1) ?? null
}

interface InboxAnswer {
  messages?: { to?: unknown; text?: unknown; sentAt?: unknown }[]
}

/**
 * Read verification codes from the development SMS inbox of a live server.
 *
 * The inbox is the memory of one process, so a deployment of several instances has several:
 * give the origin of **every** instance (not the address of a proxy in front of them), and
 * the newest message across all of them is the one that is read. A server outside the
 * `local` tier, or one started without `SMS_PROVIDER=dev`, has no inbox (404): that is an
 * error here, never an empty answer.
 *
 * @param baseUrls - The origin of each instance, e.g. `['http://localhost:3003']`.
 * @param options - Injectable `fetch` and `sleep`, for tests.
 * @returns A function that returns the code in the newest text message to a number. It reads
 *   whatever is newest when asked.
 *
 * @example
 * ```ts
 * const smsCode = devSmsCodes(['http://localhost:3003', 'http://localhost:3004'])
 * const code = await smsCode('+12025550142')
 * ```
 */
export function devSmsCodes(
  baseUrls: readonly string[],
  options: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {}
): (to: string) => Promise<string> {
  const send = options.fetch ?? fetch
  const sleep = options.sleep ?? Bun.sleep
  return async (to) => {
    if (!/^\+[0-9]{8,15}$/.test(to)) {
      throw new Error('not a phone number the runner can look for')
    }
    for (let waited = 0; waited <= SMS_INBOX_TIMEOUT_MS; waited += 100) {
      let newest: { text: string; sentAt: number } | undefined
      for (const baseUrl of baseUrls) {
        const response = await send(`${baseUrl}${SMS_INBOX_PATH}?to=${encodeURIComponent(to)}`, {
          signal: AbortSignal.timeout(SMS_INBOX_REQUEST_TIMEOUT_MS),
        })
        if (!response.ok) {
          throw new Error(`the SMS inbox at ${baseUrl} answered ${response.status}`)
        }
        const { messages } = (await response.json()) as InboxAnswer
        for (const message of messages ?? []) {
          const sentAt =
            typeof message.sentAt === 'string' ? Date.parse(message.sentAt) : Number.NaN
          // Asked for by number, and checked again: an inbox that ignored the filter must
          // not hand this scenario another one's code.
          if (message.to !== to || typeof message.text !== 'string' || Number.isNaN(sentAt)) {
            continue
          }
          // `>=`: of two messages in one millisecond the later in the list is the newer.
          if (!newest || sentAt >= newest.sentAt) {
            newest = { text: message.text, sentAt }
          }
        }
      }
      const code = newest && smsCodeIn(newest.text)
      if (code) {
        return code
      }
      await sleep(100)
    }
    throw new Error('no text message with a code arrived for that number')
  }
}
