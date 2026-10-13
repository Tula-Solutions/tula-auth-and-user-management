/**
 * The webhook receiver of the worker check (`check.ts`, the `self-host-worker` CI job).
 *
 * It listens on the loopback of whatever network namespace it runs in, and nowhere else. The
 * check starts it in the **worker's** namespace (`network_mode: service:worker` in
 * `docker/worker-check/compose.yml`), so `http://127.0.0.1:<port>` is this receiver for the
 * worker and for no other container: a request it receives was made by the worker. It is also
 * the one address of a neighbouring container the server's outbound guard allows in the
 * `local` tier (loopback), so nothing about the guard is loosened for the check.
 *
 * Uses nothing but Bun: the file is mounted into a container of the API image as it is.
 * Every request is answered 204 and written to standard output as one line of JSON, which the
 * check reads back with `docker compose logs`. A test fixture: it keeps what it is sent, so
 * never point a real deployment at it.
 */
const port = Number(process.env.RECEIVER_PORT ?? 8787)

function line(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

const server = Bun.serve({
  hostname: '127.0.0.1',
  port,
  async fetch(request, bunServer) {
    line({
      received: {
        method: request.method,
        path: new URL(request.url).pathname,
        peer: bunServer.requestIP(request)?.address ?? null,
        id: request.headers.get('webhook-id'),
        timestamp: request.headers.get('webhook-timestamp'),
        signature: request.headers.get('webhook-signature'),
        body: await request.text(),
      },
    })
    return new Response(null, { status: 204 })
  },
})

line({ listening: `${server.hostname}:${server.port}` })

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void server.stop(true).then(() => process.exit(0))
  })
}
