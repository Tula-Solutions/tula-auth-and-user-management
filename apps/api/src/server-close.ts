import * as Notices from '~/modules/notice/service'
import * as Sms from '~/modules/sms/service'

/** What an API process has running when it is told to stop. */
export interface ApiProcess {
  /** The background jobs (`bootJobs`). */
  jobs: { stopTimers(): void; finish(): Promise<void> }
  /** The listener (`Bun.serve`). */
  server: { stop(): Promise<void> }
  /** What owns the database pool and the other connections. */
  container: { close(): Promise<void> }
}

/**
 * End an API process, in the one order that loses nothing.
 *
 * The order is the point, and `server.ts` does nothing but call this:
 * 1. no new round of a job is started;
 * 2. the listener stops and the requests under way finish;
 * 3. what those requests started and did not wait for is let finish: security notices on
 *    their way to the relay, and **the text message of a sign-in** (ADR 0037). That message
 *    is handed to the provider after the request was answered, and what follows its answer
 *    is a write: the code's token once the provider took it, the day's count taken back once
 *    it refused. A process that left before then would leave a user holding a code that was
 *    never stored, or a day one message fuller than what was sent;
 * 4. the delivery round under way records the request it is making;
 * 5. the pool is closed, last, because every step before it may write.
 *
 * A send has the provider's deadline (`PROVIDER_TIMEOUT_MS`), which is **as long as** the
 * shutdown timeout (`SHUTDOWN_TIMEOUT_MS`), not shorter: one that runs to its deadline is
 * cut off by the shutdown timer. That loses nothing but a log line, since a send with no
 * answer is `unconfirmed` anyway (the count kept, no code stored), which is what a process
 * that was killed leaves behind.
 *
 * @param running - The jobs, the listener and the container of this process.
 */
export async function closeApi(running: ApiProcess): Promise<void> {
  running.jobs.stopTimers()
  // Stop accepting connections and let in-flight requests finish before closing the pool.
  await running.server.stop()
  // Security notices are sent after the response; let the ones under way reach the relay.
  await Notices.settled()
  // A sign-in's text message, and the write that follows the provider's answer.
  await Sms.settled()
  // A delivery that was sent and not yet recorded would be sent again by the next round:
  // the round under way finishes the one delivery it is making (at most its deadline, well
  // inside the shutdown timeout), records it, and stops, before the pool closes.
  await running.jobs.finish()
  await running.container.close()
}
