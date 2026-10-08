import type { Deps } from '~/dependencies'
import { NotFoundError } from '~/exceptions'
import type { ReadinessResponse } from '~/modules/status/schema'
import * as Status from '~/modules/status/service'

/**
 * How long a readiness answer is reused. `/v1/ready` queries the database and the worker's
 * port has no rate limiter in front of it (a worker shares no limiter state with the API), so
 * the query runs at most once in this long however often the route is asked. Health checkers
 * ask every few seconds; one second of staleness costs them nothing.
 */
export const WORKER_READY_REUSE_MS = 1_000

/** What a worker process serves: a `fetch` handler for `Bun.serve`. */
export interface WorkerApp {
  /**
   * Answer one request.
   *
   * @param request - The request.
   * @returns `/v1/status`, `/v1/ready`, or the contract's 404.
   */
  fetch(request: Request): Promise<Response>
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}

/**
 * Build what the webhook worker listens for: liveness (`GET /v1/status`) and readiness
 * (`GET /v1/ready`), with the API's own answers, and nothing else.
 *
 * The worker takes no sign-in traffic, and that is structural: this module imports no router
 * and is handed a clock and the readiness probes only, so no route of the API, no key and no
 * session can be reached through its port. Every other path, and every other method on these
 * two, is the contract's 404. The two paths are the API's so that the image's `HEALTHCHECK`
 * and an orchestrator's probes work unchanged for a container started as a worker.
 *
 * @param deps - The clock and the worker's probes (the database: `createContainer` gives a
 *   worker no other).
 * @returns The handler.
 *
 * @example
 * ```ts
 * Bun.serve({ port: env.PORT, fetch: createWorkerApp(container.deps).fetch })
 * ```
 */
export function createWorkerApp(deps: Pick<Deps, 'clock' | 'probes'>): WorkerApp {
  let last: { answer: Promise<ReadinessResponse>; at: number } | null = null
  const ready = (): Promise<ReadinessResponse> => {
    const now = deps.clock.now().getTime()
    // The answer in flight, or the one just given, serves everyone who asks meanwhile.
    if (last === null || now - last.at >= WORKER_READY_REUSE_MS) {
      last = { answer: Status.ready(deps), at: now }
    }
    return last.answer
  }
  return {
    async fetch(request) {
      const { pathname } = new URL(request.url)
      if (request.method === 'GET' || request.method === 'HEAD') {
        if (pathname === '/v1/status') {
          return json(Status.status(), 200)
        }
        if (pathname === '/v1/ready') {
          const result = await ready()
          return json(result, result.status === 'ready' ? 200 : 503)
        }
      }
      return json(new NotFoundError().toJSON(), 404)
    },
  }
}
