import { createTransport } from 'nodemailer'
import type { Mailer, MailMessage } from '~/ports/mailer'

/** The part of a nodemailer transport this adapter uses (lets tests inject a fake). */
export interface SmtpTransport {
  sendMail(mail: {
    from: string
    to: string
    subject: string
    text: string
    html: string
  }): Promise<unknown>
  /** Connect, greet and authenticate without sending. Rejects when the relay is unusable. */
  verify(): Promise<unknown>
  close(): void
}

/** Options for {@link SmtpMailer}. */
export interface SmtpOptions {
  /** `smtp://` or `smtps://` URL of the relay, with credentials if it needs them. */
  url: string
  /** Sender, e.g. `Tula Auth <no-reply@example.com>`. */
  from: string
  /**
   * Refuse a relay that does not offer STARTTLS on a plain `smtp://` URL (`smtps://` is TLS
   * from the first byte). Without it nodemailer upgrades only if the relay offers it, so
   * someone on the path can strip the offer and read the credentials. On in `staging` and `prod`.
   */
  requireTls?: boolean
  /** Injected for tests; defaults to a pooled nodemailer transport for `url`. */
  transport?: SmtpTransport
}

/** How long to wait for the relay before failing the send; a request is waiting on it. */
export const SMTP_TIMEOUT_MS = 10_000

/**
 * The nodemailer options for a relay.
 *
 * @param url - The relay's `smtp://` or `smtps://` URL.
 * @param requireTls - Whether STARTTLS is mandatory on a plain `smtp://` URL.
 * @returns The options `createTransport` takes.
 */
export function transportOptions(url: string, requireTls: boolean) {
  return {
    url,
    pool: true,
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
    ...(requireTls ? { requireTLS: true } : {}),
  }
}

/** Sends mail through an SMTP relay (Mailpit locally, a real relay in staging and production). */
export class SmtpMailer implements Mailer {
  readonly #transport: SmtpTransport
  readonly #from: string

  /** @param options - Relay URL, sender and optional transport override. */
  constructor(options: SmtpOptions) {
    this.#from = options.from
    this.#transport =
      options.transport ??
      createTransport(transportOptions(options.url, options.requireTls ?? false))
  }

  /** @inheritdoc */
  async send(message: MailMessage): Promise<void> {
    await this.#transport.sendMail({ from: this.#from, ...message })
  }

  /**
   * Connect to the relay, greet it and authenticate, without sending a message: what the
   * diagnostics call "SMTP reachable".
   *
   * @throws Error when the relay cannot be reached or refuses the connection or the credentials.
   */
  async verify(): Promise<void> {
    await this.#transport.verify()
  }

  /** Close pooled connections (graceful shutdown). */
  close(): void {
    this.#transport.close()
  }
}
