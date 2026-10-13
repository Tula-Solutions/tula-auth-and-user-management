import type { WebhookWorkerMode } from '~/env'
import type { ExclusiveJob } from '~/ports/job-lock'

/**
 * What a process of the image was started as: the API (`src/server.ts`, the image's default
 * command) or the webhook worker (`src/worker.ts`). The command decides it, never a variable:
 * `WEBHOOK_WORKER` is one value for the whole deployment.
 */
export type ProcessRole = 'api' | 'worker'

/** What one process does. Everything an entrypoint starts follows from it. */
export interface ProcessPlan {
  role: ProcessRole
  /** `api`: the whole API. `health`: `/v1/status` and `/v1/ready` and nothing else. */
  serves: 'api' | 'health'
  /** The background jobs this process starts timers for. */
  jobs: readonly ExclusiveJob[]
  /**
   * Whether this process may make a request to a webhook endpoint: the worker's rounds, a
   * test event, a delivery sent again. Becomes `config.deliversWebhooks`.
   */
  deliversWebhooks: boolean
}

/** Thrown by {@link planProcess} for a worker started where the API instances deliver. */
export class WorkerNotSeparateError extends Error {
  constructor() {
    super(
      'WEBHOOK_WORKER is `api`: the API instances make the webhook deliveries, so a worker process would not separate anything. Set WEBHOOK_WORKER=separate on every container (the API instances and this worker), or do not start a worker.'
    )
    this.name = 'WorkerNotSeparateError'
  }
}

/**
 * Decide what a process does, from the command it was started with and the deployment's
 * `WEBHOOK_WORKER` (ADR 0034, "The worker as its own service").
 *
 * The retention job stays with the API in both modes: it makes no request to anyone's
 * address, and an API instance always exists. Only webhook deliveries move.
 *
 * @param role - What the process was started as.
 * @param mode - `WEBHOOK_WORKER`.
 * @returns What it serves, which jobs it runs and whether it may call a webhook endpoint.
 * @throws WorkerNotSeparateError for a worker where `WEBHOOK_WORKER` is `api`: the API
 *   instances would deliver beside it (harmless under the job lock, and not what whoever
 *   started a worker meant), so it stops at boot and says what to set.
 */
export function planProcess(role: ProcessRole, mode: WebhookWorkerMode): ProcessPlan {
  if (role === 'worker') {
    if (mode !== 'separate') {
      throw new WorkerNotSeparateError()
    }
    return { role, serves: 'health', jobs: ['webhook_delivery'], deliversWebhooks: true }
  }
  return mode === 'separate'
    ? { role, serves: 'api', jobs: ['retention'], deliversWebhooks: false }
    : { role, serves: 'api', jobs: ['retention', 'webhook_delivery'], deliversWebhooks: true }
}
