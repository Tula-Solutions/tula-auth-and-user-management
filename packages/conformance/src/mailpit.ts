/** How long one request to Mailpit may take. */
export const MAILPIT_REQUEST_TIMEOUT_MS = 3_000

/** How long to wait for an email to reach Mailpit before giving up. */
export const MAILPIT_TIMEOUT_MS = 5_000

/**
 * How many of an address's newest messages are looked at for a code. More than one, because
 * the newest email is not always the one with the code: a security notice ("your password was
 * changed", "new sign-in") can arrive after it.
 */
export const MAILPIT_SEARCH_LIMIT = 10

/** A subject that leads with a 6-digit code, as every code email's does. */
const CODE_SUBJECT = /^(\d{6})\b/

interface MailpitSearch {
  messages?: { Subject?: string }[]
}

/**
 * Read verification codes from a Mailpit inbox (the local SMTP catcher in docker-compose).
 *
 * @param baseUrl - Mailpit's web address, e.g. `http://localhost:8025`.
 * @param options - Injectable `fetch` and `sleep`, for tests.
 * @returns A function that returns the code in the newest email to an address that has one.
 *   Tula puts the code first in the subject, so only the message list is read, never a message
 *   body; an email whose subject does not lead with a code (a notice) is passed over. It reads
 *   whatever is newest when asked: right after a resend that can still be the previous code.
 *
 * @example
 * ```ts
 * const emailCode = mailpitCodes('http://localhost:8025')
 * const code = await emailCode('maya@example.com')
 * ```
 */
export function mailpitCodes(
  baseUrl: string,
  options: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {}
): (to: string) => Promise<string> {
  const send = options.fetch ?? fetch
  const sleep = options.sleep ?? Bun.sleep
  return async (to) => {
    // The address goes inside a quoted search term; a quote or space would change the query.
    if (/["\\\s]/.test(to)) {
      throw new Error('not an address the runner can search for')
    }
    const url = `${baseUrl}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}&limit=${MAILPIT_SEARCH_LIMIT}`
    // Delivery is asynchronous: the API answers before Mailpit has indexed the message.
    for (let waited = 0; waited <= MAILPIT_TIMEOUT_MS; waited += 100) {
      const response = await send(url, {
        signal: AbortSignal.timeout(MAILPIT_REQUEST_TIMEOUT_MS),
      })
      if (!response.ok) {
        throw new Error(`Mailpit answered ${response.status}`)
      }
      const { messages } = (await response.json()) as MailpitSearch
      // Mailpit lists the newest first.
      const code = (messages ?? [])
        .map((message) => CODE_SUBJECT.exec(message.Subject ?? '')?.[1])
        .find((found) => found !== undefined)
      if (code) {
        return code
      }
      await sleep(100)
    }
    throw new Error(`no email with a code arrived for ${to}`)
  }
}
