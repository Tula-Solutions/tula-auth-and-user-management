/** How long to wait for an email to reach Mailpit before giving up. */
export const MAILPIT_TIMEOUT_MS = 5_000

interface MailpitSearch {
  messages?: { Subject?: string }[]
}

/**
 * Read verification codes from a Mailpit inbox (the local SMTP catcher in docker-compose).
 *
 * @param baseUrl - Mailpit's web address, e.g. `http://localhost:8025`.
 * @param options - Injectable `fetch` and `sleep`, for tests.
 * @returns A function that returns the code in the newest email to an address. Tula puts the
 *   code first in the subject, so only the message list is read, never a message body.
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
    const url = `${baseUrl}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}&limit=1`
    // Delivery is asynchronous: the API answers before Mailpit has indexed the message.
    for (let waited = 0; waited <= MAILPIT_TIMEOUT_MS; waited += 100) {
      const response = await send(url)
      if (!response.ok) {
        throw new Error(`Mailpit answered ${response.status}`)
      }
      const { messages } = (await response.json()) as MailpitSearch
      const code = /^(\d{6})\b/.exec(messages?.[0]?.Subject ?? '')?.[1]
      if (code) {
        return code
      }
      await sleep(100)
    }
    throw new Error(`no email with a code arrived for ${to}`)
  }
}
