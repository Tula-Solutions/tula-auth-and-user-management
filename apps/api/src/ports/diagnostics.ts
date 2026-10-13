/** What the database says about itself. */
export interface DatabaseDiagnosis {
  /**
   * When each applied migration was generated (ms), oldest first; `null` when the history
   * cannot be read, which means the database is older than the migration that made it readable.
   */
  appliedMigrations: readonly number[] | null
  /** The database's clock. */
  now: Date
}

/**
 * What a `GET` of one of the server's own documents brought back.
 *
 * Read by the diagnostics only, to compare with what the server built itself: nothing of it
 * is stored, logged or put in an answer.
 */
export interface FetchedDocument {
  /** The HTTP status. A redirect is not followed: its status is what comes back. */
  status: number
  /** The answer's `Content-Type`, as sent; `null` when it had none. */
  contentType: string | null
  /**
   * The body as text; `null` when it was not read: the status was not 200, or the body was
   * larger than the adapter's cap.
   */
  body: string | null
}

/**
 * The probes behind `GET /v1/instance/diagnostics` (`tula doctor`): each asks one dependency
 * whether it works, changes nothing and sends nothing.
 *
 * A probe may throw anything a driver throws. Callers log the reason and answer with fixed
 * text: a driver's message can name hosts, users and paths.
 */
export interface Diagnostics {
  /**
   * Ask the database for its clock and its migration history.
   *
   * @returns The diagnosis.
   * @throws When the database cannot be reached.
   */
  database(): Promise<DatabaseDiagnosis>
  /** When each migration this build ships was generated (ms), oldest first. */
  readonly shippedMigrations: readonly number[]
  /**
   * Connect to the mail relay and greet it (and authenticate, when credentials are
   * configured). No message is sent.
   *
   * @throws When the relay cannot be reached or refuses.
   */
  smtp(): Promise<void>
  /** Ping Redis; `null` when the deployment runs without it. Throws when it does not answer. */
  readonly redis: (() => Promise<void>) | null
  /**
   * `GET` a URL without following redirects and without credentials.
   *
   * Only ever called with the deployment's own `PUBLIC_URL`: never with a URL from a request.
   *
   * @param url - The URL.
   * @param timeoutMs - How long to wait for the answer.
   * @returns The HTTP status.
   * @throws When there is no answer in time.
   */
  httpStatus(url: string, timeoutMs: number): Promise<number>
  /**
   * `GET` a URL without following redirects and without credentials, and read its body up to
   * a cap.
   *
   * Only ever called with an address under the deployment's own `PUBLIC_URL` that the server
   * built from an id of its own (an environment's association file): never with a URL from a
   * request, a setting or a stored row, and never with an operator's own domain.
   *
   * @param url - The URL.
   * @param timeoutMs - How long to wait for the answer and its body.
   * @returns The status, the content type and, for a 200 within the cap, the body.
   * @throws When there is no answer in time.
   */
  httpDocument(url: string, timeoutMs: number): Promise<FetchedDocument>
}
