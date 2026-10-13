import type { Mailer } from '~/ports/mailer'

/**
 * An email as it was asked for, before any wording is applied: who it was for and the
 * message's own fields (its `type`, and its `code` where it has one). What a sign-in test
 * reads the emailed code from (ADR 0058).
 */
export interface CapturedMail {
  /** The recipient. */
  to: string
  /** The message's kind, e.g. `email_verification`. */
  type: string
  /** The message's code, for a message that carries one. */
  code?: string
}

/**
 * A mailer that sends nothing: it keeps what it is handed, for the one call that made it.
 *
 * `Email.send` recognises one ({@link capturesMail}) and hands it the message as it was asked
 * for; nothing of it reaches the deployment's mail relay.
 */
export interface MailCapture extends Mailer {
  /** Every message handed over, oldest first. */
  readonly captured: readonly CapturedMail[]
  /**
   * Take a message instead of sending it.
   *
   * @param mail - The recipient, the kind and the code.
   */
  capture(mail: CapturedMail): void
}

/** The captures this module made: a mailer is one only by being in here. */
const captures = new WeakSet<Mailer>()

/**
 * Make a mailer that keeps mail instead of sending it, for one sign-in test (ADR 0058).
 *
 * The test hands the flow service a copy of its dependencies with this in place of the
 * deployment's mailer, so the throwaway user's code, and the security notices about that
 * user, are read in the server's own process and never leave it.
 *
 * @returns The capture.
 *
 * @example
 * ```ts
 * const mail = captureMail()
 * await Flows.signUp({ ...deps, mailer: mail }, tenant, input, context)
 * const code = mail.captured.at(-1)?.code
 * ```
 */
export function captureMail(): MailCapture {
  const captured: CapturedMail[] = []
  const capture: MailCapture = {
    captured,
    capture(mail) {
      captured.push(mail)
    },
    // A message that reaches a capture by `send` was rendered first: it is dropped, never
    // passed on, and nothing of its text is kept.
    async send() {},
  }
  captures.add(capture)
  return capture
}

/**
 * Whether a mailer is a capture {@link captureMail} made.
 *
 * @param mailer - The mailer a call was given.
 * @returns `true` for a capture: hand it the message and send nothing.
 */
export function capturesMail(mailer: Mailer): mailer is MailCapture {
  return captures.has(mailer)
}
